// Roadbook editor: importing an in-game recce (tests/fixtures/recce/*.recce.json, written by tests/recce_test.lua from
// a simulated drive): the driven line and the changes on the map, the review list (new / conflict / already in), applying
// them, conflicts with desk edits, importing twice, and re-measuring km from the driven line.
// NODE_PATH=/workspace/rr-tools/node_modules node tests/browser/recce_import_test.js
const fs = require('fs'), H = require('./rb_harness.js');
const FX = require('path').resolve(__dirname, '../fixtures/recce/moab-sand-flats-ss1.recce.json');
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const doc = JSON.parse(fs.readFileSync(FX));
  // the generated boxes the recce worked on (written by tests/recce_test.lua; ids depend on the generator version)
  const J16 = doc.changes.find(c => c.op === 'confirm').id, J44 = doc.changes.find(c => c.op === 'delete').id;
  const srv = await H.serve();
  const { browser, page, stats } = await H.launch({});
  const ev = (f, a) => page.evaluate(f, a);
  page.on('dialog', d => d.accept());
  await page.goto(srv.url + '/roadbook.html?example=moab-sand-flats-ss1', { waitUntil: 'networkidle2' });
  await H.waitFor(page, () => window.RoadbookEditor && RoadbookEditor.E.rb && RoadbookEditor.E.rb.boxes.length > 10);
  // a desk edit made after the recce read the roadbook: the recce's confirm + retag of that box must not overwrite it
  await ev(id => { const b = RoadbookEditor.E.rb.boxes.find(x => x.id === id); Object.assign(b, { rev: 5, pinned: true, source: 'editor', sources: ['auto-osm', 'editor'], notes: 'DESK EDIT' }); }, J16);
  const live0 = await ev(() => RoadbookEditor.E.rb.boxes.filter(b => !b.deleted).length);
  const input = await page.$('#in-recce');
  await input.uploadFile(FX);
  await H.waitFor(page, () => RoadbookEditor.E.recce && document.querySelectorAll('.rc-item').length > 0, null, 15000);
  const nCh = doc.changes.length, nAdd = doc.changes.filter(c => c.op === 'add').length;
  let s = await ev(() => ({ items: document.querySelectorAll('.rc-item').length, line: document.querySelectorAll('path.recce-line').length, marks: document.querySelectorAll('.rcm').length,
    conflict: document.querySelectorAll('.rc-item .st.conflict').length, banner: document.querySelector('#bn-recce') && document.querySelector('#bn-recce').textContent, checked: document.querySelectorAll('.rc-item input:checked').length }));
  ok(s.items === nCh && s.line === 1 && s.marks === nCh, 'review list (' + s.items + ') and the driven line + a marker per change on the map');
  ok(s.conflict === 2 && s.checked === nCh - 2, 'confirm + retag of the desk-edited box flagged as conflicts and left unticked');
  ok(/Recce imported/.test(s.banner || ''), 'banner: ' + (s.banner || '').slice(0, 80));
  // a row selects its spot on the map
  await page.click('.rc-item[data-k="' + doc.changes.findIndex(c => c.by === 'recce-auto') + '"]');
  ok(await ev(() => document.querySelectorAll('.rcm.sel').length === 1 && document.querySelector('.rc-item.sel') !== null), 'list row highlights its marker');
  await H.sleep(1500);
  await page.screenshot({ path: H.ROOT + '/roadbook_editor_recce.png' });
  // apply
  await page.click('#rc-apply');
  await H.sleep(300);
  s = await ev(([j16, j44]) => { const rb = RoadbookEditor.E.rb, by = id => rb.boxes.find(b => b.id === id);
    return { live: rb.boxes.filter(b => !b.deleted).length, del44: !!by(j44).deleted, j16: by(j16).notes, conf: (rb.conflicts || []).length,
      auto: rb.boxes.filter(b => b.source === 'recce-auto').length, manual: rb.boxes.filter(b => b.source === 'recce-manual').length,
      flags: document.querySelectorAll('#list .flag.rc').length, chk: document.querySelectorAll('#list .flag.chk').length, done: document.querySelectorAll('.rc-item .st.done').length,
      banner: document.querySelector('#bn-recce').textContent, sorted: rb.boxes.filter(b => !b.deleted).every((b, i, a) => !i || a[i - 1].km <= b.km), confBtn: !!document.querySelector('#rc-conf') }; }, [J16, J44]);
  ok(s.live === live0 + nAdd - 1 && s.del44 && s.j16 === 'DESK EDIT', 'applied: ' + nAdd + ' boxes added, one deleted, the desk edit kept');
  ok(s.auto >= 7 && s.manual === 1 && s.flags >= nAdd && s.chk >= 7, 'recce boxes flagged RECCE, detected ones CHECK until confirmed');
  ok(s.done === nCh - 2 && s.sorted, 'list now shows them as already in; boxes still in km order');
  ok(s.conf === 0 && s.confBtn === false, 'unticked conflicts were not applied (nothing to resolve)');
  // apply the conflicting ones too: they go to the Conflicts list
  await ev(() => { document.querySelectorAll('.rc-item input:not(:disabled)').forEach(x => x.click()); });
  await page.click('#rc-apply'); await H.sleep(300);
  s = await ev(() => ({ conf: RoadbookEditor.E.rb.conflicts.length, btn: !!document.querySelector('#rc-conf') }));
  ok(s.conf === 2 && s.btn, 'conflicting changes go to the Conflicts list (' + s.conf + ')');
  await page.click('#rc-conf'); await H.sleep(200);
  ok(await ev(() => document.querySelectorAll('[data-cf="keep"]').length === 2), 'Conflicts list offers apply theirs / keep mine');
  await page.click('[data-cf="keep"]'); await H.sleep(200);
  ok(await ev(id => RoadbookEditor.E.rb.conflicts.length === 1 && RoadbookEditor.E.rb.boxes.find(x => x.id === id).notes === 'DESK EDIT', J16), 'keep mine');
  // undo takes the import back
  await ev(() => { for (let i = 0; i < 3; i++) document.querySelector('#b-undo').click(); });
  ok(await ev(n => RoadbookEditor.E.rb.boxes.filter(b => !b.deleted).length === n, live0), 'undo takes the import back');
  // re-import with km from the driven line
  await input.uploadFile(FX);
  await H.waitFor(page, () => document.querySelectorAll('.rc-item').length > 0);
  await page.click('#rc-rescale'); await H.sleep(100);
  await page.click('#rc-apply'); await H.sleep(300);
  s = await ev(() => ({ rec: RoadbookEditor.E.rb.recce, banner: document.querySelector('#bn-recce').textContent }));
  ok(s.rec && s.rec.matched >= nAdd && /re-measured/.test(s.banner), 'km re-measured from the driven line (' + (s.rec && s.rec.matched) + ' boxes on it)');
  // another stage's recce is refused
  const other = JSON.parse(JSON.stringify(doc)); other.stage.id = 'nam-ss2-terrace-bay-mowe-bay-dunes';
  fs.writeFileSync('/tmp/other.recce.json', JSON.stringify(other));
  let alerted = null; page.removeAllListeners('dialog'); page.once('dialog', d => { alerted = d.message(); d.accept(); });
  await input.uploadFile('/tmp/other.recce.json'); await H.sleep(500);
  ok(alerted && /recorded on stage/.test(alerted), 'another stage\'s recce refused: ' + alerted);
  ok(stats.errors.length === 0, 'no page errors ' + JSON.stringify(stats.errors.slice(0, 3)));
  await browser.close(); srv.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
