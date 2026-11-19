// Short share links end to end in headless Chrome, against a running stagebuilder Worker (wrangler dev or a preview).
//   BASE=http://127.0.0.1:8799 [STAGE=stage.json] NODE_PATH=/tmp/pp/node_modules node tests/browser/short_link_test.js
const puppeteer = require('puppeteer-core'), fs = require('fs'), path = require('path');
const S = require('../../stage-builder/share.js');
const BASE = (process.env.BASE || 'http://127.0.0.1:8799').replace(/\/$/, '');
const EX = path.join(__dirname, '../../stage-builder/examples');
const STAGE = process.env.STAGE || path.join(EX, 'mar-merzouga-erg-chebbi.json');
const stage = JSON.parse(fs.readFileSync(STAGE, 'utf8'));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const PERMS = ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write'];

(async () => {
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });
  async function fresh() {
    const ctx = await browser.createBrowserContext();
    await ctx.overridePermissions(BASE, PERMS);
    const page = await ctx.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', d => { errors.dialogs = (errors.dialogs || []).concat(d.message().slice(0, 60)); d.accept(); });
    page.on('console', m => { if (m.type() === 'error' && !/favicon|tile|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem('rallyraid-examples-hint', '1'); } catch (e) {} });
    return { ctx, page, errors };
  }
  const clip = page => page.evaluate(() => navigator.clipboard.readText());
  const toastText = page => page.evaluate(() => (document.getElementById('rr-share-toast') || {}).textContent || '');
  const sig = st => JSON.stringify({ w: st.waypoints, r: st.route, b: st.builder && st.builder.points });

  // 1) make a short link from the builder (Share button) with the given stage
  const A = await fresh();
  await A.page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await A.page.evaluate(s => RallyRaidBuilder.importStage(s), stage);
  const src = await A.page.evaluate(() => RallyRaidBuilder.exportStage());
  await A.page.click('#b-share').catch(async () => A.page.evaluate(() => document.getElementById('b-share').click()));
  await A.page.waitForFunction(() => /link/i.test((document.getElementById('rr-share-toast') || {}).textContent || ''), { timeout: 15000 });
  const shortUrl = await clip(A.page);
  ok(new RegExp('^' + BASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/s/[A-Za-z0-9]{22}$').test(shortUrl), 'Share button copies a short link: ' + shortUrl + ' (' + shortUrl.length + ' chars)');
  ok(/Short link copied/.test(await toastText(A.page)), 'toast says short link copied');
  // Copy long link button (File pane)
  await A.page.evaluate(() => document.getElementById('f-share-long').click());
  await new Promise(r => setTimeout(r, 800));
  const longUrl = await clip(A.page);
  ok(/#s1=/.test(longUrl), 'Copy long link copies the #s1= link (' + longUrl.length + ' chars)');

  // 2) open the short link in a fresh browser profile
  const B = await fresh();
  await B.page.goto(shortUrl, { waitUntil: 'networkidle2' });
  await B.page.waitForFunction(n => (RallyRaidBuilder.state().meta || {}).name === n, { timeout: 15000 }, src.name);
  const gotB = await B.page.evaluate(() => ({ st: RallyRaidBuilder.exportStage(), href: location.href, status: document.getElementById('status').textContent }));
  ok(sig(gotB.st) === sig(src) && gotB.st.id === src.id, 'short link opens the same stage in a fresh browser (' + src.name + ', ' + src.waypoints.length + ' waypoints, ' + src.lengthKm + ' km, id ' + src.id + ')');
  ok(gotB.href === BASE + '/', 'address becomes the normal builder address afterwards: ' + gotB.href);
  ok(/short link/.test(gotB.status), 'status: ' + gotB.status);
  ok(!B.errors.length, 'no page errors' + (B.errors.length ? ': ' + B.errors.join(' | ') : ''));
  await B.page.screenshot({ path: '/tmp/short_open_stage.png' });

  // 3) an old long #s1 link still works unchanged
  const C = await fresh();
  await C.page.goto(BASE + '/#' + S.packStage(src), { waitUntil: 'networkidle2' });
  await C.page.waitForFunction(n => (RallyRaidBuilder.state().meta || {}).name === n, { timeout: 15000 }, src.name);
  const gotC = await C.page.evaluate(() => ({ st: RallyRaidBuilder.exportStage(), status: document.getElementById('status').textContent }));
  ok(sig(gotC.st) === sig(src), 'old #s1= long link opens the stage: ' + gotC.status);
  // the long link copied in step 1 also opens
  const C2 = await fresh();
  await C2.page.goto(longUrl, { waitUntil: 'networkidle2' });
  await C2.page.waitForFunction(n => (RallyRaidBuilder.state().meta || {}).name === n, { timeout: 15000 }, src.name);
  ok(true, 'the copied long link opens too');

  // 4) roadbook: Share in the editor makes a short link that opens in the roadbook editor
  const rb = JSON.parse(fs.readFileSync(path.join(EX, 'mar-merzouga-erg-chebbi.roadbook.json'), 'utf8'));
  const rst = JSON.parse(fs.readFileSync(path.join(EX, 'mar-merzouga-erg-chebbi.json'), 'utf8'));
  const D = await fresh();
  await D.page.goto(BASE + '/roadbook.html#' + S.packRoadbook(rb, rst), { waitUntil: 'networkidle2' });
  await D.page.waitForFunction(() => window.RoadbookEditor && RoadbookEditor.E && RoadbookEditor.E.rb, { timeout: 20000 });
  await D.page.evaluate(() => document.getElementById('b-share').click());
  await D.page.waitForFunction(() => /link/i.test((document.getElementById('rr-share-toast') || {}).textContent || ''), { timeout: 15000 });
  const rbShort = await clip(D.page);
  ok(/\/s\/[A-Za-z0-9]{22}$/.test(rbShort), 'roadbook Share copies a short link: ' + rbShort);
  const E2 = await fresh();
  await E2.page.goto(rbShort, { waitUntil: 'networkidle2' });
  await E2.page.waitForFunction(() => window.RoadbookEditor && RoadbookEditor.E && RoadbookEditor.E.rb, { timeout: 20000 });
  const gotE = await E2.page.evaluate(() => ({ boxes: RoadbookEditor.E.rb.boxes.length, id: RoadbookEditor.E.stage.id, href: location.href }));
  ok(gotE.boxes === rb.boxes.length && gotE.id === rst.id, 'roadbook short link opens the roadbook in the editor (' + gotE.boxes + ' boxes) at ' + gotE.href);
  // a roadbook short link opened on the builder page is sent to the editor
  const id = rbShort.split('/s/')[1];
  const F = await fresh();
  await F.page.goto(BASE + '/#k1=' + id, { waitUntil: 'networkidle2' });
  await F.page.waitForFunction(() => /roadbook/.test(location.pathname) && window.RoadbookEditor && RoadbookEditor.E && RoadbookEditor.E.rb, { timeout: 20000 });
  ok(true, 'roadbook short id on the builder page redirects to the editor');

  // 5) automatic fallback: if the short link cannot be made, the long link is copied
  const G = await fresh();
  await G.page.setRequestInterception(true);
  G.page.on('request', q => { if (q.url().endsWith('/api/share') && q.method() === 'POST') q.respond({ status: 503, contentType: 'application/json', body: '{"error":"test outage"}' }); else q.continue(); });
  await G.page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await G.page.evaluate(s => RallyRaidBuilder.importStage(s), stage);
  await G.page.evaluate(() => document.getElementById('b-share').click());
  await G.page.waitForFunction(() => /link/i.test((document.getElementById('rr-share-toast') || {}).textContent || ''), { timeout: 15000 });
  const fb = await clip(G.page);
  ok(/#s1=/.test(fb), 'short-link failure falls back to the long link automatically (' + fb.length + ' chars)');
  ok(/Could not make a short link \(test outage\)/.test(await toastText(G.page)), 'toast explains the fallback: ' + (await toastText(G.page)).slice(0, 90) + '...');

  // 6) a missing short link shows a clear message and keeps the browser's saved work
  const H = await fresh();
  await H.page.goto(BASE + '/s/AAAAAAAAAAAAAAAAAAAAAA', { waitUntil: 'networkidle2' });
  await H.page.waitForFunction(() => /not found/.test(document.getElementById('status').textContent), { timeout: 15000 });
  ok(true, 'unknown short link: "' + await H.page.evaluate(() => document.getElementById('status').textContent) + '"');

  await browser.close();
  console.log(fails ? fails + ' FAILED' : 'all passed');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
