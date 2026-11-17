// B10 rally tools and the compiled event (no network): allowance rule, rally file checks, chained stages (continuity,
// junctions, parts), SS km within +-10 % of the published km, published day totals, roadbooks on long stages,
// landmarks on the line, no-go areas, site and mod copies identical, the calendar file, no marks in file names.
// node --test tests/rally.test.js     (after tools/rally-batch.js and tools/rally-compile.js)
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const L = require('../tools/lib/rally-lib.js');
const SC = require('../stage-builder/stage-chain.js')(require('../stage-builder/stagegen-core.js')(require('../stage-builder/roadbook-gen.js')), require('../stage-builder/roadbook-gen.js'));
const ROOT = path.join(__dirname, '..');
const ID = 'atlantic-to-atlas-2027';
const SITE = path.join(ROOT, 'stage-builder', 'rallies'), MOD = path.join(ROOT, 'mod', 'rallyraid', 'rallies');
const SPEC = L.loadJson(path.join(ROOT, 'rallies', 'specs', ID + '.spec.json'));
const RALLY_F = path.join(SITE, ID + '.rally.json');
const have = fs.existsSync(RALLY_F);
const rally = have ? L.loadJson(RALLY_F) : null;
const stageOf = d => L.loadJson(path.join(SITE, d.stage.file));
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const DISC = 'Inspired by the 2027 Dakar route. Unofficial, not affiliated.';

test('liaison allowance: km at 60 km/h + 30 min, rounded up to 5 min', () => {
  assert.equal(L.allowanceMin(590), 620); assert.equal(L.allowanceMin(50), 80); assert.equal(L.allowanceMin(140), 170);
  assert.equal(L.allowanceMin(200), 230); assert.equal(L.allowanceMin(520), 550); assert.equal(L.allowanceMin(1), 35); assert.equal(L.allowanceMin(0), 0);
  assert.equal(L.allowanceMin(100, { kmh: 50, extraMin: 15, roundMin: 10 }), 140);
});

test('rally file checks catch the mistakes that matter', () => {
  const ok = { format: L.FORMAT, schemaVersion: 1, id: 'x-2027', name: 'X 2027', disclaimer: DISC,
    bivouacs: [{ id: 'a', name: 'A', lat: 1, lon: 1, kind: 'bivouac' }, { id: 'b', name: 'B', lat: 2, lon: 2, kind: 'marathon' }],
    days: [{ n: 1, date: '2027-01-01', type: 'stage', from: 'a', to: 'a', marathon: false, title: 'SS1', stage: { id: 'x-ss1', file: 'x/stages/x-ss1.json', targetKm: 100 }, liaisonOut: { km: 10, allowanceMin: 40 } },
      { n: 2, date: '2027-01-02', type: 'marathon', from: 'a', to: 'b', marathon: true, title: 'SS2', stage: { id: 'x-ss2', file: 'x/stages/x-ss2.json', targetKm: 100 } },
      { n: 3, date: '2027-01-03', type: 'rest', from: 'b', to: 'b', marathon: false, title: 'Rest' }] };
  assert.deepEqual(L.validate(ok), []);
  const bad = (f) => { const r = JSON.parse(JSON.stringify(ok)); f(r); return L.validate(r); };
  assert.ok(bad(r => { r.name = 'Dakar 2027' }).some(e => /mark/.test(e)), 'a mark in the name');
  assert.ok(bad(r => { r.days[0].title = 'SS1 W2RC round' }).some(e => /mark/.test(e)), 'a mark in a title');
  assert.ok(bad(r => { r.disclaimer = 'Unofficial.' }).some(e => /disclaimer/.test(e)), 'the disclaimer line');
  assert.ok(bad(r => { r.days[1].from = 'b' }).some(e => /day before ended/.test(e)), 'day continuity');
  assert.ok(bad(r => { r.days[1].marathon = false }).some(e => /marathon flag/.test(e)), 'marathon flag');
  assert.ok(bad(r => { r.days[2].date = '2027-01-02' }).some(e => /dates must increase/.test(e)), 'dates');
  assert.ok(bad(r => { delete r.days[0].stage }).some(e => /needs stage/.test(e)), 'stage day without a stage');
});

test('chain layout: long stages are cut into parts of at most segMaxKm, short ones stay single', () => {
  const short = SC.layout({ dss: [30, -6], ass: [30.5, -6], lengthKm: 120 }, { segMaxKm: 150, ratio: 1.3 });
  assert.equal(short.segKm.length, 1); assert.ok(short.single);
  const long = SC.layout({ dss: [30, -6], ass: [30.1, -6.1], lengthKm: 450, vias: [[30.8, -6.5], [30.6, -7.6]] }, { segMaxKm: 150, ratio: 1.4 });
  assert.ok(long.segKm.length >= 3 && long.junctions.length === long.segKm.length + 1);
  for (let i = 1; i < long.junctions.length; i++) assert.ok(SC.dist(long.junctions[i - 1], long.junctions[i]) / 1000 <= 150.5, 'part ' + i + ' straight line under segMaxKm');
  for (const k of long.segKm) assert.ok(k <= 200, 'part target ' + k);
  const sum = long.segKm.reduce((a, k) => a + k, 0);
  assert.ok(Math.abs(sum - 450) < 1, 'part targets add up to the stage target: ' + sum);
  assert.deepEqual(long.junctions[0], [30, -6]); assert.deepEqual(long.junctions[long.junctions.length - 1], [30.1, -6.1]);
});

test('event spec: published facts (towns, km), no marks, Saharan stops without a country', () => {
  assert.equal(SPEC.disclaimer, DISC);
  assert.ok(!L.BANNED.test(SPEC.name) && !L.BANNED.test(SPEC.id));
  const ss = SPEC.days.filter(d => d.ssKm > 0);
  assert.equal(ss.length, 13);
  assert.equal(ss.reduce((a, d) => a + d.ssKm, 0), 4341);
  assert.equal(SPEC.days.reduce((a, d) => a + (d.totalKm || 0), 0), 7824);
  for (const d of SPEC.days) if (d.type !== 'rest') assert.equal((d.ssKm || 0) + (d.liaisonOutKm || 0) + (d.liaisonInKm || 0), d.totalKm, 'day ' + d.n + ' liaisons + SS = published total');
  for (const id of ['smara', 'refuge']) assert.ok(!SPEC.bivouacs.find(b => b.id === id).country, id + ' has no country label');
});

test('compiled rally file is valid', { skip: !have && 'not compiled yet' }, () => {
  assert.deepEqual(L.validate(rally), []);
  assert.equal(rally.disclaimer, DISC);
  assert.equal(rally.days.length, 15);
  assert.deepEqual(rally.days.filter(d => d.marathon).map(d => d.code), ['SS8', 'SS9']);
  assert.deepEqual(rally.days.filter(d => d.type === 'rest').map(d => d.date), ['2027-01-17']);
  assert.equal(rally.totals.ssTargetKm, 4341); assert.equal(rally.totals.ssTargetKm + rally.totals.liaisonKm, 7824);
  for (const d of rally.days) for (const k of ['liaisonOut', 'liaisonIn']) if (d[k]) assert.equal(d[k].allowanceMin, L.allowanceMin(d[k].km), d.code + ' ' + k);
  const t = rally.days.find(d => d.type === 'transfer'); assert.equal(t.liaisonOut.ferry, true); assert.equal(t.liaisonOut.drive, false);
});

test('every special stage: within +-10 % of the published km, checks clean, continuous chain', { skip: !have && 'not compiled yet' }, () => {
  for (const d of rally.days.filter(x => x.stage)) {
    const st = stageOf(d);
    const dev = (st.lengthKm - d.stage.targetKm) / d.stage.targetKm;
    assert.ok(Math.abs(dev) <= 0.10, d.code + ': ' + st.lengthKm.toFixed(1) + ' km for ' + d.stage.targetKm + ' (' + (dev * 100).toFixed(1) + '%)');
    assert.deepEqual(L.checkStage(st), [], d.code);
    const ch = st.builder && st.builder.stagegen && st.builder.stagegen.chain;
    const parts = ch ? ch.segments.length : 1;
    assert.equal(parts, d.stage.parts);
    if (d.stage.targetKm > 204) assert.ok(parts >= 2, d.code + ' over the single-run cap must be chained');
    if (ch) {
      const J = st.waypoints.filter(w => /^Junction \d+$/.test(w.name || ''));
      assert.equal(J.length, parts - 1, d.code + ' one junction between parts');
      let acc = 0;
      ch.segments.slice(0, -1).forEach((s, i) => { acc += s.km; assert.ok(Math.abs(J[i].km - acc) < 0.05, d.code + ' junction ' + (i + 1) + ' at ' + J[i].km + ' vs ' + acc.toFixed(3)); });
      assert.ok(Math.abs(ch.segments.reduce((a, s) => a + s.km, 0) - st.lengthKm) < 0.05, d.code + ' parts add up');
    }
    assert.ok(Math.abs(st.waypoints[0].lat - d.stage.dss.lat) < 1e-9 && st.waypoints[0].type === 'DSS');
    assert.ok(!L.BANNED.test(st.name) && !L.BANNED.test(st.id), d.code + ' stage name');
  }
});

test('roadbooks: every stage has one, covering the whole stage, also the long ones', { skip: !have && 'not compiled yet' }, () => {
  for (const d of rally.days.filter(x => x.stage)) {
    assert.ok(d.stage.roadbook, d.code + ' roadbook listed');
    const rb = L.loadJson(path.join(SITE, d.stage.roadbook));
    const st = stageOf(d);
    const B = rb.boxes;
    assert.equal(rb.format, 'rallyraid-roadbook');
    assert.ok(B.length >= 10, d.code + ' boxes ' + B.length);
    assert.ok(Math.abs(B[B.length - 1].km - st.lengthKm) <= Math.max(0.5, st.lengthKm * 0.005), d.code + ' last box at the ASS: ' + B[B.length - 1].km + ' / ' + st.lengthKm);
    for (let i = 1; i < B.length; i++) assert.ok(B[i].km >= B[i - 1].km, d.code + ' box km order at ' + i);
    let gap = 0; for (let i = 1; i < B.length; i++) gap = Math.max(gap, B[i].km - B[i - 1].km);
    assert.ok(gap <= 40, d.code + ' longest gap between boxes ' + gap.toFixed(1) + ' km');
    if (st.lengthKm > 300) assert.ok(B.length >= st.lengthKm / 8, d.code + ' long stage: ' + B.length + ' boxes for ' + st.lengthKm.toFixed(0) + ' km');
  }
});

test('landmarks are real (OSM) and on the stage line', { skip: !have && 'not compiled yet' }, () => {
  for (const l of rally.landmarks) assert.ok(/^(way|node|relation)\/\d+$|Nominatim/.test(l.osm), l.id + ' source ' + l.osm);
  for (const d of rally.days.filter(x => x.stage && x.stage.landmarks.length)) {
    const st = stageOf(d);
    for (const id of d.stage.landmarks) {
      const l = rally.landmarks.find(x => x.id === id);
      let best = Infinity; for (const leg of st.route.legs) for (const p of leg.points) best = Math.min(best, L.dist(p, [l.lat, l.lon]));
      assert.ok(best < 5000, d.code + ' passes within 5 km of ' + l.name + ' (' + (best / 1000).toFixed(1) + ' km)');
    }
  }
});

test('no stage line enters a no-go area (Algerian side, border strip, berm)', { skip: !have && 'not compiled yet' }, () => {
  const A = L.loadJson(path.join(ROOT, SPEC.generation.avoid)).polygons;
  const box = A.map(p => { let a = 90, b = -90, c = 180, e = -180; for (const q of p.polygon) { a = Math.min(a, q[0]); b = Math.max(b, q[0]); c = Math.min(c, q[1]); e = Math.max(e, q[1]); } return [a, b, c, e]; });
  const inside = (pt, poly) => { let o = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [yi, xi] = poly[i], [yj, xj] = poly[j]; if ((yi > pt[0]) !== (yj > pt[0]) && pt[1] < (xj - xi) * (pt[0] - yi) / (yj - yi) + xi) o = !o; } return o; };
  for (const d of rally.days.filter(x => x.stage)) {
    const st = stageOf(d); let hits = 0;
    // Algeria and the berm: never. The 15 km strip: Stage-Gen blocks it per grid cell (~200 m), so a point may sit at its inner
    // edge; it must still be at least 14 km from the Algerian side (seen once: SS4, 14.8 km).
    for (const leg of st.route.legs) for (const p of leg.points) A.forEach((poly, k) => { const b = box[k]; if (p[0] >= b[0] && p[0] <= b[1] && p[1] >= b[2] && p[1] <= b[3] && inside(p, poly.polygon)) {
      if (!/strip/.test(poly.name)) hits++;
      else { let m = Infinity; for (const v of A[0].polygon) m = Math.min(m, L.dist(p, v)); if (m < 14000) hits++; }
    } });
    assert.equal(hits, 0, d.code + ' points in no-go areas');
  }
});

test('the mod gets the same rally and stage files as the website', { skip: !have && 'not compiled yet' }, () => {
  assert.equal(sha(path.join(MOD, ID + '.rally.json')), sha(RALLY_F));
  for (const d of rally.days.filter(x => x.stage)) for (const f of [d.stage.file, d.stage.roadbook]) assert.equal(sha(path.join(MOD, f)), sha(path.join(SITE, f)), f);
  for (const dir of [SITE, MOD]) for (const f of fs.readdirSync(path.join(dir, ID, 'stages'))) assert.ok(!L.BANNED.test(f), 'file name ' + f);
});

test('calendar file', () => {
  const c = L.loadJson(path.join(ROOT, 'stage-builder', 'calendar.json'));
  assert.deepEqual(c, L.loadJson(path.join(ROOT, 'rallies', 'calendar.json')));
  assert.equal(c.format, 'rallyraid-calendar'); assert.equal(c.schemaVersion, 1);
  assert.equal(c.rounds.length, 5);
  assert.ok(!L.BANNED.test(c.name) && c.rounds.every(r => !L.BANNED.test(r.name)), 'no marks in names');
  const ready = c.rounds.filter(r => r.status === 'ready');
  assert.equal(ready.length, 1); assert.equal(ready[0].disclaimer, DISC);
  if (have) assert.ok(fs.existsSync(path.join(ROOT, 'stage-builder', ready[0].rally)));
  for (let i = 1; i < c.rounds.length; i++) assert.ok(c.rounds[i].start > c.rounds[i - 1].end);
});
