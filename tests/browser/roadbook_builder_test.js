// The builder (index.html) -> roadbook editor hand-off: the Roadbook button exports the current stage, the editor
// opens in its own tab with that stage, and an example opened in the builder hashes the same as the example file
// (so a roadbook made from ?example= matches the stage exported from the builder).
// NODE_PATH=/workspace/rr-tools/node_modules node tests/browser/roadbook_builder_test.js
const fs = require('fs'), H = require('./rb_harness.js');
const RB = require('../../stage-builder/roadbook-gen.js');
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const srv = await H.serve();
  const { browser, page, stats } = await H.launch({ noImagery: true });
  await page.goto(srv.url + '/?example=aus-finke-old-south-road', { waitUntil: 'networkidle2' });
  await H.waitFor(page, () => window.RallyRaidBuilder && RallyRaidBuilder.state().points.length > 2, null, 30000);
  ok(await page.$('#rb-open') && await page.$('#f-roadbook'), 'Roadbook buttons in the header and the File tab');
  const exported = await page.evaluate(() => RallyRaidBuilder.exportStage());
  const file = JSON.parse(fs.readFileSync(H.SITE + '/examples/aus-finke-old-south-road.json'));
  const h1 = await RB.stageHash(exported), h2 = await RB.stageHash(file);
  ok(h1 === h2, 'builder export of an example hashes like the example file (' + h1.slice(7, 19) + ')');
  const newTab = new Promise(res => browser.once('targetcreated', t => res(t.page())));
  await page.click('#rb-open');
  const ed = await newTab;
  await ed.waitForFunction(() => window.RoadbookEditor && RoadbookEditor.E.stage, { timeout: 30000 });
  const got = await ed.evaluate(() => ({ id: RoadbookEditor.E.stage.id, hash: RoadbookEditor.E.stageHash, url: location.search, name: document.querySelector('#stage-name').textContent }));
  ok(got.id === 'aus-finke-old-south-road' && got.hash === h1 && got.url === '?from=builder' && /from the builder/.test(got.name), 'editor opened in its own tab with the builder\'s stage');
  // the example's ready-made roadbook (stage-builder/examples/<id>.roadbook.json) fits the builder's stage: it is shown
  const shipped = JSON.parse(fs.readFileSync(H.SITE + '/examples/aus-finke-old-south-road.roadbook.json'));
  await ed.waitForFunction(() => RoadbookEditor.E.rb, { timeout: 30000 }).catch(() => {});
  const st = await ed.evaluate(() => ({ n: RoadbookEditor.E.rb ? RoadbookEditor.E.rb.boxes.length : 0, banner: document.querySelector('#banners').textContent, rows: document.querySelectorAll('#list .row').length }));
  ok(st.n === shipped.boxes.length && /ready-made roadbook/.test(st.banner) && st.rows > 0, 'shipped roadbook opened with the builder\'s stage (' + st.n + ' boxes, notes moved in from the old stage file: ' + shipped.stats.migratedFromStage + ')');
  // a second click reuses the same tab
  const pagesBefore = (await browser.pages()).length;
  await page.bringToFront(); await page.evaluate(() => document.querySelector('#rb-open').click()); await H.sleep(1500);
  ok((await browser.pages()).length === pagesBefore, 'second click reuses the roadbook tab');
  // roadbook text is no longer edited in the builder; an older file's text passes through untouched
  ok(await page.evaluate(() => !document.querySelector('#e-notes') && !document.querySelector('#e-danger')), 'waypoint editor has no roadbook notes / danger fields');
  const legacy = JSON.parse(fs.readFileSync(__dirname + '/../../roadbook/legacy-stage-notes/aus-finke-old-south-road.json'));
  const withText = legacy.roadbook.boxes.filter(b => b.notes).length;
  const back = await page.evaluate(j => { RallyRaidBuilder.importStage(j); return RallyRaidBuilder.exportStage(); }, legacy);
  ok(withText > 0 && back.roadbook.boxes.filter(b => b.notes).length === withText, 'older stage file: ' + withText + ' notes kept on export (deprecated, for the roadbook generator to migrate)');
  await page.bringToFront(); await page.evaluate(() => document.querySelector('#rb-open').click());
  await ed.waitForFunction(n => { const b = document.querySelector('#bn-legacy'); return b && b.textContent.includes(n + ' point'); }, { timeout: 20000 }, withText).then(() => ok(true, 'editor points out the old stage-file notes it will move in'), () => ok(false, 'editor points out the old stage-file notes it will move in'));
  // empty builder: refuses politely
  await page.evaluate(() => RallyRaidBuilder.importStage({ format: 'rallyraid-stage', schemaVersion: 1, id: 'x', name: 'x', waypoints: [], route: { legs: [] } }));
  let alerted = null; page.once('dialog', d => { alerted = d.message(); d.dismiss(); });
  await page.bringToFront(); await page.evaluate(() => setTimeout(() => document.querySelector('#rb-open').click(), 0)); await H.sleep(800);
  ok(alerted && /Plot a stage first/.test(alerted), 'no stage: asks to plot one first');
  ok(stats.errors.length === 0, 'no page errors ' + JSON.stringify(stats.errors.slice(0, 3)));
  await browser.close(); srv.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
