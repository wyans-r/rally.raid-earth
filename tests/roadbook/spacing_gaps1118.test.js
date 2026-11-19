// 0.5.0 (18 Nov 2026): minimum box spacing + off-piste gaps of track / road legs planned round obstacles. node --test
const test = require('node:test'), assert = require('node:assert');
const RB = require('../../stage-builder/roadbook-gen.js');
const { dest, dist } = RB.geo;
const P0 = [-20, 13];
const seg = (a, b, c, d) => { const s = (p, q, r) => (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]); return s(a, b, c) * s(a, b, d) < 0 && s(c, d, a) * s(c, d, b) < 0; };
// is any point every 10 m along P inside the square lake shrunk by `inset` m (one planner cell + its simplification)
const inLake = (P, c, half, inset) => { for (let i = 1; i < P.length; i++) { const n = Math.ceil(dist(P[i - 1], P[i]) / 10); for (let k = 0; k <= n; k++) { const q = [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * k / n, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * k / n], d = dist(c, q), b = RB.geo.bearing(c, q) * Math.PI / 180; if (Math.abs(d * Math.sin(b)) < half - inset && Math.abs(d * Math.cos(b)) < half - inset) return true; } } return false; };
const crosses = (P, poly) => { for (let i = 1; i < P.length; i++) for (let k = 1; k < poly.length; k++) if (seg(P[i - 1], P[i], poly[k - 1], poly[k])) return true; return false; };
// a road leg: WP a, a 2 km straight connector east onto a road that then runs 5 km north, WP b on the road's end
function roadStage() {
  const a = P0, r0 = dest(a, 90, 2000), road = [r0]; for (let k = 1; k <= 25; k++) road.push(dest(r0, 0, k * 200));
  const b = road[road.length - 1], pts = [a].concat(road);
  return { format: 'rallyraid-stage', schemaVersion: 1, id: 'g', name: 'G',
    waypoints: [{ id: 'a', n: 0, type: 'DSS', lat: a[0], lon: a[1], km: 0 }, { id: 'b', n: 1, type: 'ASS', lat: b[0], lon: b[1] }],
    route: { legs: [{ from: 'a', to: 'b', mode: 'road', points: pts, off: [[0, 1]] }] } };
}
// a lake (closed natural=water way) 600 m across, square on the middle of the connector
function lake() {
  const c = dest(P0, 90, 1000), g = [dest(dest(c, 0, 300), 270, 300), dest(dest(c, 0, 300), 90, 300), dest(dest(c, 180, 300), 90, 300), dest(dest(c, 180, 300), 270, 300)];
  g.push(g[0]); return { type: 'way', tags: { natural: 'water' }, geometry: g.map(p => ({ lat: p[0], lon: p[1] })) };
}

test('offPieces: the connector of a road leg is an off-piste piece; short ones are not', () => {
  const st = roadStage(), o = RB.DEFAULTS;
  assert.deepStrictEqual(RB.offPieces(st, o).map(p => [p.i0, p.i1, !!p.whole]), [[0, 1, false]]);
  st.route.legs[0].points[0] = dest(st.route.legs[0].points[1], 270, 100);
  assert.strictEqual(RB.offPieces(st, o).length, 0);
  const s2 = roadStage(); s2.route.legs[0].via = 'gpx'; assert.strictEqual(RB.offPieces(s2, o).length, 0);
});

test('a road leg connector across a lake is planned round it, joined to the road, and marked off-piste', () => {
  const st = roadStage(), L = lake(), poly = L.geometry.map(g => [g.lat, g.lon]);
  assert.ok(crosses(st.route.legs[0].points.slice(0, 2), poly), 'the straight connector crosses the lake');
  const plan = RB.planOffPiste(st, () => 100, [L], Object.assign({}, RB.DEFAULTS));
  const leg = plan.stage.route.legs[0];
  assert.ok(leg.gapsPlanned);
  const P = leg.points, roadPts = st.route.legs[0].points.slice(1);
  assert.ok(P.length > st.route.legs[0].points.length, 'vertices added');
  assert.deepStrictEqual(P.slice(P.length - roadPts.length), roadPts, 'the road part is unchanged');
  assert.deepStrictEqual(P[0], st.route.legs[0].points[0]);
  const run = RB.offRuns(leg.offSegs); assert.strictEqual(run.length, 1); assert.strictEqual(run[0][0], 0);
  assert.ok(inLake(st.route.legs[0].points.slice(0, 2), dest(P0, 90, 1000), 300, 45), 'straight: through the lake');
  assert.ok(!inLake(P.slice(0, run[0][1] + 1), dest(P0, 90, 1000), 300, 45), 'the planned connector keeps out of the lake');
  // the roadbook reads the planned connector as off-piste (CAPs) and the road as road
  const S = RB.resampleRoute(plan.stage, 50);
  assert.strictEqual(S[2].mode, 'direct'); assert.strictEqual(S[S.length - 3].mode, 'road');
});

test('a track leg: only its straight gaps are re-planned; generate() puts CAP boxes on the planned connector', async () => {
  const st = roadStage(); const leg = st.route.legs[0]; leg.mode = 'track'; delete leg.off; leg.cover = { gaps: [[0, 1]] };
  const rb = await RB.generate(st, { heightFn: () => 100, useOsm: false, obstacles: [lake()], osm: { elements: [lake()] }, density: 10 });
  const rl = rb.route && rb.route.legs && rb.route.legs[0];
  assert.ok(rl && rl.gapsPlanned, 'route leg carries the planned gap');
  assert.ok(rb.boxes.some(b => b.km < 2.4 && /CAP \d{3}/.test(b.notes)), rb.boxes.map(b => b.km + ' ' + b.notes).join(' | '));
});

test('applyPlannedLine writes a planned gap into the stage as leg.off runs', () => {
  const st = roadStage(); const plan = RB.planOffPiste(st, () => 100, [lake()], Object.assign({}, RB.DEFAULTS));
  const rb = { route: { legs: plan.stage.route.legs.map(l => ({ from: l.from, to: l.to, gapsPlanned: true, points: l.points, offSegs: l.offSegs, vertexInfo: l.vertexInfo })) } };
  const out = RB.applyPlannedLine(st, rb);
  const l = out.route.legs[0]; assert.strictEqual(l.mode, 'road'); assert.ok(l.off && l.off[0][1] > 1); assert.ok(!l.cover);
  // and the generator keeps an already planned run (more than one segment) as it is
  assert.ok(RB.offPieces(out, RB.DEFAULTS).every(p => p.kept));
});

test('minimum spacing: no two boxes closer than minSpacingM unless a waypoint is involved; short partials flagged', async () => {
  // a wiggly 12 km off-piste line: a bend every 80 m would want a box every 80 m
  const pts = [P0]; let brg = 30;
  for (let k = 1; k <= 150; k++) { brg += k % 2 ? 25 : -25; pts.push(dest(pts[pts.length - 1], brg, 80)); }
  const b = pts[pts.length - 1];
  const st = { format: 'rallyraid-stage', schemaVersion: 1, id: 'w', name: 'W',
    waypoints: [{ id: 'a', n: 0, type: 'DSS', lat: P0[0], lon: P0[1], km: 0 }, { id: 'b', n: 1, type: 'ASS', lat: b[0], lon: b[1] }],
    route: { legs: [{ from: 'a', to: 'b', mode: 'direct', points: pts }] } };
  const rb = await RB.generate(st, { heightFn: (la, lo) => 100 + 30 * Math.sin(la * 3000) * Math.cos(lo * 2000), useOsm: false, planOffPiste: false, density: 40 });
  assert.strictEqual(RB.DEFAULTS.minSpacingM, 300);
  for (let i = 1; i < rb.boxes.length; i++) {
    const A = rb.boxes[i - 1], B = rb.boxes[i], gap = Math.round((B.km - A.km) * 1000);
    if (A.waypoint || B.waypoint) continue;
    assert.ok(gap >= 300 - 15, 'gap ' + gap + ' m between ' + A.notes + ' / ' + B.notes);
  }
  rb.boxes.forEach(x => { if (x.partial != null && x.partial < 0.3 && rb.boxes.indexOf(x) > 0) assert.ok(x.short, 'short flag at ' + x.km); });
});

test('0.5.2 valley runs: the valley centre unless untenable, then the min-slope line, FOLLOW VALLEY FLOOR said once', async () => {
  // a 6 km valley winding round a sine (amplitude 400 m, wavelength 3 km), walls rising 15 % either side
  const a = P0, b = dest(P0, 90, 6000);
  const curve = x => 400 * Math.sin(2 * Math.PI * x / 3000);
  const hf = (lat, lon) => { const d = dist(a, [lat, lon]), brg = RB.geo.bearing(a, [lat, lon]) * Math.PI / 180, x = d * Math.sin(brg), y = d * Math.cos(brg); return 100 + 0.15 * Math.abs(y - curve(x)); };
  const st = { format: 'rallyraid-stage', schemaVersion: 1, id: 'v', name: 'V',
    waypoints: [{ id: 'a', n: 0, type: 'DSS', lat: a[0], lon: a[1], km: 0 }, { id: 'b', n: 1, type: 'ASS', lat: b[0], lon: b[1] }],
    route: { legs: [{ from: 'a', to: 'b', mode: 'direct', points: [a, b] }] } };
  const plan = RB.planOffPiste(st, hf, [], Object.assign({}, RB.DEFAULTS, { density: 10 }));
  const runs = plan.stats[0].valley || [];
  assert.ok(runs.length >= 1, 'a valley run: ' + JSON.stringify(plan.stats[0]));
  for (const r of runs) {
    assert.ok(['min-slope', 'centre', 'planner line'].includes(r.chosen));
    // 0.5.2: the centre whenever it is tenable; the min-slope line only when the centre is not
    if (r.maxGradeCentrePct <= 22 && !/blocked/.test(r.why)) assert.strictEqual(r.chosen, 'centre', JSON.stringify(r));
    if (r.chosen === 'min-slope') assert.match(r.why, /centre untenable/);
    if (r.chosen !== 'planner line') assert.ok((r.chosen === 'min-slope' ? r.maxGradeMinSlopePct : r.maxGradeCentrePct) <= 22, JSON.stringify(r));
  }
  const rb = await RB.generate(st, { heightFn: hf, useOsm: false, density: 10 });
  const fv = rb.boxes.filter(x => /FOLLOW VALLEY FLOOR/.test(x.notes));
  assert.ok(fv.length >= 1 && fv.length <= 3, rb.boxes.map(x => x.notes).join(' | '));
  for (let i = 1; i < rb.boxes.length; i++) if (!rb.boxes[i].waypoint && !rb.boxes[i - 1].waypoint) assert.ok(rb.boxes[i].partial >= 0.285, 'gap ' + rb.boxes[i].partial);
});

// 0.5.3 (Wyans 19 Nov 2026): heavy vegetation / impassable ground on an off-piste line
test('0.5.3 lineHazards: trees, water and steep ground on a straight line; the planner goes round a wood', () => {
  const RBm = require('../../stage-builder/roadbook-gen.js');
  const wood = { type: 'way', tags: { natural: 'wood' }, geometry: [[31.0, -7.004], [31.0, -6.996], [31.01, -6.996], [31.01, -7.004], [31.0, -7.004]].map(p => ({ lat: p[0], lon: p[1] })) };
  const flat = () => 500;
  const h1 = RBm.lineHazards([[30.99, -7.0], [31.02, -7.0]], { obstacles: [wood], hfn: flat });
  assert.ok(h1.blocked && h1.m.trees > 1000 && /trees/.test(h1.text), JSON.stringify(h1));
  assert.ok(!RBm.lineHazards([[30.99, -7.02], [31.02, -7.02]], { obstacles: [wood], hfn: flat }).blocked);
  // ESA WorldCover tree cover (10) and water (80) count too; shrubland (20) does not
  const cov = (la) => la > 31.0 && la < 31.002 ? 10 : la > 31.005 && la < 31.006 ? 80 : 20;
  const h2 = RBm.lineHazards([[30.99, -7.02], [31.02, -7.02]], { obstacles: [], coverAt: cov, hfn: flat });
  assert.ok(h2.m.trees >= 200 && h2.m.water >= 100 && !h2.m.scrub, JSON.stringify(h2));
  // steep: a 70 % face
  const h3 = RBm.lineHazards([[30.99, -7.02], [31.02, -7.02]], { obstacles: [], hfn: (la) => la * 111320 * 0.7 });
  assert.ok(h3.m['ground over 60 %'] > 2000);
  // the planner round the wood: the planned line crosses no trees, the straight line 1.1 km
  const r = RBm.planLeg([30.99, -7.0], [31.02, -7.0], flat, [wood], Object.assign({}, RBm.DEFAULTS, { planNoise: 0 }), 't');
  const hp = RBm.lineHazards(r.points, { obstacles: [wood], hfn: flat });
  assert.ok(!hp.blocked, JSON.stringify(hp) + ' ' + JSON.stringify(r.points));
});
