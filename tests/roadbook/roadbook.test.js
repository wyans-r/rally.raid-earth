// Roadbook generator tests (no network): node --test tests/roadbook/
const test = require('node:test'), assert = require('node:assert');
const RB = require('../../stage-builder/roadbook-gen.js');
const R = require('../../stage-builder/roadbook-render.js');
const { dest, dist } = RB.geo;

// a straight stage from P0 heading `brg` for `km`, one leg, mode
function line(km, brg, mode, p0) {
  p0 = p0 || [-20, 13];
  const p1 = dest(p0, brg, km * 1000);
  return { format: 'rallyraid-stage', schemaVersion: 1, id: 't', name: 'T',
    waypoints: [{ id: 'a', n: 0, type: 'DSS', lat: p0[0], lon: p0[1], km: 0 }, { id: 'b', n: 1, type: 'ASS', lat: p1[0], lon: p1[1], km }],
    route: { legs: [{ from: 'a', to: 'b', mode, km, points: [p0, p1] }] } };
}
// heights as a function of distance (m) from the start of a line stage
const along = (stage, f) => (lat, lon) => {
  const p0 = [stage.waypoints[0].lat, stage.waypoints[0].lon], p1 = [stage.waypoints[1].lat, stage.waypoints[1].lon];
  const brg = RB.geo.bearing(p0, p1), d = dist(p0, [lat, lon]), a = RB.geo.bearing(p0, [lat, lon]);
  return f(d * Math.cos((a - brg) * Math.PI / 180), d * Math.sin((a - brg) * Math.PI / 180));
};
// the detection tests check features on the plotted line itself, so the off-piste planner is off unless asked for
const gen = (stage, hf, extra) => RB.generate(stage, Object.assign({ heightFn: hf, useOsm: false, planOffPiste: false }, extra || {}));
const kinds = rb => rb.boxes.flatMap(b => b.features.map(f => f.kind));

test('resampled km follow the stage km (leg scaled)', () => {
  const st = line(10, 30, 'direct'); st.route.legs[0].km = 10.5; st.waypoints[1].km = 10.5;
  const S = RB.resampleRoute(st, 20);
  assert.ok(Math.abs(S[S.length - 1].km - 10.5) < 1e-9);
  assert.ok(Math.abs(S[1].d - 20) < 0.1);
});

test('flat off-piste: nothing happens, so only a CAP filler where the gap would pass maxGapKm (25 / density)', async () => {
  const st = line(20, 45, 'direct');
  const rb = await gen(st, () => 100, { density: 10 });
  const per10 = rb.stats.per10km.offPiste;
  assert.ok(per10 >= 2 && per10 <= 5, 'per10 ' + per10);
  for (let i = 1; i < rb.boxes.length; i++) assert.ok(rb.boxes[i].partial <= 4.05, 'gap ' + rb.boxes[i].partial);
  assert.ok(rb.boxes.every(b => b.danger === 0));
  assert.match(rb.boxes[1].notes, /^CAP 045, FLAT, FAST/);
  assert.strictEqual(rb.boxes[0].label, 'DSS'); assert.strictEqual(rb.boxes.at(-1).label, 'ASS');
  for (let i = 1; i < rb.boxes.length; i++) assert.ok(Math.abs(rb.boxes[i].partial - (rb.boxes[i].km - rb.boxes[i - 1].km)) < 0.011);
});

test('density setting changes the off-piste box count', async () => {
  const st = line(20, 45, 'direct');
  const lo = await gen(st, () => 100, { density: 5 }), hi = await gen(st, () => 100, { density: 20 });
  assert.ok(hi.boxes.length > lo.boxes.length * 2, lo.boxes.length + ' vs ' + hi.boxes.length);
});

test('a sharp hill top is a blind crest, a steep descent is graded', async () => {
  const st = line(6, 0, 'direct');
  // ramp up 25% from 2000 to 2100 m, then down 25% to 2200 m (25 m high, sharp top)
  const hf = along(st, x => x < 2000 ? 0 : x < 2100 ? (x - 2000) * 0.25 : x < 2200 ? 25 - (x - 2100) * 0.25 : 0);
  const rb = await gen(st, hf);
  const crest = rb.boxes.find(b => b.features.some(f => f.kind === 'crest'));
  assert.ok(crest, kinds(rb).join(','));
  assert.ok(Math.abs(crest.km - 2.1) < 0.08, 'crest at ' + crest.km);
  assert.ok(crest.danger >= 2 && /BLIND CREST/.test(crest.notes));
  assert.strictEqual(crest.source, 'auto-dem');
});

test('long steep descent: grade and length in the note', async () => {
  const st = line(6, 0, 'direct');
  const hf = along(st, x => x < 2000 ? 200 : x < 2400 ? 200 - (x - 2000) * 0.2 : 120);
  const rb = await gen(st, hf);
  const d = rb.boxes.find(b => b.features.some(f => f.kind === 'descent'));
  assert.ok(d, kinds(rb).join(','));
  const f = d.features.find(f => f.kind === 'descent');
  assert.ok(f.grade >= 15 && f.grade <= 22, 'grade ' + f.grade);
  assert.ok(f.len >= 300 && f.len <= 480, 'len ' + f.len);
  assert.ok(d.danger >= 1);
  assert.match(d.notes, /DESC\. \d+%, \d+ M/);
});

test('a V-shaped gully across the line is a wadi', async () => {
  const st = line(5, 0, 'direct');
  const hf = along(st, x => -Math.max(0, 8 - Math.abs(x - 2500) * 0.12));
  const rb = await gen(st, hf);
  const w = rb.boxes.find(b => b.features.some(f => f.kind === 'wadi'));
  assert.ok(w, kinds(rb).join(','));
  assert.ok(Math.abs(w.km - 2.5) < 0.1);
});

test('repeated steep short cycles are a dune field with a start and an end', async () => {
  const st = line(10, 0, 'direct');
  const hf = along(st, x => (x > 3000 && x < 6000) ? 8 * (1 - Math.cos(2 * Math.PI * (x - 3000) / 200)) : 0);
  const rb = await gen(st, hf);
  const ds = rb.boxes.find(b => b.symbols.includes('dunes')), de = rb.boxes.find(b => b.symbols.includes('dunes_end'));
  assert.ok(ds && de, kinds(rb).join(','));
  assert.ok(ds.km > 2.8 && ds.km < 3.5 && de.km > 5.5 && de.km < 6.2, ds.km + ' ' + de.km);
  const f = ds.features.find(f => f.kind === 'dunes');
  assert.strictEqual(f.size, 'medium'); // 16 m peak to trough
});

test('side slope is found from the cross-section and its side', async () => {
  const st = line(4, 0, 'direct');
  const hf = along(st, (x, y) => (x > 1000 && x < 2000) ? -y * 0.25 : 0); // y + = right of travel: right side lower
  const rb = await gen(st, hf);
  const s = rb.boxes.find(b => b.features.some(f => f.kind === 'sideslope'));
  assert.ok(s, kinds(rb).join(','));
  assert.ok(s.symbols.includes('sideslope_r'));
  assert.match(s.notes, /SIDE SLOPE \d+%, DROPS R/);
});

// --- OSM: a synthetic road network
function osmFor(nodesLL, ways, extraNodes) {
  return { elements: ways.map((w, i) => ({ type: 'way', id: 100 + i, tags: w.tags, nodes: w.nodes, geometry: w.nodes.map(n => ({ lat: nodesLL[n][0], lon: nodesLL[n][1] })) })).concat(extraNodes || []) };
}
test('T junction: TURN RIGHT, with the side road in the tulip', async () => {
  const A = [-20, 13], J = dest(A, 0, 2000), E = dest(J, 90, 2000), W = dest(J, 270, 1500);
  const st = { id: 't', name: 'T', waypoints: [{ id: 'a', type: 'DSS', lat: A[0], lon: A[1], km: 0 }, { id: 'b', type: 'ASS', lat: E[0], lon: E[1], km: 4 }],
    route: { legs: [{ from: 'a', to: 'b', mode: 'road', km: 4, points: [A, J, E] }] } };
  const osm = osmFor({ 1: A, 2: J, 3: E, 4: W }, [
    { tags: { highway: 'unclassified', surface: 'gravel' }, nodes: [1, 2] },
    { tags: { highway: 'track', tracktype: 'grade3', name: 'East' }, nodes: [4, 2, 3] }]);
  const rb = await RB.generate(st, { heightFn: () => 0, osm });
  const j = rb.boxes.find(b => b.features.some(f => f.kind === 'junction'));
  assert.ok(j, kinds(rb).join(','));
  assert.ok(Math.abs(j.km - 2) < 0.05);
  assert.match(j.notes, /TURN R ON P \(EAST\)/);
  assert.ok(Math.abs(j.tulip.exit.angle - 90) < 5);
  assert.strictEqual(j.tulip.branches.length, 1); assert.ok(Math.abs(j.tulip.branches[0].angle + 90) < 5);
  assert.strictEqual(j.tulip.entry.track, 'gravel'); assert.strictEqual(j.tulip.exit.track, 'track');
  assert.strictEqual(j.source, 'auto-osm');
  // surface change gravel -> track noted too
  assert.ok(kinds(rb).includes('surface'));
});

test('Y fork: KEEP LEFT when the other branch goes off to the right', async () => {
  const A = [-20, 13], J = dest(A, 0, 2000), L = dest(J, 340, 2000), Rr = dest(J, 25, 1500);
  const st = { id: 't', name: 'T', waypoints: [{ id: 'a', type: 'DSS', lat: A[0], lon: A[1], km: 0 }, { id: 'b', type: 'ASS', lat: L[0], lon: L[1], km: 4 }],
    route: { legs: [{ from: 'a', to: 'b', mode: 'road', km: 4, points: [A, J, L] }] } };
  const osm = osmFor({ 1: A, 2: J, 3: L, 4: Rr }, [{ tags: { highway: 'track' }, nodes: [1, 2, 3] }, { tags: { highway: 'track', tracktype: 'grade5' }, nodes: [2, 4] }]);
  const rb = await RB.generate(st, { heightFn: () => 0, osm });
  const j = rb.boxes.find(b => b.features.some(f => f.kind === 'junction'));
  assert.ok(j); assert.match(j.notes, /^kpL /); assert.ok(j.symbols.includes('keep_left'));
  assert.strictEqual(j.tulip.branches[0].track, 'twotrack');
});

test('off-piste crossing a track, a fence and a dry river; point hazards on a track', async () => {
  const st = line(6, 0, 'direct'), p0 = [st.waypoints[0].lat, st.waypoints[0].lon];
  const at = (m, side) => [dest(dest(p0, 0, m), 90, side), dest(dest(p0, 0, m), 270, side)];
  const [t1, t2] = at(1500, 500), [f1, f2] = at(3000, 500), [r1, r2] = at(4500, 500);
  const osm = osmFor({ 1: t1, 2: t2, 3: f1, 4: f2, 5: r1, 6: r2 }, [
    { tags: { highway: 'track', name: 'Old Pad' }, nodes: [1, 2] },
    { tags: { barrier: 'fence' }, nodes: [3, 4] },
    { tags: { waterway: 'river', intermittent: 'yes', name: 'Uniab' }, nodes: [5, 6] }]);
  const rb = await RB.generate(st, { heightFn: () => 0, osm, planOffPiste: false, density: 10 });
  const find = k => rb.boxes.find(b => b.features.some(f => f.kind === k));
  assert.ok(Math.abs(find('cross_road').km - 1.5) < 0.05); assert.match(find('cross_road').notes, /CROSS P \(OLD PAD\)/);
  assert.ok(find('cross_fence').danger === 2);
  assert.match(find('cross_water').notes, /CROSS WADI \(UNIAB\)/);
  assert.ok(find('cross_road').tulip.branches.some(b => b.cross));
});

test('a line running alongside the route is not a crossing', async () => {
  const st = line(6, 0, 'road'), p0 = [st.waypoints[0].lat, st.waypoints[0].lon];
  // an old railway zig-zagging +-3 m around the route
  const pts = {}; const ids = [];
  for (let k = 0; k <= 60; k++) { pts[k + 1] = dest(dest(p0, 0, k * 100), 90, k % 2 ? 3 : -3); ids.push(k + 1); }
  const osm = osmFor(pts, [{ tags: { railway: 'abandoned' }, nodes: ids }]);
  const rb = await RB.generate(st, { heightFn: () => 0, osm });
  assert.ok(!kinds(rb).includes('cross_railway'), kinds(rb).join(','));
});

test('stage hash: stable, and changes with the route', async () => {
  const a = line(5, 10, 'direct'), b = line(5, 10, 'direct');
  assert.strictEqual(await RB.stageHash(a), await RB.stageHash(b));
  b.waypoints[1].lat += 0.001;
  assert.notStrictEqual(await RB.stageHash(a), await RB.stageHash(b));
});

test('provenance fields on every box', async () => {
  const rb = await gen(line(5, 0, 'direct'), () => 0);
  for (const b of rb.boxes) {
    assert.ok(['auto-dem', 'auto-osm', 'auto-route'].includes(b.source));
    assert.strictEqual(b.pinned, false); assert.strictEqual(b.verified, false); assert.strictEqual(b.rev, 1);
    assert.ok(Array.isArray(b.history) && b.autoKey);
    assert.ok(Number.isFinite(b.lat) && Number.isFinite(b.lon));
  }
  assert.strictEqual(rb.format, 'rallyraid-roadbook'); assert.strictEqual(rb.revision, 1);
});

test('recce changes: confirm, move, delete, add; conflicts against editor pins', async () => {
  const rb = await gen(line(10, 0, 'direct'), () => 0, { density: 20 });
  const ids = rb.boxes.filter(b => !b.waypoint).map(b => b.id);
  const n0 = rb.boxes.length;
  let r = RB.applyChanges(rb, [
    { op: 'confirm', id: ids[0], baseRev: 1, by: 'recce-manual' },
    { op: 'move', id: ids[1], baseRev: 1, by: 'recce-manual', km: 2.5, lat: 1, lon: 1 },
    { op: 'delete', id: ids[2], baseRev: 1, by: 'recce-manual' },
    { op: 'add', id: 'rc-1', by: 'recce-auto', box: { km: 4.44, lat: -19.96, lon: 13, symbols: ['jump'], danger: 2, notes: 'Jump' } }]);
  assert.strictEqual(r.applied, 4); assert.strictEqual(r.conflicts.length, 0);
  const by = id => rb.boxes.find(b => b.id === id);
  assert.ok(by(ids[0]).verified && !by(ids[0]).pinned && by(ids[0]).rev === 2);
  assert.ok(by(ids[1]).pinned && by(ids[1]).km === 2.5);
  assert.ok(by(ids[2]).deleted && by(ids[2]).n === null);
  assert.ok(by('rc-1').source === 'recce-auto' && !by('rc-1').verified);
  assert.strictEqual(rb.boxes.filter(b => !b.deleted).length, n0);
  // the editor pins a box; an older recce change to it is a conflict
  RB.applyChanges(rb, [{ op: 'update', id: ids[3], baseRev: 1, by: 'editor', fields: { notes: 'desk note' } }]);
  r = RB.applyChanges(rb, [{ op: 'update', id: ids[3], baseRev: 1, by: 'recce-manual', fields: { notes: 'recce note' } }]);
  assert.strictEqual(r.conflicts.length, 1); assert.strictEqual(by(ids[3]).notes, 'desk note');
  assert.strictEqual(rb.conflicts.length, 1);
});

test('regenerate keeps human work, drops untouched auto boxes, honours tombstones', async () => {
  const st = line(10, 0, 'direct');
  const old = await gen(st, () => 0, { density: 20 });
  const auto = old.boxes.filter(b => !b.waypoint);
  RB.applyChanges(old, [
    { op: 'update', id: auto[0].id, baseRev: 1, by: 'editor', fields: { notes: 'KEEP ME' } },
    { op: 'delete', id: auto[1].id, baseRev: 1, by: 'recce-manual' },
    { op: 'add', id: 'rc-9', by: 'recce-manual', box: { km: 7.77, lat: 0, lon: 0, notes: 'rock step', symbols: ['step'] } }]);
  const fresh = await gen(st, () => 0, { density: 20 });
  const m = RB.mergeRegenerated(old, fresh, st);
  assert.ok(m.boxes.some(b => b.notes === 'KEEP ME'));
  assert.ok(m.boxes.some(b => b.id === 'rc-9'));
  const tomb = m.boxes.find(b => b.id === auto[1].id); assert.ok(tomb && tomb.deleted);
  // the deleted auto box did not come back as a fresh live box at the same place
  assert.ok(!m.boxes.some(b => !b.deleted && b.autoKey === auto[1].autoKey));
  assert.strictEqual(m.revision, old.revision + 1);
  // numbering is continuous over live boxes
  const live = m.boxes.filter(b => !b.deleted); live.forEach((b, i) => assert.strictEqual(b.n, i + 1));
});

test('regenerate after a route change re-measures kept boxes from lat/lon', async () => {
  const st = line(10, 0, 'direct');
  const old = await gen(st, () => 0, { density: 20 });
  const b = old.boxes.find(x => !x.waypoint);
  RB.applyChanges(old, [{ op: 'update', id: b.id, baseRev: 1, by: 'editor', fields: { notes: 'pinned' } }]);
  // new stage starts 1 km earlier: same box should now be 1 km further
  const p0 = dest([st.waypoints[0].lat, st.waypoints[0].lon], 180, 1000), st2 = line(11, 0, 'direct', p0);
  const fresh = await gen(st2, () => 0, { density: 20 });
  const m = RB.mergeRegenerated(old, fresh, st2);
  const k = m.boxes.find(x => x.id === b.id);
  assert.ok(Math.abs(k.km - (b.km + 1)) < 0.03, b.km + ' -> ' + k.km);
  assert.ok(!k.orphan);
});

test('renderer: tulip and symbols are SVG, strip has one row per live box', async () => {
  const rb = await gen(line(5, 0, 'direct'), () => 0);
  assert.match(R.tulipSVG(rb.boxes[1].tulip), /^<svg[\s\S]*<\/svg>$/);
  for (const c of R.ICONS.concat(['WPM', 'speed_30', 'whatever'])) assert.match(R.symbolSVG(c), /<svg/);
  const html = R.stripHTML(rb, 0, 100);
  assert.strictEqual((html.match(/<tr /g) || []).length, rb.boxes.length);
});

test('DEM decoding: Terrarium tiles, bilinear', async () => {
  // fake 512 px tile with height = column index (m), via injected fetch / decode
  const dem = RB.createDem({ sources: [{ name: 'fake', url: 'x/{z}/{x}/{y}', size: 512, zoom: 12 }],
    fetchBytes: async () => new ArrayBuffer(1),
    decodeImage: async () => { const d = new Uint8Array(512 * 512 * 4); for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) { const v = x + 32768, i = (y * 512 + x) * 4; d[i] = v >> 8; d[i + 1] = v & 255; d[i + 2] = 0; d[i + 3] = 255; } return { width: 512, height: 512, data: d }; } });
  const lat = -20.05, lon = 13.05;
  await dem.load([[lat, lon]]);
  const n = Math.pow(2, 12) * 512, X = (lon + 180) / 360 * n;
  const expect = (X - 0.5) - Math.floor(X / 512) * 512;
  assert.ok(Math.abs(dem.h(lat, lon) - expect) < 0.01, dem.h(lat, lon) + ' vs ' + expect);
});

// ---------------------------------------------------------------- off-piste line planner
const segs = pts => pts.slice(1).map((p, k) => dist(pts[k], p));
function multi(p0, hops) { // stage with several direct legs: hops = [[bearing, km, type], ...]
  const w = [{ id: 'w0', n: 0, type: 'DSS', lat: p0[0], lon: p0[1], km: 0 }], legs = []; let p = p0, km = 0;
  hops.forEach(([b, k, t], i) => { const q = dest(p, b, k * 1000); km += k; w.push({ id: 'w' + (i + 1), n: i + 1, type: t, lat: q[0], lon: q[1], km, cap: Math.round(b) }); legs.push({ from: 'w' + i, to: 'w' + (i + 1), mode: 'direct', km: k, points: [p, q] }); p = q; });
  return { id: 'multi', name: 'M', waypoints: w, route: { legs } };
}
const VALIDATE = { DSS: 200, WPV: 200, WPM: 90, WPN: 200, WPS: 30, WPC: 300, WPE: 90, ASS: 90 };
// rolling terrain: hills ~600 m across, 25 m high
const hilly = (lat, lon) => 25 * Math.sin(lat * 111320 / 600 * 2 * Math.PI) * Math.cos(lon * 104000 / 700 * 2 * Math.PI);

test('planner: deterministic, and different stages get different lines', () => {
  const st = multi([-20, 13], [[30, 8, 'WPM'], [300, 6, 'ASS']]);
  const a = RB.planOffPiste(st, hilly, [], {}), b = RB.planOffPiste(st, hilly, [], {});
  assert.deepStrictEqual(a.stage.route.legs.map(l => l.points), b.stage.route.legs.map(l => l.points));
  const st2 = JSON.parse(JSON.stringify(st)); st2.id = 'other';
  const c = RB.planOffPiste(st2, () => 0, [], {}), d = RB.planOffPiste(st, () => 0, [], {});
  assert.notDeepStrictEqual(c.stage.route.legs[0].points, d.stage.route.legs[0].points);
});

test('planner: the line passes every waypoint inside its validation radius', () => {
  const st = multi([-20, 13], [[10, 6, 'WPV'], [80, 5, 'WPS'], [200, 7, 'WPM'], [330, 4, 'ASS']]);
  const { stage } = RB.planOffPiste(st, hilly, [], {});
  const line = stage.route.legs.flatMap(l => l.points);
  for (const w of stage.waypoints) {
    const d = Math.min(...line.map(p => dist(p, [w.lat, w.lon])));
    assert.ok(d <= VALIDATE[w.type], w.id + ' ' + d);
  }
  // legs join end to end at the waypoints
  stage.route.legs.forEach((l, i) => { const w = stage.waypoints[i + 1]; assert.deepStrictEqual(l.points.at(-1), [st.waypoints[i + 1].lat, st.waypoints[i + 1].lon]); assert.ok(w.km > stage.waypoints[i].km); });
});

test('planner: no straight run over 2 km in non-flat terrain, and it really bends', () => {
  const st = multi([-20, 13], [[45, 12, 'ASS']]);
  const r = RB.planOffPiste(st, hilly, [], { density: 10 }), pts = r.stage.route.legs[0].points;
  assert.ok(Math.max(...segs(pts)) <= 2000, 'longest ' + Math.max(...segs(pts)));
  assert.ok(pts.length - 2 >= 6, 'bends ' + (pts.length - 2));
  // CAP changes are real (at least 5 deg each) and the line stays plausible (< 20 % longer than straight)
  const len = segs(pts).reduce((x, y) => x + y, 0);
  assert.ok(len < 12000 * 1.2, 'len ' + len);
});

test('planner: a flat pan may run straighter (<= 3 km) but is never one straight line', () => {
  const st = multi([-20, 13], [[300, 10, 'ASS']]);
  const pts = RB.planOffPiste(st, () => 50, [], { density: 10 }).stage.route.legs[0].points;
  assert.ok(pts.length > 2, 'still bends');
  assert.ok(Math.max(...segs(pts)) <= 3100, 'longest ' + Math.max(...segs(pts)));
});

test('planner: goes round a building / wood on the direct line and says so', () => {
  const st = multi([-20, 13], [[0, 6, 'ASS']]), p0 = [-20, 13];
  const c = dest(p0, 0, 3000), sq = (cx, half) => [dest(dest(cx, 0, half), 90, half), dest(dest(cx, 180, half), 90, half), dest(dest(cx, 180, half), 270, half), dest(dest(cx, 0, half), 270, half)];
  const ring = sq(c, 300); ring.push(ring[0]);
  const obst = [{ type: 'way', id: 1, tags: { landuse: 'military' }, geometry: ring.map(p => ({ lat: p[0], lon: p[1] })) }];
  const r = RB.planOffPiste(st, () => 0, obst, {}), leg = r.stage.route.legs[0];
  // densely sample the line: never inside the square
  const P = RB.geo.projector(-20), C = P.xy(c);
  for (let k = 1; k < leg.points.length; k++) for (let t = 0; t <= 1; t += 0.02) {
    const q = P.xy([leg.points[k - 1][0] + (leg.points[k][0] - leg.points[k - 1][0]) * t, leg.points[k - 1][1] + (leg.points[k][1] - leg.points[k - 1][1]) * t]);
    assert.ok(!(Math.abs(q[0] - C[0]) < 290 && Math.abs(q[1] - C[1]) < 290), 'line enters the blocked area');
  }
  assert.ok(leg.vertexInfo.some(v => v && /restricted area/.test(v.reason || '')), JSON.stringify(leg.vertexInfo));
});

test('planner: a dune ridge across the line is crossed at its saddle', () => {
  const st = multi([-20, 13], [[0, 6, 'ASS']]), p0 = [-20, 13];
  // ridge 40 m high at 3 km, with a saddle 600 m to the right (east)
  const hf = along(st, (x, y) => { const ridge = 40 * Math.exp(-(((x - 3000) / 120) ** 2)); const saddle = 1 - 0.85 * Math.exp(-(((y - 600) / 250) ** 2)); return ridge * saddle; });
  const leg = RB.planOffPiste(st, hf, [], {}).stage.route.legs[0];
  // where does the line cross x = 3000 m?
  const P = RB.geo.projector(-20), O = P.xy(p0);
  let cross = null;
  for (let k = 1; k < leg.points.length; k++) { const a = P.xy(leg.points[k - 1]), b = P.xy(leg.points[k]); const ya = a[1] - O[1], yb = b[1] - O[1]; if ((ya - 3000) * (yb - 3000) <= 0) { const t = (3000 - ya) / (yb - ya); cross = (a[0] + (b[0] - a[0]) * t) - O[0]; } }
  assert.ok(cross > 350 && cross < 850, 'crossed at ' + cross + ' m east');
  assert.ok(leg.vertexInfo.some(v => v && /right/.test(v.reason || '')), JSON.stringify(leg.vertexInfo));
});

test('roadbook from a planned line: a CAP box at each bend, the tulip shows the turn, the line is in the file', async () => {
  const st = multi([-20, 13], [[45, 10, 'ASS']]);
  const rb = await RB.generate(st, { heightFn: hilly, useOsm: false, density: 10 });
  const leg = rb.route.legs[0]; assert.ok(leg.planned && leg.points.length > 4);
  const caps = rb.boxes.filter(b => b.features.some(f => f.kind === 'cap'));
  // every clear bend of the line (15 deg; capKeepTurn is 10 measured over +-40 m) has its CAP box
  const turns = leg.points.slice(1, -1).map((p, k) => Math.abs(((RB.geo.bearing(p, leg.points[k + 2]) - RB.geo.bearing(leg.points[k], p) + 540) % 360) - 180));
  assert.ok(caps.length >= turns.filter(t => t >= 15).length, caps.length + ' cap boxes for ' + turns.map(Math.round).join(','));
  for (const b of caps) { assert.match(b.notes, new RegExp('CAP ' + String(b.capOut).padStart(3, '0'))); assert.ok(Math.abs(b.tulip.exit.angle) >= 2, 'tulip angle ' + b.tulip.exit.angle); }
  // no dead-straight stretch of boxes: CAPs out of consecutive off-piste boxes are not all equal
  const distinct = new Set(rb.boxes.filter(b => b.offPiste).map(b => b.capOut));
  assert.ok(distinct.size >= 5);
  // waypoint CAPs in the stage are untouched; the roadbook ends where the planned line ends
  assert.ok(Math.abs(rb.boxes.at(-1).km - leg.km) < 0.02);
});

test('applyPlannedLine: stage keeps its format, km re-summed, caps unchanged', async () => {
  const st = multi([-20, 13], [[30, 5, 'WPM'], [100, 4, 'ASS']]);
  st.roadbook = { boxes: [{ n: 1, id: 'w0', km: 0, waypoint: 'w0' }, { n: 2, id: 'w1', km: 5, waypoint: 'w1' }, { n: 3, id: 'w2', km: 9, waypoint: 'w2' }] };
  const rb = await RB.generate(st, { heightFn: hilly, useOsm: false });
  const s2 = RB.applyPlannedLine(st, rb);
  assert.strictEqual(s2.route.legs.length, 2);
  s2.route.legs.forEach((l, i) => { assert.strictEqual(l.mode, 'direct'); assert.deepStrictEqual(l.points[0], st.route.legs[i].points[0]); assert.deepStrictEqual(l.points.at(-1), st.route.legs[i].points.at(-1)); });
  assert.ok(Math.abs(s2.lengthKm - (s2.route.legs[0].km + s2.route.legs[1].km)) < 0.002);
  assert.strictEqual(s2.waypoints[2].km, s2.lengthKm);
  assert.deepStrictEqual(s2.waypoints.map(w => w.cap), st.waypoints.map(w => w.cap));
  assert.strictEqual(s2.roadbook.boxes[1].km, s2.waypoints[1].km);
  assert.ok(s2.lengthKm > 9);
});

test('town noise: no boxes for slip lanes, the other carriageway or side streets off a main road; real turns stay', async () => {
  // north on a trunk road (dual carriageway: a parallel southbound way 15 m east) for 3 km, then a right turn onto a track
  const A = [-20, 13], J1 = dest(A, 0, 800), J2 = dest(A, 0, 1600), T = dest(A, 0, 3000), E = dest(T, 90, 1500);
  const off = p => dest(p, 90, 15);
  const st = { id: 't', name: 'T', waypoints: [{ id: 'a', type: 'DSS', lat: A[0], lon: A[1], km: 0 }, { id: 'b', type: 'ASS', lat: E[0], lon: E[1], km: 4.5 }],
    route: { legs: [{ from: 'a', to: 'b', mode: 'road', km: 4.5, points: [A, J1, J2, T, E] }] } };
  const trunk = { highway: 'trunk', ref: 'A87', name: 'Stuart Highway' };
  const osm = osmFor({ 1: A, 2: J1, 3: J2, 4: T, 5: dest(J1, 270, 300), 6: dest(J1, 60, 200), 7: dest(J2, 90, 400), 8: E, 9: off(T), 10: off(A), 11: dest(J2, 270, 300), 12: dest(T, 0, 500) }, [
    { tags: trunk, nodes: [1, 2, 3, 4, 12] },
    { tags: trunk, nodes: [9, 7, 10] },                                     // southbound carriageway, joined at node 7? (no: separate)
    { tags: { highway: 'residential', name: 'Harris Avenue' }, nodes: [2, 5] },   // side street
    { tags: { highway: 'trunk_link' }, nodes: [2, 6] },                      // slip lane
    { tags: { highway: 'service' }, nodes: [3, 11] },                        // car park
    { tags: { highway: 'track', name: 'East' }, nodes: [4, 8] }]);
  const rb = await RB.generate(st, { heightFn: () => 0, osm });
  const js = rb.boxes.filter(b => b.features.some(f => f.kind === 'junction'));
  assert.strictEqual(js.length, 1, js.map(b => b.km + ' ' + b.notes).join(' / '));
  assert.ok(Math.abs(js[0].km - 3) < 0.05); assert.match(js[0].notes, /TURN R ON P \(EAST\)/);
});

test('town noise: a fork where the same road goes on and we turn off is kept', async () => {
  const A = [-20, 13], J = dest(A, 0, 1000), L = dest(J, 60, 1500), Sx = dest(J, 345, 1500);
  const st = { id: 't', name: 'T', waypoints: [{ id: 'a', type: 'DSS', lat: A[0], lon: A[1], km: 0 }, { id: 'b', type: 'ASS', lat: L[0], lon: L[1], km: 2.5 }],
    route: { legs: [{ from: 'a', to: 'b', mode: 'road', km: 2.5, points: [A, J, L] }] } };
  const osm = osmFor({ 1: A, 2: J, 3: L, 4: Sx }, [{ tags: { highway: 'secondary', name: 'Roger Vale Drive' }, nodes: [1, 2, 4] }, { tags: { highway: 'secondary', name: 'Maryvale Road' }, nodes: [2, 3] }]);
  const rb = await RB.generate(st, { heightFn: () => 0, osm });
  const j = rb.boxes.find(b => b.features.some(f => f.kind === 'junction'));
  assert.ok(j); assert.match(j.notes, /TURN R ON RO \(MARYVALE ROAD\)/);
});

test('terrain-first: onPartial gets a terrain-only roadbook before OpenStreetMap, progress is reported', async () => {
  const st = line(8, 30, 'direct');
  const seen = [], phases = new Set();
  let osmCalls = 0;
  const rb = await RB.generate(st, { heightFn: () => 50, planOffPiste: true, density: 20,
    fetchOverpass: async () => { osmCalls++; return { elements: [] }; },
    onPartial: p => seen.push(p), onProgress: e => phases.add(e.phase) });
  assert.strictEqual(seen.length, 1); assert.strictEqual(seen[0].partial, 'terrain-only');
  assert.ok(seen[0].boxes.length > 5);
  assert.ok(osmCalls >= 1); assert.strictEqual(rb.partial, undefined);
  assert.ok(phases.has('osm') && phases.has('done'), [...phases].join(','));
});

test('OSM failure with osmOptional: terrain-only roadbook instead of an error', async () => {
  const st = line(5, 30, 'road');
  const rb = await RB.generate(st, { heightFn: () => 50, osmOptional: true, overpassPauseMs: 1, overpassMaxPauseMs: 2, fetchOverpass: async () => { throw new Error('HTTP 504'); } });
  assert.strictEqual(rb.partial, 'terrain-only'); assert.ok(rb.sources.osm.failed);
});

test('planner: a line override (dragged in the editor) is used as drawn; a per-leg seed changes only that leg', () => {
  const st = line(10, 45, 'direct'), hf = (lat, lon) => 100 + 30 * Math.sin(lat * 900) * Math.cos(lon * 700);
  const A = st.route.legs[0].points[0], B = st.route.legs[0].points[1], M = dest(dest(A, 45, 5000), 135, 800);
  const ov = RB.planOffPiste(st, hf, [], { lineOverrides: { 'a>b': [A, M, B] } });
  assert.deepStrictEqual(ov.stage.route.legs[0].points.map(p => p.map(x => +x.toFixed(6))), [A, M, B].map(p => p.map(x => +x.toFixed(6))));
  assert.ok(ov.stage.route.legs[0].edited);
  const p0 = RB.planOffPiste(st, hf, []), p1 = RB.planOffPiste(st, hf, [], { legSeeds: { 'a>b': 3 } });
  assert.notDeepStrictEqual(p0.stage.route.legs[0].points, p1.stage.route.legs[0].points);
});

test('regenerate after the off-piste line was edited: kept boxes re-measured on the new line', async () => {
  const st = line(10, 45, 'direct'), hf = () => 100;
  const old = await RB.generate(st, { heightFn: hf, useOsm: false });
  const b = old.boxes[3]; RB.applyChanges(old, [{ op: 'update', id: b.id, baseRev: b.rev, fields: { notes: 'MY NOTE' }, by: 'editor' }]);
  const A = st.route.legs[0].points[0], B = st.route.legs[0].points[1], M = dest(dest(A, 45, 5000), 135, 2500);
  const fresh = await RB.generate(st, { heightFn: hf, useOsm: false, lineOverrides: { 'a>b': [A, M, B] } });
  const merged = RB.mergeRegenerated(old, fresh, st);
  const mine = merged.boxes.find(x => x.notes === 'MY NOTE');
  assert.ok(mine); assert.ok(merged.route.legs[0].edited);
  assert.ok(Math.abs(mine.km - b.km) > 0.01 || mine.orphan, 'km ' + mine.km + ' vs ' + b.km);
});

test('older stage files: roadbook text on stage points moves into the roadbook as pinned editor boxes', async () => {
  const A = [-20, 13], B = dest(A, 0, 3000), Nt = dest(A, 0, 1500), C = dest(B, 0, 3000);
  const st = { format: 'rallyraid-stage', schemaVersion: 1, id: 't', name: 'T',
    waypoints: [{ id: 'a', type: 'DSS', lat: A[0], lon: A[1], km: 0 }, { id: 'b', type: 'WPM', n: 1, lat: B[0], lon: B[1], km: 3 }, { id: 'c', type: 'ASS', lat: C[0], lon: C[1], km: 6 }],
    route: { legs: [{ from: 'a', to: 'nt', mode: 'direct', km: 1.5, points: [A, Nt] }, { from: 'nt', to: 'b', mode: 'direct', km: 1.5, points: [Nt, B] }, { from: 'b', to: 'c', mode: 'direct', km: 3, points: [B, C] }] },
    roadbook: { boxes: [
      { n: 1, id: 'a', km: 0, waypoint: 'a', label: 'DSS', lat: A[0], lon: A[1], notes: '', danger: 0 },
      { n: 2, id: 'nt', km: 1.5, waypoint: null, label: 'NOTE', lat: Nt[0], lon: Nt[1], notes: 'Big rock on the left', danger: 2 },
      { n: 3, id: 'b', km: 3, waypoint: 'b', label: 'WPM 1', lat: B[0], lon: B[1], notes: 'Well, KEEP RIGHT', danger: 1 },
      { n: 4, id: 'c', km: 6, waypoint: 'c', label: 'ASS', lat: C[0], lon: C[1] }] } };
  const rb = await gen(st, () => 100);
  assert.strictEqual(rb.stats.migratedFromStage, 2);
  const wb = rb.boxes.find(b => b.waypoint === 'b');
  assert.match(wb.notes, /^Well, KEEP RIGHT/); assert.strictEqual(wb.danger, 1);
  assert.ok(wb.pinned && wb.source === 'editor' && wb.sources.includes('editor') && wb.migrated && wb.history.at(-1).by === 'stage-file');
  const nb = rb.boxes.find(b => /Big rock/.test(b.notes));
  assert.ok(nb && Math.abs(nb.km - 1.5) < 0.08 && nb.danger === 2 && nb.pinned && nb.source === 'editor');
  assert.ok(!rb.boxes.find(b => b.waypoint === 'a').pinned, 'a point without text is not pinned');
  for (let i = 1; i < rb.boxes.length; i++) assert.ok(rb.boxes[i].km >= rb.boxes[i - 1].km && rb.boxes[i].n === i + 1);
  // regenerating keeps them once (no duplicates)
  const again = RB.mergeRegenerated(rb, await gen(st, () => 100), st);
  assert.strictEqual(again.boxes.filter(b => /Big rock/.test(b.notes || '')).length, 1);
  assert.strictEqual(again.boxes.filter(b => b.waypoint === 'b').length, 1);
  // without stage text nothing is migrated
  const clean = JSON.parse(JSON.stringify(st)); clean.roadbook.boxes.forEach(b => { delete b.notes; delete b.danger; });
  const rb2 = await gen(clean, () => 100);
  assert.ok(!rb2.stats.migratedFromStage && !rb2.boxes.some(b => b.pinned));
});

test('renderer: every symbol and tulip is valid XML (usable as an <img> / in the PDF)', () => {
  const dupAttr = svg => { for (const tag of svg.match(/<[a-z]+\s[^>]*>/g) || []) { const names = (tag.match(/\s([\w-]+)=/g) || []).map(x => x.trim()); if (new Set(names).size !== names.length) return tag; } return null; };
  for (const c of R.ICONS.concat(['DSS', 'WPM', 'speed_50', 'whatever'])) assert.strictEqual(dupAttr(R.symbolSVG(c, 30)), null, c);
  for (const tr of ['tarmac', 'dual', 'gravel', 'track', 'twotrack', 'sand', 'path', 'offpiste', 'water', 'fence', 'railway'])
    assert.strictEqual(dupAttr(R.tulipSVG({ entry: { track: tr }, exit: { angle: 40, track: tr }, branches: [{ angle: -90, track: tr }, { angle: 120, track: tr, cross: true }] }, 120)), null, tr);
  for (const g of Object.values(R.GROUPS)) for (const c of g) assert.ok(R.ICONS.includes(c) || /^(DSS|ASS|CP|WP[VEMNSCP]|DZ|FZ|speed_\d+)$/.test(c), c);
});

test('symbols: the FIM legend library, names, aliases and abbreviations', () => {
  const inGroups = [].concat(...Object.values(R.GROUPS));
  // every drawn symbol is in a palette group, and every legend symbol has a FIM name and a real drawing (no text placeholder)
  for (const c of R.ICONS) assert.ok(inGroups.includes(c), 'not in a group: ' + c);
  for (const c of inGroups) {
    assert.ok(R.NAMES[c] || /^speed_\d+$/.test(c), 'no name: ' + c);
    const svg = R.symbolSVG(c, 30);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 34 34"[^>]*><title>[^<]+<\/title>[\s\S]+<\/svg>$/, c);
    assert.ok(/<(path|circle|ellipse|polygon)\b/.test(svg), 'only text: ' + c);
  }
  assert.ok(inGroups.length >= 85, 'library size ' + inGroups.length);
  // the most used FIM symbols are there
  for (const c of ['bump', 'dip', 'compression', 'ditch', 'step_up', 'step_down', 'ruts', 'twisty', 'hole', 'tree', 'palm_tree', 'vegetation', 'camel_grass',
    'buildings', 'ruins', 'cemetery', 'mosque', 'well', 'cairn', 'post', 'electric_line', 'pylon', 'antenna', 'barbed_wire', 'gate', 'cattle_grid', 'bridge',
    'under_bridge', 'ford', 'reset_trip', 'over_crest', 'broken_dune', 'bowl', 'CP']) assert.ok(inGroups.includes(c), c);
  // aliases draw the same picture as their target, old ids keep working
  for (const [a, t] of Object.entries(R.ALIAS)) {
    assert.ok(inGroups.includes(t), a + ' -> ' + t);
    assert.strictEqual(R.symbolSVG(a, 30).replace(/<title>.*?<\/title>/, ''), R.symbolSVG(t, 30).replace(/<title>.*?<\/title>/, ''), a);
  }
  for (const old of ['crest', 'jump', 'dip', 'compression', 'wadi', 'undulations', 'climb', 'descent', 'dunes', 'dunes_end', 'sideslope_l', 'sideslope_r', 'ridge', 'valley', 'flat', 'rolling', 'broken', 'junction', 'ford', 'bridge', 'gate', 'cattle_grid', 'fence', 'railway', 'village', 'offpiste', 'join_track', 'surface', 'bend', 'hairpin', 'cap', 'continue', 'stop', 'cross_track', 'trees', 'water', 'cliff', 'danger', 'rocks', 'hole', 'soft_sand', 'narrow', 'well', 'antenna', 'keep_left', 'keep_right', 'track_left', 'track_right', 'camel_grass'])
    assert.ok(R.ICONS.includes(old), 'old id gone: ' + old);
  assert.strictEqual(R.resolve('summit'), 'crest'); assert.strictEqual(R.symbolName('bumpy'), 'Bumpy');
  // abbreviations (FIM legend, CAPS / ABBREVIATIONS columns)
  const ab = R.ABBR.map(x => x[0]);
  for (const a of ['P', 'PP', 'RO', 'HP', 'FPP', 'SA', 'GV', 'VG', 'kpL', 'kpR', 'kpS', 'onL', 'onR', 'CX', 'E3', 'NBX', 'IMP', 'ORN', 'RP', 'BTW', 'DN', 'DNX', 'DNT']) assert.ok(ab.includes(a), a);
  // the legend lists every symbol, every tulip line and the danger marks
  const lg = R.legendHTML();
  for (const c of inGroups) assert.ok(lg.includes('<title>' + R.symbolName(c).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '</title>') || lg.includes(R.symbolName(c)), c);
  for (const k of Object.keys(R.TRACK_NAMES)) assert.ok(R.STYLE[k], k);
  assert.match(lg, /Danger level 3/);
  // danger notation in the strip: red line under the km at !!, red frame at !!!
  const row = d => R.boxRow({ n: 1, km: 1, partial: 1, danger: d, symbols: [], notes: '' });
  assert.match(row(2), /class="d2/); assert.match(row(3), /class="d3/); assert.doesNotMatch(row(1), /class="d\d/);
});

// ---- recce (fixtures written by tests/recce_test.lua: the game's recce file, the roadbook it was merged into, and
// the game's own merge result)
const FX = __dirname + '/../fixtures/recce/';
test('recce: the editor merges a game recce file exactly like the game does', () => {
  const fs = require('fs');
  const doc = JSON.parse(fs.readFileSync(FX + 'moab-sand-flats-ss1.recce.json'));
  const before = JSON.parse(fs.readFileSync(FX + 'moab-desk-edited.roadbook.json'));
  const game = JSON.parse(fs.readFileSync(FX + 'moab-merged-in-game.roadbook.json'));
  const r = RB.readRecce(doc, before);
  assert.deepStrictEqual(r.errors, []);
  assert.ok(r.changes.length >= 12 && r.driven.points.length > 100);
  const pv = RB.previewChanges(before, r.changes);
  assert.strictEqual(pv.filter(p => p.status === 'conflict').length, 2, 'confirm + retag on the desk-edited box');
  assert.ok(r.changes.every(c => RB.describeChange(c, before).length > 5));
  const rb = JSON.parse(JSON.stringify(before));
  const res = RB.applyChanges(rb, r.changes);
  assert.strictEqual(res.conflicts.length, game.conflicts.length);
  assert.strictEqual(rb.revision, game.revision);
  const key = b => [b.id, b.n, b.km, !!b.deleted, !!b.verified, !!b.pinned, b.source, b.notes, b.danger, b.rev].join('|');
  assert.deepStrictEqual(rb.boxes.filter(b => !b.deleted).map(key), game.boxes.filter(b => !b.deleted).map(key));
  assert.deepStrictEqual(rb.boxes.filter(b => b.deleted).map(b => b.id).sort(), game.boxes.filter(b => b.deleted).map(b => b.id).sort());
  // importing the same recce again after the merge: everything is already in
  const again = RB.previewChanges(rb, r.changes);
  assert.ok(again.filter(p => p.status === 'done').length >= r.changes.length - 2, JSON.stringify(again));
  // another stage's recce is refused; an older roadbook revision is a warning
  assert.ok(RB.readRecce(Object.assign({}, doc, { stage: { id: 'other' } }), before).errors.length === 1);
  assert.ok(RB.readRecce({ format: 'x' }, before).errors.length === 1);
  const old = RB.readRecce(Object.assign({}, doc, { roadbook: { revision: 0 } }), before);
  assert.ok(old.warnings.some(w => /changed since/.test(w)));
  // lists written by the game as objects {"1": ...} or {} read as arrays
  const objy = RB.readRecce(Object.assign({}, doc, { changes: { 1: doc.changes[0], 2: doc.changes[1] }, applied: {} }), before);
  assert.strictEqual(objy.changes.length, 2); assert.deepStrictEqual(objy.applied, []);
});

test('recce: km re-measured from the driven line (same rule as the game)', () => {
  const lat0 = 38.5676, lon0 = -109.5313, kx = 111320 * Math.cos(lat0 * Math.PI / 180);
  const drv = { points: [], breaks: [] };
  for (let i = 0; i <= 100; i++) drv.points.push([lat0, lon0 + i * 20 / kx, i * 0.02 * 1.1]);
  const rb = { revision: 1, boxes: [] };
  for (let i = 0; i <= 10; i++) rb.boxes.push({ id: 'b' + i, km: i * 0.2, lat: lat0 + (i === 5 ? 0.01 : 0), lon: lon0 + i * 200 / kx });
  assert.strictEqual(RB.rescaleToDriven(rb, drv), 10);
  assert.ok(Math.abs(rb.boxes[10].km - 2.2) < 0.005 && Math.abs(rb.boxes[2].km - 0.44) < 0.005 && Math.abs(rb.boxes[5].km - 1.1) < 0.005);
  assert.ok(rb.recce.matched === 10 && rb.boxes[10].history.length === 1 && rb.boxes[10].n === 11);
  // a break in the line (teleport): the jump is not a segment
  const rb2 = { revision: 1, boxes: [{ id: 'a', km: 0, lat: lat0, lon: lon0 }, { id: 'm', km: 1, lat: lat0, lon: lon0 + 1000 / kx }] };
  const d2 = { points: [[lat0, lon0, 0], [lat0, lon0 + 100 / kx, 0.1], [lat0, lon0 + 2000 / kx, 0.1], [lat0, lon0 + 2100 / kx, 0.2]], breaks: [3] };
  assert.strictEqual(RB.rescaleToDriven(rb2, d2), 1, 'the box in the gap is not on the line');
});

// --- enrichment: landmarks, land cover, small DEM features (generator 0.2)
test('landmarks: a ruin and a mast near the line are named with side and distance; nothing is invented', async () => {
  const st = line(10, 0, 'direct'), p0 = [st.waypoints[0].lat, st.waypoints[0].lon];
  const off = (m, side) => dest(dest(p0, 0, m), side < 0 ? 270 : 90, Math.abs(side));
  const ruin = off(2300, -60), mast = off(5000, 250), tree1 = off(7000, -20), tree2 = off(7000, 20), farAway = off(8000, 3000);
  const landmarks = [
    { type: 'node', id: 1, lat: ruin[0], lon: ruin[1], tags: { historic: 'ruins' } },
    { type: 'node', id: 2, lat: mast[0], lon: mast[1], tags: { man_made: 'mast' } },
    { type: 'node', id: 3, lat: tree1[0], lon: tree1[1], tags: { natural: 'tree' } },
    { type: 'node', id: 4, lat: tree2[0], lon: tree2[1], tags: { natural: 'tree' } },
    { type: 'node', id: 5, lat: farAway[0], lon: farAway[1], tags: { man_made: 'water_tower' } }];
  const rb = await gen(st, () => 100, { landmarks, density: 20, maxGapKm: 1 });
  const lm = rb.boxes.flatMap(b => b.features.filter(f => f.kind === 'landmark' || f.kind === 'landmark_pass').map(f => [b, f]));
  const ruinBox = lm.find(([, f]) => f.what === 'ruin'), mastBox = lm.find(([, f]) => f.what === 'mast');
  assert.ok(ruinBox, JSON.stringify(rb.boxes.map(b => b.notes)));
  assert.match(ruinBox[0].notes, /RUIN onL( \d+)?/); assert.ok(ruinBox[0].symbols.includes('ruins'));
  assert.ok(mastBox && /MAST onR|TOWARDS MAST/.test(mastBox[0].notes), mastBox && mastBox[0].notes);
  assert.ok(rb.boxes.some(b => /BTW 2 TREES/.test(b.notes)), rb.boxes.map(b => b.notes).join(' | '));
  assert.ok(!rb.boxes.some(b => /TANK|WATER TOWER/.test(b.notes)), 'a tower 3 km off the line is not in sight');
  assert.ok(ruinBox[0].sources.includes('auto-osm'));
  // no landmark data: no landmark words at all
  const bare = await gen(st, () => 100, { density: 20, maxGapKm: 1 });
  assert.ok(!bare.boxes.some(b => /RUIN|MAST|TREE|PYLON|HOUSE/.test(b.notes)));
  assert.ok(!bare.boxes.some(b => b.features.some(f => /^landmark/.test(f.kind))));
});

test('landmarks: crossing a power line is a box of its own', async () => {
  const st = line(6, 0, 'direct'), p0 = [st.waypoints[0].lat, st.waypoints[0].lon];
  const a = dest(dest(p0, 0, 3000), 270, 800), b = dest(dest(p0, 0, 3000), 90, 800);
  const landmarks = [{ type: 'way', id: 9, tags: { power: 'line' }, geometry: [{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }] }];
  const rb = await gen(st, () => 100, { landmarks });
  const x = rb.boxes.find(b => b.features.some(f => f.kind === 'landmark_cross'));
  assert.ok(x && Math.abs(x.km - 3) < 0.08, rb.boxes.map(b => b.km + ' ' + b.notes).join(' | '));
  assert.match(x.notes, /UNDER POWER LINE/); assert.ok(x.symbols.includes('electric_line'));
});

test('land cover: entering bush off-piste is a VG box; on a track only trees / fields / marsh count', async () => {
  const st = line(8, 0, 'direct'), p0 = [st.waypoints[0].lat, st.waypoints[0].lon];
  const brg = 0;
  const lc = (lat, lon) => { const d = dist(p0, [lat, lon]); return d < 4000 ? 60 : 20; };   // bare, then shrubland
  const rb = await gen(st, () => 100, { landCover: lc });
  const vg = rb.boxes.find(b => b.features.some(f => f.kind === 'cover'));
  assert.ok(vg && Math.abs(vg.km - 4) < 0.1, rb.boxes.map(b => b.km + ' ' + b.notes).join(' | '));
  assert.match(vg.notes, /VG/); assert.ok(vg.symbols.includes('vegetation')); assert.ok(vg.sources.includes('auto-landcover'));
  const S = RB.resampleRoute(line(4, 0, 'road'), 20);
  const cov = RB.coverAlong(S, (lat, lon) => dist(p0, [lat, lon]) < 2000 ? 60 : 20, { step: 20 });
  assert.strictEqual(RB.coverFeatures(S, cov, { step: 20 }).length, 0, 'bush along a road is not a note');
  // unknown cover (no tiles): no features
  assert.strictEqual(RB.coverFeatures(S, S.map(() => null), { step: 20 }).length, 0);
});

test('DEM: a narrow ditch and a short step down are found on a flat line', async () => {
  const st = line(8, 0, 'road');
  const hf = along(st, x => (x > 2000 && x < 2060 ? -3.5 : 0) + (x < 5000 ? 6 : x < 5040 ? 6 - (x - 5000) * 0.15 : 0));
  const rb = await gen(st, hf);
  const k = kinds(rb);
  assert.ok(k.includes('ditch'), k.join(','));
  assert.ok(k.includes('step_down'), k.join(','));
  const sd = rb.boxes.find(b => b.features.some(f => f.kind === 'step_down'));
  assert.match(sd.notes, /STEP DOWN 6 M/); assert.ok(sd.symbols.includes('step_down'));
});

test('track codes: P / PP / RO shorthand in the notes', () => {
  assert.strictEqual(RB.TRACK_CODE.gravel, 'PP'); assert.strictEqual(RB.TRACK_CODE.tarmac, 'RO'); assert.strictEqual(RB.TRACK_CODE.offpiste, 'HP');
  assert.strictEqual(RB.junctionNote({ instr: 'KEEP LEFT', tulip: { exit: { track: 'gravel' }, branches: [{ track: 'track' }] } }), 'kpL FPP');
  assert.strictEqual(RB.junctionNote({ instr: 'STRAIGHT ON', outName: 'B1', tulip: { exit: { track: 'tarmac' }, branches: [{ track: 'gravel' }] } }), 'kpS FRO (B1)');
  assert.strictEqual(RB.junctionNote({ instr: 'TURN LEFT', tulip: { exit: { track: 'twotrack' }, branches: [] } }), 'TURN L ON P -V');
  assert.match(RB.describe({ kind: 'leave_track', from: 'gravel', to: 'offpiste' }).note, /^QT PP, HP/);
  assert.match(RB.describe({ kind: 'dunes', lenKm: 3, size: 'medium', amp: 12, maxAmp: 20 }).note, /^DNX 3 KM L2/);
  // every symbol the generator can emit is in the renderer's library
  for (const L of ['ruins', 'pylon', 'electric_line', 'antenna', 'tanks', 'well', 'cairn', 'mosque', 'cemetery', 'petrol', 'tree', 'palm_tree', 'trees', 'rocks', 'sign_post', 'road_works', 'buildings', 'vegetation', 'camel_grass', 'water', 'soft_sand', 'bump', 'ditch', 'step_up', 'step_down', 'over_crest', 'keep_left', 'keep_right', 'towards'])
    assert.ok(R.ICONS.includes ? R.ICONS.includes(L) : R.ICONS[L], L);
});

test('density slider: sparse gives long CAP legs (gaps of several km), dense gives many boxes; must-keep boxes survive', async () => {
  const st = multi([-20, 13], [[30, 25, 'ASS']]);
  const counts = [];
  for (const d of [2, 5, 10, 20]) {
    const rb = await RB.generate(st, { heightFn: hilly, useOsm: false, density: d });
    counts.push(rb.boxes.length);
    if (d === 2) { const gaps = rb.boxes.slice(1).map(b => b.partial); assert.ok(Math.max(...gaps) >= 4, 'sparse: longest gap ' + Math.max(...gaps)); }
  }
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] > counts[i - 1], 'more boxes as the slider goes up: ' + counts.join(' < '));
  assert.ok(counts[3] >= counts[0] * 3, counts.join(','));
  // a junction and a danger-2 feature are never pruned, even at density 1
  const A = [-20, 13], J = dest(A, 0, 3000), E = dest(J, 90, 3000), W = dest(J, 270, 1500);
  const road = { id: 't', name: 'T', waypoints: [{ id: 'a', type: 'DSS', lat: A[0], lon: A[1], km: 0 }, { id: 'b', type: 'ASS', lat: E[0], lon: E[1], km: 6 }],
    route: { legs: [{ from: 'a', to: 'b', mode: 'road', km: 6, points: [A, J, E] }] } };
  const osm = osmFor({ 1: A, 2: J, 3: E, 4: W }, [{ tags: { highway: 'track' }, nodes: [1, 2] }, { tags: { highway: 'track', name: 'East' }, nodes: [4, 2, 3] }]);
  const rb1 = await RB.generate(road, { heightFn: () => 0, osm, density: 1 });
  assert.ok(rb1.boxes.some(b => b.features.some(f => f.kind === 'junction')));
});

// ---- 0.3: junction complexes, minimum spacing, junction selection, path tulips, wording
const gaps = rb => rb.boxes.slice(1).map((b, i) => ({ m: Math.round((b.km - rb.boxes[i].km) * 1000), wp: !!(b.waypoint && rb.boxes[i].waypoint), a: rb.boxes[i], b }));
function complexStage() {
  // north 1 km on a gravel road, TURN R onto a track, 80 m on TURN L onto another track, north 1.5 km
  const A = [-20, 13], J1 = dest(A, 0, 1000), J2 = dest(J1, 90, 80), E = dest(J2, 0, 1500);
  const st = { id: 't', name: 'T', waypoints: [{ id: 'a', type: 'DSS', lat: A[0], lon: A[1], km: 0 }, { id: 'b', type: 'ASS', lat: E[0], lon: E[1], km: 2.58 }],
    route: { legs: [{ from: 'a', to: 'b', mode: 'road', km: 2.58, points: [A, J1, J2, E] }] } };
  const osm = osmFor({ 1: A, 2: J1, 3: dest(J1, 0, 600), 4: dest(J1, 270, 400), 5: J2, 6: dest(J2, 90, 500), 7: E }, [
    { tags: { highway: 'unclassified', surface: 'gravel' }, nodes: [1, 2, 3] },
    { tags: { highway: 'track', name: 'Cross Track' }, nodes: [4, 2, 5, 6] },
    { tags: { highway: 'track', name: 'North' }, nodes: [5, 7] }]);
  return { st, osm };
}
test('junction complex: two turns 80 m apart are one box, a path tulip, the note in travel order', async () => {
  const { st, osm } = complexStage();
  const rb = await RB.generate(st, { heightFn: () => 0, osm });
  const js = rb.boxes.filter(b => b.features.some(f => f.kind === 'junction'));
  assert.strictEqual(js.length, 1, js.map(b => b.km + ' ' + b.notes).join(' / '));
  const j = js[0];
  assert.ok(Math.abs(j.km - 1) < 0.05, 'km ' + j.km);
  assert.match(j.notes, /^TURN R ON P \(CROSS TRACK\), AT 80 TURN L ON P \(NORTH\)/);
  assert.ok(Array.isArray(j.tulip.pre) && j.tulip.pre.length === 1, JSON.stringify(j.tulip));
  assert.ok(Math.abs(j.tulip.pre[0].angle - 90) < 8 && Math.abs(j.tulip.exit.angle + 90) < 8, JSON.stringify(j.tulip));
  assert.ok(Math.abs(j.tulip.at - 80) <= 20, 'at ' + j.tulip.at);
  assert.ok(Math.abs(j.cap - 0) < 8 || Math.abs(j.cap - 360) < 8, 'CAP after the last turn: ' + j.cap);
  assert.ok(rb.stats.merged >= 1);
});
test('minimum spacing: no two boxes closer than 150 m (except two waypoints)', async () => {
  // off-piste: two sharp crests 90 m apart, a wadi 100 m after them, a step later
  const st = line(6, 0, 'direct');
  const hump = (x, c) => Math.max(0, 12 - Math.abs(x - c) * 0.25);
  const hf = along(st, x => hump(x, 2000) + hump(x, 2090) - (x > 2180 && x < 2230 ? 6 : 0));
  for (const density of [4, 25]) {
    const rb = await gen(st, hf, { density });
    for (const g of gaps(rb)) assert.ok(g.m >= 150 || g.wp, 'density ' + density + ': ' + g.m + ' m between "' + g.a.notes + '" and "' + g.b.notes + '"');
  }
  // the complex stage on fast roads: 200 m
  const { st: s2, osm } = complexStage();
  const rb2 = await RB.generate(s2, { heightFn: () => 0, osm, density: 25 });
  for (const g of gaps(rb2)) assert.ok(g.m >= 150 || g.wp, g.m + ' m: ' + g.a.notes + ' / ' + g.b.notes);
});
test('minimum spacing: a must-keep junction just before a waypoint keeps its own box, the waypoint stays put', async () => {
  const { st, osm } = complexStage();
  const J1 = dest([-20, 13], 0, 1000), W = dest(J1, 90, 80);
  st.waypoints.splice(1, 0, { id: 'w', type: 'WPV', n: 1, lat: W[0], lon: W[1], km: 1.08 });
  const rb = await RB.generate(st, { heightFn: () => 0, osm });
  const wp = rb.boxes.find(b => b.waypoint === 'w');
  assert.ok(wp && Math.abs(wp.km - 1.08) < 0.03, 'WP box at its km');
  assert.ok(rb.boxes.some(b => b.features.some(f => f.kind === 'junction')), 'the turn is still described');
});
test('junction selection: crossing streets on an unnamed dual carriageway are not boxes (Hail)', async () => {
  // north 2 km on a oneway tertiary; its unnamed other carriageway 15 m east; residential streets cross both every 120 m
  const A = [-20, 13], E = dest(A, 0, 2000);
  const st = { id: 't', name: 'T', waypoints: [{ id: 'a', type: 'DSS', lat: A[0], lon: A[1], km: 0 }, { id: 'b', type: 'ASS', lat: E[0], lon: E[1], km: 2 }],
    route: { legs: [{ from: 'a', to: 'b', mode: 'road', km: 2, points: [A, E] }] } };
  const nodes = {}, ways = [], nb = [], sb = [];
  let id = 1;
  for (let m = 0; m <= 2000; m += 20) { const a = id++, b = id++; nodes[a] = dest(A, 0, m); nodes[b] = dest(dest(A, 0, m), 90, 15); nb.push(a); sb.unshift(b);
    if (m >= 400 && m <= 1600 && m % 120 === 0) { const w = id++, e = id++; nodes[w] = dest(nodes[a], 270, 200); nodes[e] = dest(nodes[b], 90, 200); ways.push({ tags: { highway: 'residential' }, nodes: [w, a, b, e] }); } }
  ways.push({ tags: { highway: 'tertiary', oneway: 'yes' }, nodes: nb }, { tags: { highway: 'tertiary', oneway: 'yes' }, nodes: sb });
  const rb = await RB.generate(st, { heightFn: () => 0, osm: osmFor(nodes, ways), density: 25 });
  const js = rb.boxes.filter(b => b.features.some(f => f.kind === 'junction'));
  assert.ok(js.length <= 1, js.map(b => b.km + ' ' + b.notes).join(' / '));
});
test('path tulip render: nodes along the way, distance label, one arrow; a plain tulip draws as before', () => {
  const t = { entry: { track: 'gravel' }, exit: { angle: -90, track: 'track' }, branches: [{ angle: 90, track: 'track' }], at: 80,
    pre: [{ at: 0, angle: 90, track: 'track', branches: [{ angle: 0, track: 'gravel' }, { angle: -90, track: 'track' }, { angle: 45, track: 'water', cross: true }] }] };
  const svg = R.tulipSVG(t);
  assert.match(svg, /^<svg[^>]*viewBox="0 0 120 120"/);
  assert.strictEqual((svg.match(/<polygon/g) || []).length, 1, 'one arrow');
  assert.match(svg, />80<\/text>/);
  assert.match(svg, /stroke="#1f6fd1"/, 'the crossing river is drawn');
  // every coordinate inside the box
  for (const m of svg.matchAll(/(?:x[12]?|y[12]?|cx|cy)="(-?[\d.]+)"/g)) assert.ok(+m[1] >= -1 && +m[1] <= 121, m[0]);
  const old = R.tulipSVG({ entry: { track: 'track' }, exit: { angle: 30, track: 'track' }, branches: [{ angle: -40, track: 'path' }] });
  assert.ok(!/<text/.test(old) && (old.match(/<polygon/g) || []).length === 1);
  // three nodes, big gaps: still fits
  const t3 = Object.assign({}, t, { at: 400, pre: [{ at: 0, angle: 0, track: 'track', branches: [{ angle: 80, track: 'track' }] }, { at: 150, angle: 60, track: 'track', branches: [] }] });
  const s3 = R.tulipSVG(t3);
  assert.match(s3, />150<\/text>/); assert.match(s3, />250<\/text>/);
  for (const m of s3.matchAll(/(?:x[12]?|y[12]?|cx|cy)="(-?[\d.]+)"/g)) assert.ok(+m[1] >= -1 && +m[1] <= 121, m[0]);
});
test('wording: upper case FIM shorthand, Latin-script names only, no question marks', () => {
  assert.strictEqual(RB.describe({ kind: 'village', name: 'Hassilabied ⵃⴰⵙⵉ ⵍⴱⵢⴹ حاسي الأبيض', off: 50, zone: false }).note, 'THROUGH HASSILABIED, SLOW');
  assert.strictEqual(RB.describe({ kind: 'village', name: 'حاسي', off: 50, zone: true }).note, 'THROUGH VILLAGE');
  assert.strictEqual(RB.describe({ kind: 'cross_water', tags: { waterway: 'wadi', name: 'وادي الكظر' } }).note, 'CROSS WADI');
  assert.strictEqual(RB.describe({ kind: 'cross_fence', tags: { barrier: 'fence' } }).note, 'FENCE, FIND GAP');
  assert.strictEqual(RB.describe({ kind: 'cap', from: 0, to: 25, reason: 'follow interdune corridor left' }).note, 'CAP 025, FOLLOW CORRIDOR L');
  assert.strictEqual(RB.junctionNote({ instr: 'STRAIGHT ON (crossroads)', tulip: { exit: { track: 'tarmac' }, branches: [{ track: 'track' }] } }), 'X-ROADS kpS FRO');
  assert.strictEqual(RB.junctionNote({ instr: 'TURN RIGHT', outName: 'طريق', tulip: { exit: { track: 'tarmac' }, branches: [] } }), 'TURN R ON RO');
  for (const k of ['climb', 'descent', 'crest', 'dip', 'compression', 'wadi', 'sideslope', 'ridge', 'undulations', 'bend'])
    assert.ok(!/[a-z]{2}|\?/.test(RB.describe({ kind: k, grade: 12, maxGrade: 25, len: 300, depth: 8, side: 'L', turn: 90, danger: 1, blind: true }).note), k);
});

test('Overpass race: a slow primary is skipped for a fast mirror after the stagger; the next query sticks to the winner', async () => {
  const mirrors = ['https://slow.example/api', 'https://fast.example/api', 'https://other.example/api'];
  const calls = [];
  const fetchOverpass = (ep, q, opts) => new Promise((res, rej) => {
    calls.push({ ep, t: Date.now() });
    const ms = ep.includes('slow') ? 800 : 40;
    const t = setTimeout(() => res({ elements: [{ id: ep, type: 'node' }] }), ms);
    if (opts && opts.signal) opts.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
  });
  const o = { overpass: mirrors, overpassRace: true, overpassStaggerMs: 120, overpassTimeoutMs: 2000, overpassMaxInFlight: 2, overpassRounds: 1, fetchOverpass };
  const t0 = Date.now();
  const r = await RB.askOverpass('[out:json];', o);
  const dt = Date.now() - t0;
  assert.strictEqual(r.elements[0].id, 'https://fast.example/api');
  assert.ok(o._overpassSticky === 'https://fast.example/api');
  assert.ok(dt < 500, 'should not wait for the slow primary, took ' + dt + 'ms');
  assert.ok(calls.some(c => c.ep.includes('slow')) && calls.some(c => c.ep.includes('fast')));
  const n1 = calls.length;
  const r2 = await RB.askOverpass('[out:json];', o);
  assert.strictEqual(r2.elements[0].id, 'https://fast.example/api');
  assert.strictEqual(calls[n1].ep, 'https://fast.example/api', 'sticky: the next query starts with the winner');
});

test('Overpass race: a fast primary never starts a second mirror', async () => {
  const calls = [];
  const fetchOverpass = (ep) => { calls.push(ep); return Promise.resolve({ elements: [{ id: 1 }] }); };
  const o = { overpass: ['https://a.example/api', 'https://b.example/api'], overpassRace: true, overpassStaggerMs: 200, overpassTimeoutMs: 2000, overpassRounds: 1, fetchOverpass };
  const r = await RB.askOverpass('q', o);
  await new Promise(res => setTimeout(res, 250));
  assert.deepStrictEqual(calls, ['https://a.example/api']);
  assert.strictEqual(r.elements[0].id, 1);
  assert.strictEqual(o._overpassSticky, 'https://a.example/api');
});

test('Overpass: a 200 JSON reply with a non-date OSM timestamp is rejected and the next mirror is used', async () => {
  const calls = [];
  const fetchOverpass = (ep) => {
    calls.push(ep);
    if (ep.includes('stale')) return Promise.resolve({ elements: [], osm3s: { timestamp_osm_base: '118529' } });
    return Promise.resolve({ elements: [{ id: 7, type: 'node' }], osm3s: { timestamp_osm_base: '2026-11-16T21:22:36Z' } });
  };
  const o = { overpass: ['https://stale.example/api', 'https://fresh.example/api'], overpassRace: true, overpassStaggerMs: 80, overpassTimeoutMs: 1000, overpassRounds: 1, overpassRegional: false, fetchOverpass };
  const r = await RB.askOverpass('[out:json];', o);
  assert.strictEqual(r.elements[0].id, 7);
  assert.ok(calls.includes('https://stale.example/api') && calls.includes('https://fresh.example/api'));
  assert.strictEqual(o._overpassSticky, 'https://fresh.example/api');
});

test('Overpass: a North America extract is tried after the official mirror for a Moab bbox, but not for Namibia', async () => {
  const na = 'https://ovp.dresel.systems/api-na/interpreter';
  const official = 'https://overpass-api.de/api/interpreter';
  const moab = '[out:json][timeout:20];(way[highway](38.55,-109.55,38.65,-109.45););out;';
  const nam = '[out:json][timeout:20];(way[highway](-21.10,13.20,-20.90,13.50););out;';
  const orderMoab = RB.overpassOrder({ overpass: [official, 'https://overpass.private.coffee/api/interpreter'] }, moab);
  const orderNam = RB.overpassOrder({ overpass: [official, 'https://overpass.private.coffee/api/interpreter'] }, nam);
  assert.strictEqual(orderMoab[0], official, 'official stays first');
  assert.ok(orderMoab.includes(na), 'NA extract is added for Moab');
  assert.strictEqual(orderMoab[1], na, 'NA extract sits just after official');
  assert.ok(!orderNam.includes(na), 'NA extract is not used for Namibia');
  assert.ok(!orderNam.includes('https://overpass.osm.ch/api/interpreter'), 'Switzerland extract is not used for Namibia');
  const calls = [];
  const fetchOverpass = (ep) => {
    calls.push(ep);
    if (ep === official) return Promise.reject(new Error('HTTP 502'));
    if (ep === na) return Promise.resolve({ elements: [{ id: 99, type: 'way' }], osm3s: { timestamp_osm_base: '2026-11-16T21:22:36Z' } });
    return Promise.reject(new Error('HTTP 504'));
  };
  const o = { overpass: [official, 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'], overpassRace: true, overpassStaggerMs: 80, overpassTimeoutMs: 1000, overpassRounds: 1, fetchOverpass };
  const r = await RB.askOverpass(moab, o);
  assert.strictEqual(r.elements[0].id, 99);
  assert.strictEqual(o._overpassSticky, na);
  assert.ok(calls[0] === official && calls.includes(na));
});

test('OSM ways without node ids: no crash', async () => {
  // some sources keep way geometry but drop node ids; analyseOsm must not throw on them
  const st = line(3, 90, 'road');
  const A = st.route.legs[0].points[0], B = st.route.legs[0].points[1];
  const mid = dest(A, 90, 1500), side = dest(mid, 0, 400);
  const g = pts => pts.map(p => ({ lat: p[0], lon: p[1] }));
  const elements = [
    { type: 'way', id: 1, tags: { highway: 'track' }, geometry: g([A, mid, B]) },
    { type: 'way', id: 2, tags: { highway: 'track' }, geometry: g([mid, side]) }];
  const rb = await RB.generate(st, { heightFn: () => 50, osm: { elements } });
  assert.ok(rb.boxes.length > 1);
})
