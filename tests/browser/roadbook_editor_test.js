// Roadbook editor (stage-builder/roadbook.html) in real Chrome: generate (terrain first, then OSM), edit boxes
// (notes, symbols, danger, tulip, move on the route, add / split / delete, pin), undo / redo, regenerate keeping the
// edits, re-plan an off-piste leg and draw it by hand, the stage-changed warning, save, and both PDF formats.
// NODE_PATH=/workspace/rr-tools/node_modules node tests/browser/roadbook_editor_test.js   (screenshots in /workspace/rallyraid)
const fs = require('fs'), { execSync } = require('child_process');
const H = require('./rb_harness.js');
const ID = 'nam-ss2-terrace-bay-mowe-bay-dunes';
let fails = 0; const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
(async () => {
  const srv = await H.serve();
  const { browser, page, stats } = await H.launch({ noStarters: true });   // start from a blank roadbook (the shipped one is checked in roadbook_builder_test)
  const ev = (f, a) => page.evaluate(f, a);
  await page.goto(srv.url + '/roadbook.html?example=' + ID, { waitUntil: 'networkidle2' });
  await H.waitFor(page, () => window.RoadbookEditor && RoadbookEditor.E.stage);
  page.on('dialog', d => d.accept());
  ok(await ev(() => /Generate|ready-made roadbook/.test(document.querySelector('#banners').textContent)), 'example stage opened (with its ready-made roadbook, or asking to generate)');
  // --- generate: terrain boxes first, then OSM
  let sawPartial = false;
  await ev(() => { document.querySelector('#b-gen').click(); });
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const s = await ev(() => ({ busy: RoadbookEditor.E.busy, partial: RoadbookEditor.E.rb && RoadbookEditor.E.rb.partial, prog: !document.querySelector('#progress').hidden, ph: document.querySelector('#progress .phase').textContent }));
    if (s.partial === 'terrain-only' && s.busy && !sawPartial) { sawPartial = true; await page.screenshot({ path: H.ROOT + '/roadbook_editor_partial.png' }); }
    if (!s.busy && Date.now() - t0 > 500) break;
    await H.sleep(100);
  }
  const g = await ev(() => { const rb = RoadbookEditor.E.rb; return { n: rb.boxes.length, partial: rb.partial, osm: rb.sources.osm, per10: rb.stats.per10km, planned: rb.route.legs.filter(l => l.planned).length, markers: document.querySelectorAll('.bx').length, rows: document.querySelectorAll('#list .row').length }; });
  ok(sawPartial, 'terrain-first: boxes shown while OpenStreetMap loads');
  ok(g.n > 20 && !g.partial && g.osm && g.osm.elements > 0, 'generated ' + g.n + ' boxes with OSM (' + (g.osm && g.osm.elements) + ' elements), off-piste ' + g.per10.offPiste + '/10 km, ' + g.planned + ' planned legs');
  const dh = await ev(() => document.querySelector('#density-h').textContent);
  ok(/rally-like, gaps up to ~10 km \| now: \d+ boxes, median gap [\d.]+ km, longest [\d.]+ km/.test(dh), 'density readout: ' + dh);
  ok(g.markers === g.n && g.rows === g.n, 'every box in the list and on the map (' + g.rows + ' / ' + g.markers + ')');
  ok(stats.osmHit > 0 && stats.osmMiss === 0 && stats.demHit > 0, 'tiles / Overpass via the (test) network: dem ' + stats.demHit + ' hits, osm ' + stats.osmHit + ' hits, ' + stats.osmMiss + ' misses');
  // --- select from the list -> map marker + panel
  await page.click('#list .row:nth-child(12)');
  const sel = await ev(() => { const E = RoadbookEditor.E; const b = E.rb.boxes.find(x => x.id === E.sel); return { n: b.n, mk: !!document.querySelector('.bx.sel'), panel: document.querySelector('#panel h3').textContent, tul: !!document.querySelector('#tulip-ed circle[data-h=x]'), thumb: !!document.querySelector('.thumb img') }; });
  ok(sel.n === 12 && sel.mk && /Box 12/.test(sel.panel) && sel.tul && sel.thumb, 'list click selects: marker highlighted, panel with tulip editor and satellite thumbnail');
  // marker click -> list
  await ev(() => { const E = RoadbookEditor.E; const b = E.rb.boxes.filter(x => !x.deleted)[30]; window.__m = b.id; document.querySelectorAll('.leaflet-marker-icon .bx').forEach(el => { if (el.textContent === String(b.n)) el.parentElement.dispatchEvent(new MouseEvent('click', { bubbles: true })); }); });
  ok(await ev(() => RoadbookEditor.E.sel === window.__m && document.querySelector('#list .row.sel .n').textContent === '31'), 'map marker click selects the list row');
  // --- edits
  const target = await ev(() => RoadbookEditor.E.rb.boxes.filter(b => !b.deleted && !b.waypoint)[14].id);
  await ev(id => RoadbookEditor.select(id), target);
  await page.$eval('#notes', el => { el.value = 'keep left of the big dune, soft'; el.dispatchEvent(new Event('change')); });
  await page.click('#panel [data-dng="2"]');
  await page.click('#p-pal'); await page.click('#pal [data-add="soft_sand"]');
  // drag the exit arrow of the tulip to the right (~ +90)
  await page.$eval('#tulip-ed', el => el.scrollIntoView({ block: 'center' }));
  const box = await (await page.$('#tulip-ed')).boundingBox();
  const hx = await page.$eval('#tulip-ed circle[data-h=x]', c => [+c.getAttribute('cx'), +c.getAttribute('cy')]);
  await page.mouse.move(box.x + hx[0] / 120 * box.width, box.y + hx[1] / 120 * box.height); await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.97, box.y + box.height * 0.52, { steps: 6 }); await page.mouse.up();
  await page.click('#br-add');
  let b = await ev(id => RoadbookEditor.E.rb.boxes.find(x => x.id === id), target);
  ok(b.notes === 'KEEP LEFT OF THE BIG DUNE, SOFT' && b.danger === 2 && b.symbols.includes('soft_sand'), 'notes (upper case), danger, symbol from the palette');
  ok(Math.abs(b.tulip.exit.angle - 90) <= 15 && b.tulip.branches.length >= 1, 'tulip: exit arrow dragged to ' + b.tulip.exit.angle + ', side road added');
  // a junction complex (0.3): "+ junction" adds an earlier node; the drawing is a path with the distance; edit, remove
  await page.click('#br-pre'); await H.sleep(150);
  b = await ev(id => RoadbookEditor.E.rb.boxes.find(x => x.id === id), target);
  let tp = await ev(() => ({ txt: Array.from(document.querySelectorAll('#tulip-ed text')).map(t => t.textContent), rows: document.querySelectorAll('[data-pa]').length, arrows: document.querySelectorAll('#tulip-ed polygon').length }));
  ok(Array.isArray(b.tulip.pre) && b.tulip.pre.length === 1 && b.tulip.at === 80 && tp.rows === 1 && tp.txt.includes('80') && tp.arrows === 1, 'tulip: + junction makes a two-node path (' + JSON.stringify(tp) + ')');
  await page.$eval('[data-pt="0"]', el => { el.value = '-90'; el.dispatchEvent(new Event('change')); }); await H.sleep(150);
  b = await ev(id => RoadbookEditor.E.rb.boxes.find(x => x.id === id), target);
  ok(b.tulip.pre[0].angle === -90, 'tulip: earlier junction turn edited');
  await page.click('[data-pd="0"]'); await H.sleep(150);
  b = await ev(id => RoadbookEditor.E.rb.boxes.find(x => x.id === id), target);
  ok(!b.tulip.pre && Math.abs(b.tulip.exit.angle - 90) <= 15 && await ev(() => !!document.querySelector('#tulip-ed circle[data-h=x]')), 'tulip: removing it gives the plain editable tulip back');
  ok(b.pinned && b.sources.includes('editor') && b.rev >= 5 && b.history.length >= 4, 'edited box pinned, provenance editor, rev ' + b.rev);
  await ev(id => RoadbookEditor.select(id, { pan: true }), target);
  await page.$eval('#panel', el => el.parentElement.scrollTop = 0);
  await H.waitFor(page, () => { const i = Array.from(document.querySelectorAll('.thumb img')); return i.length && i.every(x => x.complete); }, null, 20000).catch(() => {});
  await H.sleep(1500);
  await page.screenshot({ path: H.ROOT + '/roadbook_editor.png' });
  // move along the route by km -> lat/lon follow, renumbered
  const before = b.km;
  await ev(id => RoadbookEditor.moveBoxKm(id, RoadbookEditor.E.rb.boxes.find(x => x.id === id).km + 0.25), target);
  b = await ev(id => RoadbookEditor.E.rb.boxes.find(x => x.id === id), target);
  const onRoute = await ev(bb => RoadbookEditor.nearestSample(bb.lat, bb.lon).d, b);
  ok(Math.abs(b.km - before - 0.25) < 0.011 && onRoute < 25, 'km edit moves the box along the line (' + before + ' -> ' + b.km + ', ' + onRoute.toFixed(1) + ' m from the line)');
  // drag a marker on the map: snaps to the route, km recomputed
  const dragId = await ev(() => (a => a[Math.floor(a.length / 2)])(RoadbookEditor.E.rb.boxes.filter(x => !x.deleted && !x.waypoint)).id);
  const d0 = await ev(id => RoadbookEditor.E.rb.boxes.find(x => x.id === id), dragId);
  await ev(id => { const E = RoadbookEditor.E, s = E.S, b = E.rb.boxes.find(x => x.id === id); const t = RoadbookEditor.sampleAtKm(b.km + 0.4); RoadbookEditor.moveBoxTo(id, { lat: t.lat + 0.0003, lng: t.lon + 0.0003 }); }, dragId);
  const d1 = await ev(id => RoadbookEditor.E.rb.boxes.find(x => x.id === id), dragId);
  ok(Math.abs(d1.km - d0.km - 0.4) < 0.08 && d1.history.some(h => h.change === 'moved'), 'dragging a marker snaps it to the route and re-measures km (' + d0.km + ' -> ' + d1.km + ')');
  // split + delete + undo / redo
  const nLive = await ev(() => RoadbookEditor.E.rb.boxes.filter(x => !x.deleted).length);
  await ev(id => RoadbookEditor.splitBox(id), target);
  const added = await ev(() => RoadbookEditor.E.sel);
  ok(await ev(n => RoadbookEditor.E.rb.boxes.filter(x => !x.deleted).length === n + 1, nLive) && /^ed-/.test(added), 'split adds an editor box half way');
  await ev(() => document.querySelector('#p-del').click());
  ok(await ev(id => RoadbookEditor.E.rb.boxes.find(x => x.id === id).deleted === true, added), 'delete leaves a tombstone');
  await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
  ok(await ev(id => !RoadbookEditor.E.rb.boxes.find(x => x.id === id).deleted, added), 'Ctrl+Z undoes the delete');
  await ev(() => RoadbookEditor.redo());
  ok(await ev(id => RoadbookEditor.E.rb.boxes.find(x => x.id === id).deleted === true, added), 'redo');
  // delete an auto box (tombstone must survive regenerate)
  // FIM abbreviations: click inserts into the notes; palette search; symbol legend panel
  await ev(id => RoadbookEditor.select(id), target);
  await page.$eval('#notes', el => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
  await page.click('#panel [data-ab="kpL"]');
  b = await ev(id => RoadbookEditor.E.rb.boxes.find(x => x.id === id), target);
  ok(/SOFT kpL$/.test(b.notes), 'abbreviation chip inserts into the notes: ' + b.notes);
  await page.$eval('#notes', el => { el.value = 'keep left of the big dune, soft'; el.dispatchEvent(new Event('change')); });
  await page.click('#p-pal'); await page.type('#pal .pf', 'palm');
  const found = await ev(() => Array.from(document.querySelectorAll('#pal [data-add]')).map(x => x.dataset.add));
  ok(found.length === 1 && found[0] === 'palm_tree', 'palette search finds palm tree: ' + found.join(','));
  await ev(() => { RoadbookEditor.E.palFilter = ''; });
  await page.click('#b-legend');
  const lg = await ev(() => ({ open: !document.querySelector('#legend').hidden, n: document.querySelectorAll('#lg-body .lg-i svg').length, txt: document.querySelector('#lg-body').textContent }));
  ok(lg.open && lg.n >= 95 && /Fence with cattle gate/.test(lg.txt) && /Keep straight/.test(lg.txt), 'symbol legend panel: ' + lg.n + ' entries');
  await page.screenshot({ path: H.ROOT + '/roadbook_editor_legend.png' });
  await page.keyboard.press('Escape');
  ok(await ev(() => document.querySelector('#legend').hidden), 'Esc closes the legend');
  const delAuto = await ev(() => RoadbookEditor.E.rb.boxes.filter(x => !x.deleted && !x.waypoint && x.source !== 'editor')[22]);
  await ev(id => { RoadbookEditor.select(id); document.querySelector('#p-del').click(); }, delAuto.id);
  // strip view
  await page.click('.tabs [data-view=strip]');
  await ev(id => RoadbookEditor.select(id), target);
  ok(await ev(() => !!document.querySelector('#list.strip tr.sel svg')), 'strip view with the selected box highlighted');
  await page.screenshot({ path: H.ROOT + '/roadbook_editor_strip.png' });
  await page.click('.tabs [data-view=list]');
  // --- regenerate, keep edits
  const nb = await ev(() => RoadbookEditor.E.rb.boxes.length);
  await ev(() => RoadbookEditor.generate(true));
  const m = await ev(a => { const E = RoadbookEditor.E; return { t: E.rb.boxes.find(x => x.id === a.target), del: E.rb.boxes.find(x => x.autoKey === a.key), banner: document.querySelector('#banners').textContent }; }, { target, key: delAuto.autoKey });
  ok(m.t && m.t.notes === 'KEEP LEFT OF THE BIG DUNE, SOFT' && m.t.danger === 2 && m.t.symbols.includes('soft_sand'), 'regenerate keeps the edited box');
  ok(m.del && m.del.deleted, 'regenerate keeps the deleted box deleted (no duplicate auto box)');
  ok(/Regenerated/.test(m.banner), 'merge reported');
  // --- the off-piste line: re-plan one leg with a new variation
  const legKey = await ev(() => { const l = RoadbookEditor.E.rb.route.legs.find(x => x.planned && x.km > 8); return l.from + '>' + l.to; });
  const pts0 = await ev(k => JSON.stringify(RoadbookEditor.E.rb.route.legs.find(l => l.from + '>' + l.to === k).points), legKey);
  const others0 = await ev(k => JSON.stringify(RoadbookEditor.E.rb.route.legs.filter(l => l.from + '>' + l.to !== k).map(l => l.points)), legKey);
  await ev(k => RoadbookEditor.selectLeg(k), legKey);
  ok(await ev(() => /Off-piste leg/.test(document.querySelector('#panel h3').textContent)), 'clicking the line opens the leg panel');
  await ev(() => document.querySelector('#l-seed').click());
  await H.waitFor(page, () => !RoadbookEditor.E.busy, null, 120000); await H.sleep(300);
  const pts1 = await ev(k => JSON.stringify(RoadbookEditor.E.rb.route.legs.find(l => l.from + '>' + l.to === k).points), legKey);
  const others1 = await ev(k => JSON.stringify(RoadbookEditor.E.rb.route.legs.filter(l => l.from + '>' + l.to !== k).map(l => l.points)), legKey);
  ok(pts1 !== pts0 && others1 === others0, 'new variation re-plans only that leg');
  ok(await ev(t => { const b = RoadbookEditor.E.rb.boxes.find(x => x.id === t); return b && b.notes === 'KEEP LEFT OF THE BIG DUNE, SOFT'; }, target), 'edited box survives the re-plan');
  // --- draw the line by hand: drag a vertex, apply
  await ev(k => { RoadbookEditor.selectLeg(k); document.querySelector('#edit-line').checked = true; document.querySelector('#edit-line').dispatchEvent(new Event('change')); }, legKey);
  const vt = await page.$$('.vtx:not(.ghost)');
  ok(vt.length > 2, 'vertex handles shown (' + vt.length + ')');
  const vb = await vt[1].boundingBox();
  await page.mouse.move(vb.x + 6, vb.y + 6); await page.mouse.down(); await page.mouse.move(vb.x + 60, vb.y - 40, { steps: 8 }); await page.mouse.up();
  await H.sleep(200);
  await page.screenshot({ path: H.ROOT + '/roadbook_editor_line.png' });
  ok(await ev(k => !!(RoadbookEditor.E.rb.editor.lineOverrides || {})[k] && !document.querySelector('#l-apply').disabled, legKey), 'dragging a vertex stores a hand-drawn line');
  await ev(() => document.querySelector('#l-apply').click());
  await H.waitFor(page, () => !RoadbookEditor.E.busy, null, 120000); await H.sleep(300);
  ok(await ev(k => RoadbookEditor.E.rb.route.legs.find(l => l.from + '>' + l.to === k).edited === true, legKey), 'regenerated on the hand-drawn line');
  await ev(() => { document.querySelector('#edit-line').checked = false; RoadbookEditor.E.leg = null; RoadbookEditor.refresh(); });
  // --- save
  const file = await ev(() => RoadbookEditor.roadbookFile());
  fs.writeFileSync(H.ROOT + '/roadbook/preview/' + ID + '.edited.roadbook.json', JSON.stringify(file, null, 1));
  ok(file.format === 'rallyraid-roadbook' && file.editor && file.editor.lineOverrides && file.boxes.some(b => b.source === 'editor'), 'saved file has the edits, line overrides and provenance');
  // --- autosave + reload restores
  await H.sleep(800);
  await page.reload({ waitUntil: 'networkidle2' });
  await H.waitFor(page, () => window.RoadbookEditor && RoadbookEditor.E.rb);
  ok(await ev(t => !!RoadbookEditor.E.rb.boxes.find(x => x.id === t && x.notes === 'KEEP LEFT OF THE BIG DUNE, SOFT') && /Restored/.test(document.querySelector('#banners').textContent), target), 'autosaved in the browser and restored on reload');
  // --- stage changed -> warning
  await ev(async () => { const st = JSON.parse(JSON.stringify(RoadbookEditor.E.stage)); st.waypoints[2].lat += 0.003; const rb = RoadbookEditor.E.rb; await RoadbookEditor.loadStage(st, 'test'); RoadbookEditor.setRoadbook(rb); });
  ok(await ev(() => /stage has changed/.test(document.querySelector('#banners').textContent)), 'stage hash mismatch warned');
  await page.reload({ waitUntil: 'networkidle2' });
  await H.waitFor(page, () => window.RoadbookEditor && RoadbookEditor.E.rb);
  // --- PDFs
  for (const f of ['a5', 'roll']) {
    const b64 = await ev(async f => { const doc = await RoadbookEditor.makePDF(f); return doc.output('datauristring').split(',')[1]; }, f);
    const out = H.ROOT + '/roadbook/preview/' + ID + '_roadbook_' + f + '.pdf';
    fs.writeFileSync(out, Buffer.from(b64, 'base64'));
    const info = execSync('pdfinfo ' + out).toString(), pages = +(/Pages:\s+(\d+)/.exec(info) || [])[1], size = (/Page size:\s+([\d.]+) x ([\d.]+)/.exec(info) || []);
    const txt = execSync('pdftotext -layout ' + out + ' -').toString();
    ok(pages >= (f === 'a5' ? 5 : 2) && /CAP \d{3}/.test(txt) && /KEEP LEFT OF THE BIG DUNE/.test(txt) && Math.abs(+size[1] - 419.5) < 1, f + ' PDF: ' + pages + ' pages, ' + size[1] + ' x ' + size[2] + ' pt, ' + (fs.statSync(out).size / 1024).toFixed(0) + ' kB -> ' + out);
  }
  ok(stats.errors.length === 0, 'no page errors ' + JSON.stringify(stats.errors.slice(0, 3)));
  await browser.close(); srv.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASS'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
