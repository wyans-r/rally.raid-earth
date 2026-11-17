// Share links in the stage builder and roadbook editor (headless Chrome).
// NODE_PATH=/workspace/rr-tools/node_modules node tests/browser/share_link_test.js
const puppeteer = require('puppeteer-core'), fs = require('fs'), http = require('http'), path = require('path');
const S = require('../../stage-builder/share.js');
const ROOT = '/workspace/rallyraid', SITE = path.join(ROOT, 'stage-builder');
const EX = path.join(SITE, 'examples');
const OUT = path.join(ROOT, 'tests/browser/screens/share-after');
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
fs.mkdirSync(OUT, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(EX, 'index.json'), 'utf8'));
function loadPair(s) {
  return {
    stage: JSON.parse(fs.readFileSync(path.join(EX, s.file), 'utf8')),
    roadbook: JSON.parse(fs.readFileSync(path.join(EX, s.id + '.roadbook.json'), 'utf8'))
  };
}
function dropStamps(o) {
  if (!o || typeof o !== 'object') return o;
  const c = JSON.parse(JSON.stringify(o));
  delete c.modified;
  delete c.generator;
  // the builder's export already omits empty / null leftover fields on stage boxes
  // (tulip is always null on shipped stage files; notes / danger only appear if set)
  if (c.roadbook && c.roadbook.boxes) {
    for (const box of c.roadbook.boxes) {
      if (box.tulip == null) delete box.tulip;
      if (!box.notes) delete box.notes;
      if (!box.danger) delete box.danger;
    }
  }
  return c;
}
function sameStage(a, b) {
  return JSON.stringify(dropStamps(a)) === JSON.stringify(dropStamps(b));
}

const srv = http.createServer((q, r) => {
  let u = decodeURIComponent((q.url || '/').split('?')[0]); if (u.endsWith('/')) u += 'index.html';
  const f = path.normalize(path.join(SITE, u));
  if (!f.startsWith(SITE)) { r.writeHead(403); r.end(); return; }
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    r.end(d);
  });
});

let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const base = 'http://127.0.0.1:' + srv.address().port;
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox'] });

  async function freshPage(opts) {
    opts = opts || {};
    const ctx = await browser.createBrowserContext();
    if (opts.perms) await ctx.overridePermissions(base, opts.perms);
    const page = await ctx.newPage();
    await page.setViewport(opts.viewport || { width: 1440, height: 900 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error' && !/favicon|leaflet|tile|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
    await page.evaluateOnNewDocument(() => { try { localStorage.setItem('rallyraid-examples-hint', '1'); } catch (e) {} });
    return { ctx, page, errors };
  }

  // ---------- 1) stage round trip for all 15 examples ----------
  let stageOk = 0;
  for (const s of manifest.stages) {
    const { stage } = loadPair(s);
    const frag = S.packStage(stage);
    const { ctx, page, errors } = await freshPage();
    await page.goto(base + '/index.html#' + frag, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForFunction(id => (window.RallyRaidBuilder && RallyRaidBuilder.state().meta || {}).id === id, { timeout: 15000 }, s.id);
    const got = await page.evaluate(() => ({
      id: RallyRaidBuilder.state().meta.id,
      name: RallyRaidBuilder.state().meta.name,
      points: RallyRaidBuilder.state().points.length,
      exported: RallyRaidBuilder.exportStage(),
      hash: location.hash,
      status: (document.getElementById('status') || {}).textContent,
      opened: RallyRaidBuilder.openedShare && RallyRaidBuilder.openedShare()
    }));
    const match = sameStage(got.exported, stage);
    const hashCleared = got.hash === '' || got.hash === '#';
    if (match && hashCleared && got.points > 0 && !errors.filter(e => !/leaflet|tile/i.test(e)).length) {
      stageOk++;
    } else {
      // diagnose first mismatch
      const a = dropStamps(got.exported), b = dropStamps(stage);
      let diff = '';
      if (!match) {
        const ak = Object.keys(a), bk = Object.keys(b);
        for (const k of new Set([...ak, ...bk])) {
          if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) { diff += ' field ' + k; break; }
        }
      }
      ok(false, 'stage roundtrip ' + s.id + ' match=' + match + ' hash=' + JSON.stringify(got.hash) + ' pts=' + got.points + ' opened=' + got.opened + ' err=' + JSON.stringify(errors) + diff);
    }
    await ctx.close();
  }
  ok(stageOk === manifest.stages.length, 'stage share round trip ' + stageOk + '/' + manifest.stages.length);

  // ---------- 2) roadbook round trip for all 15 ----------
  let rbOk = 0;
  for (const s of manifest.stages) {
    const { stage, roadbook } = loadPair(s);
    const frag = S.packRoadbook(roadbook, stage);
    const { ctx, page, errors } = await freshPage();
    await page.goto(base + '/roadbook.html#' + frag, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForFunction(() => window.RoadbookEditor && RoadbookEditor.E && RoadbookEditor.E.rb && RoadbookEditor.E.stage, { timeout: 20000 });
    const got = await page.evaluate(() => {
      const E = RoadbookEditor.E;
      const hashBanner = document.querySelector('#banners .banner');
      const banners = Array.from(document.querySelectorAll('#banners .banner')).map(el => ({ kind: [...el.classList].filter(c => c !== 'banner').join(' '), text: el.textContent }));
      return {
        id: E.stage && E.stage.id,
        stageHash: E.stageHash,
        rbHash: E.rb && E.rb.stage && E.rb.stage.hash,
        boxes: E.rb && E.rb.boxes && E.rb.boxes.length,
        rbId: E.rb && E.rb.id,
        hash: location.hash,
        banners,
        how: document.getElementById('stage-name') && document.getElementById('stage-name').textContent
      };
    });
    const noStageChanged = !got.banners.some(b => /stage has changed/i.test(b.text) || (b.kind === 'warn' && /changed/i.test(b.text)));
    const hashCleared = got.hash === '' || got.hash === '#';
    const hashMatch = got.stageHash && got.stageHash === got.rbHash;
    const boxMatch = got.boxes === roadbook.boxes.length;
    if (got.id === s.id && hashCleared && hashMatch && boxMatch && noStageChanged) {
      rbOk++;
    } else {
      ok(false, 'roadbook roundtrip ' + s.id + ' ' + JSON.stringify({ id: got.id, hashCleared, hashMatch, boxMatch, noStageChanged, gotHash: got.hash, stageHash: got.stageHash, rbHash: got.rbHash, boxes: got.boxes, expectBoxes: roadbook.boxes.length, banners: got.banners, errors }));
    }
    await ctx.close();
  }
  ok(rbOk === manifest.stages.length, 'roadbook share round trip ' + rbOk + '/' + manifest.stages.length);

  // ---------- 3) truncated link shows a clear error ----------
  {
    const { stage } = loadPair(manifest.stages[0]);
    const frag = S.packStage(stage);
    const cut = frag.slice(0, Math.max(12, frag.length - 40));
    const { ctx, page } = await freshPage();
    await page.goto(base + '/index.html#' + cut, { waitUntil: 'networkidle2' });
    await sleep(800);
    const got = await page.evaluate(() => ({
      status: (document.getElementById('status') || {}).textContent,
      toast: (document.getElementById('rr-share-toast') || {}).textContent,
      id: (window.RallyRaidBuilder && RallyRaidBuilder.state().meta || {}).id,
      points: window.RallyRaidBuilder ? RallyRaidBuilder.state().points.length : -1
    }));
    ok(/damaged or was cut off|shorten long links/i.test(got.status + ' ' + (got.toast || '')), 'truncated stage link shows a clear error: ' + JSON.stringify(got.status));
    ok(got.id !== manifest.stages[0].id && got.points === 0, 'truncated link does not load a half-stage (id=' + got.id + ', points=' + got.points + ')');
    await ctx.close();
  }

  // ---------- 4) unsaved-work prompt ----------
  {
    const a = loadPair(manifest.stages[0]);
    const b = loadPair(manifest.stages[1]);
    const { ctx, page } = await freshPage();
    // seed localStorage with stage A by opening it
    await page.goto(base + '/index.html#' + S.packStage(a.stage), { waitUntil: 'networkidle2' });
    await page.waitForFunction(id => (RallyRaidBuilder.state().meta || {}).id === id, { timeout: 15000 }, a.stage.id);
    await sleep(500); // autosave debounce
    // dismiss the replace prompt: keep A
    page.once('dialog', async d => { ok(/saved in this browser/i.test(d.message()), 'unsaved prompt text: ' + d.message()); await d.dismiss(); });
    await page.goto(base + '/index.html#' + S.packStage(b.stage), { waitUntil: 'networkidle2' });
    await sleep(800);
    const kept = await page.evaluate(() => ({ id: RallyRaidBuilder.state().meta.id, hash: location.hash }));
    ok(kept.id === a.stage.id, 'dismissing the prompt keeps the saved stage (' + kept.id + ')');
    ok(/s1=/.test(kept.hash), 'hash is kept after dismiss so the link is not lost');
    // accept the prompt: load B. Leave via about:blank so the next goto is a real navigation
    // (after dismiss the address still has B's hash, which would otherwise not reload).
    await page.goto('about:blank');
    page.once('dialog', d => d.accept());
    await page.goto(base + '/index.html#' + S.packStage(b.stage), { waitUntil: 'networkidle2' });
    await page.waitForFunction(id => (RallyRaidBuilder.state().meta || {}).id === id, { timeout: 15000 }, b.stage.id);
    const loaded = await page.evaluate(() => ({ id: RallyRaidBuilder.state().meta.id, hash: location.hash }));
    ok(loaded.id === b.stage.id && (loaded.hash === '' || loaded.hash === '#'), 'accepting the prompt loads the shared stage and clears the hash');
    await ctx.close();
  }

  // ---------- 5) mobile share button at 390x844 ----------
  {
    const { stage } = loadPair(manifest.stages.find(s => s.id === 'nam-ss2-terrace-bay-mowe-bay-dunes') || manifest.stages[2]);
    const { ctx, page } = await freshPage({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
    await page.evaluateOnNewDocument(() => {
      window.__shared = null;
      navigator.share = opts => { window.__shared = opts; return Promise.resolve(); };
    });
    await page.goto(base + '/index.html#' + S.packStage(stage), { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => (RallyRaidBuilder.state().meta || {}).id === 'nam-ss2-terrace-bay-mowe-bay-dunes', { timeout: 15000 });
    await sleep(400);
    const vis = await page.evaluate(() => {
      const b = document.getElementById('b-share');
      const r = b && b.getBoundingClientRect();
      const cs = b && getComputedStyle(b);
      return { exists: !!b, text: b && b.textContent.trim(), w: r && r.width, h: r && r.height, display: cs && cs.display, visible: !!(r && r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden') };
    });
    ok(vis.exists && vis.visible && /Share/i.test(vis.text), 'mobile 390x844: Share button is visible (' + JSON.stringify(vis) + ')');
    // may need to confirm a long-link dialog (this stage is only ~3k = soft, no confirm)
    page.on('dialog', d => d.accept());
    await page.click('#b-share');
    await sleep(600);
    const shared = await page.evaluate(() => window.__shared);
    const toast = await page.evaluate(() => (document.getElementById('rr-share-toast') || {}).textContent);
    ok(shared && /s1=/.test((shared.url || '') + (shared.text || '')), 'mobile Share uses navigator.share with the stage link: ' + JSON.stringify(shared));
    await page.screenshot({ path: path.join(OUT, 'mobile_index_share_390x844.png') });
    await ctx.close();

    // roadbook mobile button too
    const pair = loadPair(manifest.stages.find(s => s.id === 'nam-ss2-terrace-bay-mowe-bay-dunes'));
    const { ctx: ctx2, page: page2 } = await freshPage({ viewport: { width: 390, height: 844, isMobile: true, hasTouch: true } });
    await page2.goto(base + '/roadbook.html#' + S.packRoadbook(pair.roadbook, pair.stage), { waitUntil: 'networkidle2' });
    await page2.waitForFunction(() => window.RoadbookEditor && RoadbookEditor.E && RoadbookEditor.E.rb, { timeout: 20000 });
    await sleep(400);
    const vis2 = await page2.evaluate(() => {
      const b = document.getElementById('b-share');
      const r = b && b.getBoundingClientRect();
      const cs = b && getComputedStyle(b);
      return { exists: !!b, text: b && b.textContent.trim(), visible: !!(r && r.width > 0 && r.height > 0 && cs.display !== 'none'), top: r && r.top, left: r && r.left, w: r && r.width };
    });
    // On the roadbook phone layout the toolbar scrolls; the button should exist. If it's off-screen, scroll it into view.
    if (vis2.exists && !vis2.visible) {
      await page2.evaluate(() => document.getElementById('b-share').scrollIntoView({ inline: 'nearest', block: 'nearest' }));
      await sleep(200);
    }
    const vis2b = await page2.evaluate(() => {
      const b = document.getElementById('b-share');
      const r = b.getBoundingClientRect();
      return { visible: r.width > 0 && r.height > 0, top: r.top, left: r.left, w: r.width, h: r.height };
    });
    ok(vis2.exists && vis2b.visible, 'mobile roadbook 390x844: Share button can be brought into view (' + JSON.stringify({ vis2, vis2b }) + ')');
    await page2.screenshot({ path: path.join(OUT, 'mobile_roadbook_share_390x844.png') });
    await ctx2.close();
  }

  // ---------- 6) long-link warning (strong / very) ----------
  {
    const pair = loadPair(manifest.stages.find(s => s.id === 'mex-baja-ojos-negros-mikes') || manifest.stages[manifest.stages.length - 1]);
    const info = S.linkFor(base + '/roadbook.html', S.packRoadbook(pair.roadbook, pair.stage));
    ok(info.warning === 'very' || info.warning === 'strong', 'Baja (or largest) roadbook link is in the strong/very band: ' + info.warning + ' ' + info.length);
    const { ctx, page } = await freshPage();
    await page.goto(base + '/roadbook.html#' + S.packRoadbook(pair.roadbook, pair.stage), { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.RoadbookEditor && RoadbookEditor.E && RoadbookEditor.E.rb, { timeout: 20000 });
    let dialog = null;
    page.once('dialog', async d => { dialog = d.message(); await d.dismiss(); });
    await page.click('#b-share');
    await sleep(600);
    ok(dialog && /long/i.test(dialog) && /messaging apps/i.test(dialog), 'Share on a long roadbook warns before copying: ' + JSON.stringify(dialog));
    await ctx.close();
  }

  // ---------- 7) desktop screenshots of the new button ----------
  {
    const { ctx, page } = await freshPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(base + '/index.html', { waitUntil: 'networkidle2' });
    await sleep(5000);
    await page.screenshot({ path: path.join(OUT, 'index_1440x900.png') });
    const headerBtn = await page.evaluate(() => {
      const b = document.getElementById('b-share');
      const r = b && b.getBoundingClientRect();
      const cs = b && getComputedStyle(b);
      return { exists: !!b, display: cs && cs.display, w: r && r.width, h: r && r.height };
    });
    ok(headerBtn.exists && (headerBtn.display === 'none' || !headerBtn.w), 'desktop builder hides the header Share button so the header does not grow: ' + JSON.stringify(headerBtn));
    await page.click('[data-tab="file"]');
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, 'index_file_1440x900.png') });
    const btn = await page.evaluate(() => {
      const b = document.getElementById('f-share');
      const r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
    });
    ok(/share link/i.test(btn.text) && btn.visible, 'desktop builder Copy share link button is in the File tab: ' + JSON.stringify(btn));
    await ctx.close();
  }
  {
    const { ctx, page } = await freshPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(base + '/roadbook.html?example=nam-ss2-terrace-bay-mowe-bay-dunes', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.RoadbookEditor && RoadbookEditor.E && RoadbookEditor.E.rb && RoadbookEditor.E.stage && RoadbookEditor.E.stage.id === 'nam-ss2-terrace-bay-mowe-bay-dunes', { timeout: 20000 });
    await sleep(6000);
    await page.screenshot({ path: path.join(OUT, 'roadbook-example_1440x900.png') });
    const btn = await page.evaluate(() => {
      const b = document.getElementById('b-share');
      const r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), x: r.x, y: r.y, w: r.width, h: r.height, visible: r.width > 0 && r.height > 0 };
    });
    ok(btn.visible && /Share link/i.test(btn.text), 'desktop roadbook Share link button is in the toolbar: ' + JSON.stringify(btn));
    await ctx.close();
  }
  {
    // loaded example on the builder, same as the baseline
    const { ctx, page } = await freshPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(base + '/index.html?example=nam-ss2-terrace-bay-mowe-bay-dunes', { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => (RallyRaidBuilder.state().meta || {}).id === 'nam-ss2-terrace-bay-mowe-bay-dunes', { timeout: 15000 });
    await sleep(5000);
    await page.screenshot({ path: path.join(OUT, 'index-example_1440x900.png') });
    await ctx.close();
  }

  // ---------- 8) a roadbook hash on the builder redirects ----------
  {
    const pair = loadPair(manifest.stages[2]);
    const frag = S.packRoadbook(pair.roadbook, pair.stage);
    const { ctx, page } = await freshPage();
    await page.goto(base + '/index.html#' + frag, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForFunction(() => /roadbook/.test(location.pathname) && window.RoadbookEditor && RoadbookEditor.E && RoadbookEditor.E.rb, { timeout: 20000 });
    const where = await page.evaluate(() => ({ path: location.pathname, id: RoadbookEditor.E.stage.id, hash: location.hash }));
    ok(/roadbook/.test(where.path) && where.id === pair.stage.id && (where.hash === '' || where.hash === '#'), 'builder URL with a roadbook hash redirects to the editor: ' + JSON.stringify(where));
    await ctx.close();
  }

  if (fails) console.log('TEST FAILED (' + fails + ')');
  else console.log('TEST PASSED');
  await browser.close();
  srv.close();
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
