// Roadbook 0.4.0 (18 Nov 2026): notes only for what BeamNG.Earth builds; rocks; TRACES; valleys / rivers; bridges
// node --test tests/roadbook/rbdata1118.test.js   (no network)
const test = require('node:test'), assert = require('node:assert');
const RB = require('../../stage-builder/roadbook-gen.js');
const { dest, dist } = RB.geo;
function line(km, brg, mode, p0) {
  p0 = p0 || [30, -5];
  const p1 = dest(p0, brg, km * 1000);
  return { format: 'rallyraid-stage', schemaVersion: 1, id: 't', name: 'T',
    waypoints: [{ id: 'a', n: 0, type: 'DSS', lat: p0[0], lon: p0[1], km: 0 }, { id: 'b', n: 1, type: 'ASS', lat: p1[0], lon: p1[1], km }],
    route: { legs: [{ from: 'a', to: 'b', mode, km, points: [p0, p1] }] } };
}
const p0of = st => [st.waypoints[0].lat, st.waypoints[0].lon];
const northOf = st => { const p0 = p0of(st); return (lat, lon) => { const d = dist(p0, [lat, lon]), a = RB.geo.bearing(p0, [lat, lon]); return d * Math.cos(a * Math.PI / 180); }; };
const gen = (stage, hf, extra) => RB.generate(stage, Object.assign({ heightFn: hf, useOsm: false, planOffPiste: false, density: 20 }, extra || {}));
const kinds = rb => rb.boxes.flatMap(b => b.features.map(f => f.kind));
const notes = rb => rb.boxes.map(b => b.km.toFixed(2) + ' ' + b.notes).join(' | ');
// a track along the whole line (nodes every 100 m), plus extra ways
function trackOsm(st, tags, extra) {
  const p0 = p0of(st), n = Math.round(st.route.legs[0].km * 10), geom = [];
  for (let k = 0; k <= n; k++) { const p = dest(p0, 0, k * 100); geom.push({ lat: p[0], lon: p[1] }); }
  return { elements: [{ type: 'way', id: 1, tags, nodes: geom.map((_, k) => 1000 + k), geometry: geom }].concat(extra || []) };
}
const way = (id, tags, pts) => ({ type: 'way', id, tags, nodes: pts.map((_, k) => id * 100 + k), geometry: pts.map(p => ({ lat: p[0], lon: p[1] })) });

test('rocks: off-piste on bare sloping ground = STONY / ROCKY; flat bare ground (no rocks in the game) = nothing', async () => {
  const st = line(6, 0, 'direct'), N = northOf(st);
  const bare = () => 60;
  // 0..3 km flat, 3..6 km a steady 8 % rise across the line (cross slope, so no CLIMB note)
  const p0 = p0of(st);
  const hf = (lat, lon) => { const x = N(lat, lon), d = dist(p0, [lat, lon]), a = RB.geo.bearing(p0, [lat, lon]), e = d * Math.sin(a * Math.PI / 180); return x < 3000 ? 100 : 100 + e * 0.08; };
  const rb = await gen(st, hf, { landCover: bare });
  const r = rb.boxes.filter(b => b.features.some(f => f.kind === 'rocks'));
  assert.ok(r.length >= 1, notes(rb));
  assert.ok(r.every(b => b.km > 2.8), 'no rocks on flat bare ground: ' + notes(rb));
  assert.match(r[0].notes, /STONY/); assert.ok(r[0].symbols.includes('rocks'));
  // steeper (15 %): ROCKY, SLOW !
  const hf2 = (lat, lon) => { const d = dist(p0, [lat, lon]), a = RB.geo.bearing(p0, [lat, lon]); return 100 + d * Math.sin(a * Math.PI / 180) * 0.15; };
  const rb2 = await gen(st, hf2, { landCover: bare });
  assert.ok(rb2.boxes.some(b => /ROCKY, SLOW !/.test(b.notes)), notes(rb2));
  // trees (WorldCover 10): no rocks even on a slope
  const rb3 = await gen(st, hf2, { landCover: () => 10 });
  assert.ok(!kinds(rb3).includes('rocks'), notes(rb3));
  // shrub (20): stones everywhere in the game
  const rb4 = await gen(st, () => 100, { landCover: () => 20 });
  assert.ok(rb4.boxes.some(b => /STONES IN VG/.test(b.notes)), notes(rb4));
});

test('rocks: surface=rock on the track = ROCKY P', async () => {
  const st = line(4, 0, 'road');
  const osm = trackOsm(st, { highway: 'track', surface: 'rock' });
  const rb = await RB.generate(st, { heightFn: () => 0, osm, planOffPiste: false });
  assert.ok(rb.boxes.some(b => /ROCKY P/.test(b.notes)), notes(rb));
});

test('bridges: an overpass the route goes under is not a BRIDGE; a bridge on the route way is; a footbridge is not', async () => {
  const st = line(4, 0, 'road'), p0 = p0of(st);
  const X = dest(p0, 0, 2000);
  const over = way(7, { highway: 'primary', bridge: 'yes', layer: '1' }, [dest(X, 270, 60), dest(X, 90, 60)]);
  const rb = await RB.generate(st, { heightFn: () => 0, osm: trackOsm(st, { highway: 'track', tracktype: 'grade2' }, [over]), planOffPiste: false });
  assert.ok(!kinds(rb).includes('bridge') && !rb.boxes.some(b => /BRIDGE/.test(b.notes)), notes(rb));
  // the route way itself has a 60 m bridge: BRIDGE
  const A = dest(p0, 0, 1500), B = dest(p0, 0, 1560), E = dest(p0, 0, 4000);
  const osm2 = { elements: [way(1, { highway: 'unclassified' }, [p0, A]), way(2, { highway: 'unclassified', bridge: 'yes' }, [A, B]), way(3, { highway: 'unclassified' }, [B, E])] };
  osm2.elements[1].nodes[0] = osm2.elements[0].nodes.at(-1); osm2.elements[2].nodes[0] = osm2.elements[1].nodes.at(-1);
  const rb2 = await RB.generate(st, { heightFn: () => 0, osm: osm2, planOffPiste: false });
  assert.ok(kinds(rb2).includes('bridge'), notes(rb2));
  // the same bridge as a footway: not built in the game
  const osm3 = JSON.parse(JSON.stringify(osm2)); osm3.elements[1].tags = { highway: 'path', bridge: 'yes' };
  const rb3 = await RB.generate(st, { heightFn: () => 0, osm: osm3, planOffPiste: false });
  assert.ok(!kinds(rb3).includes('bridge'), notes(rb3));
});

test('gates, cattle grids, plain fences are not notes (not built); a border post and a chain-link fence are', async () => {
  const st = line(6, 0, 'road'), p0 = p0of(st);
  const node = (id, m, tags) => { const p = dest(p0, 0, m); return { type: 'node', id, lat: p[0], lon: p[1], tags }; };
  const osm = trackOsm(st, { highway: 'track', tracktype: 'grade2' }, [node(1, 1000, { barrier: 'gate' }), node(2, 2000, { barrier: 'cattle_grid' }), node(3, 4000, { barrier: 'border_control' })]);
  const rb = await RB.generate(st, { heightFn: () => 0, osm, planOffPiste: false });
  assert.ok(!kinds(rb).includes('cattle_grid') && !rb.boxes.some(b => /\bGATE\b|CATTLE/.test(b.notes)), notes(rb));
  assert.ok(rb.boxes.some(b => /BORDER POST/.test(b.notes)), notes(rb));
  const so = line(6, 0, 'direct'), q0 = p0of(so), F1 = dest(q0, 0, 2000), F2 = dest(q0, 0, 4000);
  const fences = { elements: [way(8, { barrier: 'fence' }, [dest(F1, 270, 300), dest(F1, 90, 300)]), way(9, { barrier: 'fence', fence_type: 'chain_link' }, [dest(F2, 270, 300), dest(F2, 90, 300)])] };
  const rb2 = await RB.generate(so, { heightFn: () => 0, osm: fences, planOffPiste: false });
  const fb = rb2.boxes.filter(b => b.features.some(f => f.kind === 'cross_fence'));
  assert.strictEqual(fb.length, 1, notes(rb2)); assert.ok(Math.abs(fb[0].km - 4) < 0.1);
});

test('DEM bumps / crests: kept off-piste and on a track, dropped on a graded main road (the game smooths them away)', async () => {
  const st = line(6, 0, 'road'), N = northOf(st);
  const hump = (lat, lon) => { const x = N(lat, lon) - 3000; return 100 + 5 * Math.exp(-(x * x) / (2 * 25 * 25)); };
  const onTrack = await RB.generate(st, { heightFn: hump, osm: trackOsm(st, { highway: 'track', tracktype: 'grade2' }), planOffPiste: false, density: 20 });
  const onMain = await RB.generate(st, { heightFn: hump, osm: trackOsm(st, { highway: 'primary', surface: 'asphalt' }), planOffPiste: false, density: 20 });
  const crestTrack = onTrack.boxes.flatMap(b => b.features).find(f => f.kind === 'crest');
  assert.ok(crestTrack, notes(onTrack));
  const crestMain = onMain.boxes.flatMap(b => b.features).find(f => f.kind === 'crest');
  assert.ok(!crestMain || crestMain.blind, notes(onMain));
  // bumps / ditches: the gate itself (grade from BeamNG.Earth grading.py)
  assert.strictEqual(RB.gradeSigma({ highway: 'primary' }), 40); assert.strictEqual(RB.gradeSigma({ highway: 'track' }), 6);
  assert.strictEqual(RB.gradeSigma({ highway: 'path' }), 0); assert.strictEqual(RB.gradeSigma({ highway: 'unclassified', surface: 'gravel' }), 6);
  const S = RB.resampleRoute(line(2, 0, 'road'), 20);
  const fs = () => [{ i: 20, kind: 'bump', height: 2.5 }, { i: 60, kind: 'ditch', depth: 2.2 }, { i: 80, kind: 'step_up', height: 5 }];
  assert.strictEqual(RB.gateTerrain(fs(), S, S.map(() => 6), S.map(() => 'track'), null, []).length, 3);
  assert.strictEqual(RB.gateTerrain(fs(), S, S.map(() => 0), S.map(() => 'offpiste'), null, []).length, 3);
  assert.strictEqual(RB.gateTerrain(fs(), S, S.map(() => 14), S.map(() => 'tarmac'), null, []).length, 0);
  assert.strictEqual(RB.gateTerrain(fs(), S, S.map(() => 6), S.map(() => 'track'), S.map(() => 'built'), []).length, 0, 'in a town the DEM bump is a house');
  assert.strictEqual(RB.gateTerrain(fs(), S, S.map(() => 6), S.map(() => 'track'), null, [{ i: 22, kind: 'bridge' }]).length, 2, 'a bridge deck in the DEM is not a bump');
});

test('TRACES: a grade 4/5 track or a path reads FOLLOW TRACES / ON TRACES, consistently', async () => {
  assert.strictEqual(RB.TRACK_CODE.twotrack, 'TRACES'); assert.strictEqual(RB.TRACK_CODE.path, 'TRACES');
  assert.match(RB.describe({ kind: 'surface', from: 'track', to: 'twotrack' }).note, /^END P, FOLLOW TRACES$/);
  assert.match(RB.describe({ kind: 'join_track', from: 'offpiste', to: 'path' }).note, /^RP TRACES$/);
  const st = line(30, 0, 'road');
  const rb = await RB.generate(st, { heightFn: () => 0, osm: trackOsm(st, { highway: 'track', tracktype: 'grade5' }), planOffPiste: false, density: 3 });
  assert.ok(rb.boxes.some(b => /FOLLOW TRACES/.test(b.notes)), notes(rb));
  assert.ok(!rb.boxes.some(b => /P -V|P E3/.test(b.notes)), notes(rb));
});

test('along a river: ALONG RIVER onL (NAME); a dry wadi in a DEM valley: FOLLOW WADI; valley on a track: FOLLOW VALLEY', async () => {
  const st = line(6, 0, 'road'), p0 = p0of(st);
  const riv = []; for (let k = 0; k <= 40; k++) riv.push(dest(dest(p0, 0, 1000 + k * 100), 270, 70));
  const osm = trackOsm(st, { highway: 'track', tracktype: 'grade2' }, [way(5, { waterway: 'river', name: 'Draa' }, riv)]);
  const rb = await RB.generate(st, { heightFn: () => 0, osm, planOffPiste: false, density: 20 });
  assert.ok(rb.boxes.some(b => /ALONG RIVER onL \(DRAA\)/.test(b.notes)), notes(rb));
  // dry wadi + valley (both sides 8 m higher): FOLLOW WADI, and no separate FOLLOW VALLEY there
  const E = (lat, lon) => { const d = dist(p0, [lat, lon]), a = RB.geo.bearing(p0, [lat, lon]); return Math.abs(d * Math.sin(a * Math.PI / 180)); };
  const vf = (lat, lon) => 100 + Math.min(8, E(lat, lon) * 0.15);
  const osm2 = trackOsm(st, { highway: 'track', tracktype: 'grade2' }, [way(6, { waterway: 'wadi' }, riv)]);
  const rb2 = await RB.generate(st, { heightFn: vf, osm: osm2, planOffPiste: false, density: 20 });
  assert.ok(rb2.boxes.some(b => /FOLLOW WADI/.test(b.notes)), notes(rb2));
  // the same valley with no waterway: FOLLOW VALLEY
  const rb3 = await RB.generate(st, { heightFn: vf, osm: trackOsm(st, { highway: 'track', tracktype: 'grade2' }), planOffPiste: false, density: 20 });
  assert.ok(rb3.boxes.some(b => /FOLLOW VALLEY/.test(b.notes)), notes(rb3));
  // on tarmac a valley is not a note
  const rb4 = await RB.generate(st, { heightFn: vf, osm: trackOsm(st, { highway: 'secondary', surface: 'asphalt' }), planOffPiste: false, density: 20 });
  assert.ok(!rb4.boxes.some(b => /FOLLOW VALLEY/.test(b.notes)), notes(rb4));
});

test('landmarks: no wells, cairns, guideposts, boulders or point ruins (not in the game); lakes are named', () => {
  const P = { xy: ll => [ll[1] * 1e5, ll[0] * 1e5] };
  const els = [
    { type: 'node', id: 1, lat: 0, lon: 0, tags: { man_made: 'water_well' } }, { type: 'node', id: 2, lat: 0, lon: 0, tags: { man_made: 'cairn' } },
    { type: 'node', id: 3, lat: 0, lon: 0, tags: { information: 'guidepost' } }, { type: 'node', id: 4, lat: 0, lon: 0, tags: { natural: 'stone' } },
    { type: 'node', id: 5, lat: 0, lon: 0, tags: { historic: 'ruins' } }, { type: 'node', id: 6, lat: 0, lon: 0, tags: { man_made: 'mast' } }];
  const L = RB.prepLandmarks ? RB.prepLandmarks(els, P) : null;
  if (L) assert.deepStrictEqual(L.map(x => x.k), ['mast']);
  if (RB.landmarkKind) assert.match(RB.landmarkKind({ natural: 'water', water: 'lake', name: 'Lac Iriki' }).word, /^LAKE LAC IRIKI/);
});

test('rocks in dune fields too (Wyans 18 Nov): bare dunes with steep flanks get a rock note', async () => {
  const st = line(8, 0, 'direct'), N = northOf(st);
  const dunes = (lat, lon) => { const x = N(lat, lon); return x > 2000 && x < 6000 ? 100 + 12 * Math.sin(x / 150 * 2 * Math.PI) : 100; };
  const rb = await gen(st, dunes, { landCover: () => 60, duneNeedsSand: false });   // 0.6.2: heights alone only with duneNeedsSand off
  assert.ok(kinds(rb).includes('dunes'), notes(rb));
  assert.ok(rb.stats.enrich.rocks >= 1, 'rock features in the dune field: ' + rb.stats.enrich.rocks);
  const S = RB.resampleRoute(st, 20), H = S.map(s => dunes(s.lat, s.lon));
  const F = RB.rockFeatures(S, H, H, H, S.map(() => 'bare'), S.map(() => 'offpiste'), RB.DEFAULTS);
  assert.ok(F.some(f => S[f.i].km >= 1.9 && S[f.i].km < 6), JSON.stringify(F.map(f => [S[f.i].km, f.level])));
});
