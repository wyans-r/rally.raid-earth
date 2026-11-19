// "Tracks & paths" leg router (stage-builder/track-router.js): way classes, query boxes, graph + A*, gaps, cache.
// node --test tests/track_router.test.js   (offline: synthetic ways + a saved Overpass answer from Merzouga)
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path');
const TR = require('../stage-builder/track-router.js');

// a little world near Merzouga: metres -> lat / lon
const LAT0 = 31.0, LON0 = -4.0, KY = 111195, KX = 111195 * Math.cos(LAT0 * Math.PI / 180);
const ll = (x, y) => [LAT0 + y / KY, LON0 + x / KX];
let nid = 1, wid = 1;
function way(tags, pts, ids) {
  const nodes = ids || pts.map(() => nid++);
  return { type: 'way', id: wid++, tags, nodes, geometry: pts.map(p => { const q = ll(p[0], p[1]); return { lat: q[0], lon: q[1] }; }) };
}
const answer = els => ({ elements: els });

test('way classes: tracks, paths and unpaved lanes in; paved / major roads out; footways last', () => {
  assert.strictEqual(TR.wayCost({ highway: 'track' }), 1);
  assert.ok(TR.wayCost({ highway: 'track', tracktype: 'grade5' }) > 1);
  assert.ok(TR.wayCost({ highway: 'path' }) > 1);
  assert.strictEqual(TR.wayCost({ highway: 'unclassified', surface: 'dirt' }), 1);
  assert.ok(TR.wayCost({ highway: 'unclassified' }) > 1);
  assert.ok(TR.wayCost({ highway: 'service', surface: 'gravel' }) > 0);
  assert.ok(TR.wayCost({ highway: 'service', surface: 'asphalt' }) > 1.5, 'paved service: a connector only (1.1.0)');
  assert.strictEqual(TR.wayCost({ highway: 'service', service: 'parking_aisle' }), null);
  assert.strictEqual(TR.wayCost({ highway: 'primary' }), null);
  // 1.1.0: village streets and tertiary / secondary roads connect track networks (dearer than tracks, cheaper than a gap)
  assert.ok(TR.wayCost({ highway: 'tertiary' }) > 1.5 && TR.wayCost({ highway: 'tertiary' }) < TR.DEFAULTS.gapCost);
  assert.ok(TR.wayCost({ highway: 'residential' }) > 1.2 && TR.wayCost({ highway: 'residential' }) < TR.DEFAULTS.gapCost);
  assert.ok(TR.wayCost({ highway: 'secondary', surface: 'asphalt' }) < TR.DEFAULTS.gapCost);
  assert.strictEqual(TR.wayCost({ highway: 'trunk' }), null);
  assert.ok(TR.wayCost({ highway: 'path' }) >= 1.5, 'paths are not built in BeamNG.Earth: a real track is preferred');
  assert.ok(TR.wayCost({ highway: 'tertiary', surface: 'gravel' }) > 0);
  assert.strictEqual(TR.wayCost({ highway: 'footway' }), null);
  assert.ok(TR.wayCost({ highway: 'footway', surface: 'dirt' }) > TR.wayCost({ highway: 'path' }));
  assert.strictEqual(TR.wayCost({ highway: 'track', area: 'yes' }), null);
  const q = TR.overpassQuery([31, -4.1, 31.1, -4]);
  assert.match(q, /highway~"\^\(track\|path\|bridleway\|unclassified\|road\)\$"/);
  assert.match(q, /out body geom/);
});

test('query boxes: one rounded box for a short leg, corridor tiles for a long one; margin >= 1 km', () => {
  const b = TR.queryBoxes([31.1023, -3.9604], [31.1035, -3.9946]);
  assert.strictEqual(b.length, 1);
  assert.ok(b[0][0] <= 31.1023 - 0.009 && b[0][2] >= 31.1035 + 0.009, 'about 1 km margin north / south');
  assert.deepStrictEqual(b[0].map(x => Math.round(x * 100) / 100), b[0]);
  const long = TR.queryBoxes([20.3, 45.3], [20.9, 45.9]);
  assert.ok(long.length > 1 && long.length < 30, long.length + ' tiles');
  long.forEach(t => assert.ok(Math.abs(t[2] - t[0] - 0.2) < 1e-9));
  // a diagonal leg does not fetch the far corners of its bbox
  const bb = TR.legBbox([20.3, 45.3], [20.9, 45.9]);
  const all = Math.ceil((bb[2] - bb[0]) / 0.2 + 1) * Math.ceil((bb[3] - bb[1]) / 0.2 + 1);
  assert.ok(long.length < all, long.length + ' < ' + all);
});

test('follows a winding track instead of the straight line, and ignores a paved road', async () => {
  const wiggle = []; for (let x = 0; x <= 6000; x += 200) wiggle.push([x, 600 * Math.sin(x / 1000)]);
  const els = [way({ highway: 'track', tracktype: 'grade3' }, wiggle), way({ highway: 'primary', surface: 'asphalt' }, [[0, 0], [6000, 0]])];
  let calls = 0;
  const R = TR.createRouter({ overpass: async () => { calls++; return answer(els); } });
  const a = ll(0, 30), b = ll(6000, -150);
  const r = await R.route(a, b);
  assert.strictEqual(r.status, 'ok');
  assert.ok(r.onShare > 0.97, 'on the track: ' + r.onShare);
  assert.ok(r.points.length > 25, r.points.length + ' points');
  assert.ok(r.totalM > TR.dist(a, b) * 1.05, 'longer than straight (the track winds)');
  assert.deepStrictEqual(r.points[0], [+a[0].toFixed(6), +a[1].toFixed(6)]);
  assert.deepStrictEqual(r.gapIdx, []);
  // cached: same leg again = no new request
  const r2 = await R.route(a, b);
  assert.ok(r2.cached); assert.strictEqual(calls, 1);
});

test('prefers a track to a path, and a path to an unpaved footway', async () => {
  const els = [
    way({ highway: 'footway', surface: 'dirt' }, [[0, 0], [5000, 0]]),
    way({ highway: 'path' }, [[0, 0], [0, 300], [5000, 300], [5000, 0]], [9001, 9002, 9003, 9004]),
  ];
  els[0].nodes = [9001, 9101, 9004]; els[0].geometry.splice(1, 0, { lat: ll(2500, 0)[0], lon: ll(2500, 0)[1] });
  const G = TR.buildGraph([answer(els)], LAT0);
  const r = TR.findPath(G, ll(0, 0), ll(5000, 0));
  assert.ok(r.wayM > 5400, 'took the path (5.6 km) over the footway (5 km): ' + r.wayM);
  const els2 = [way({ highway: 'path' }, [[0, 0], [5000, 0]], [1, 2]), way({ highway: 'track' }, [[0, 0], [0, 200], [5000, 200], [5000, 0]], [1, 3, 4, 2])];
  const r2 = TR.findPath(TR.buildGraph([answer(els2)], LAT0), ll(0, 0), ll(5000, 0));
  assert.ok(r2.wayM > 5300, 'a 5.4 km track beats a 5 km path (path costs 1.6 x): ' + r2.wayM);
});

test('partial network: the covered part is routed, the rest is a flagged straight gap', async () => {
  const els = [way({ highway: 'track' }, [[0, 0], [1500, 400], [3000, 0]])];
  const R = TR.createRouter({ overpass: async () => answer(els) });
  const r = await R.route(ll(0, 0), ll(7000, 0));
  assert.strictEqual(r.status, 'partial');
  assert.ok(r.wayM > 3000 && r.gapM > 3500, 'way ' + r.wayM + ' gap ' + r.gapM);
  assert.strictEqual(r.gapIdx.length, 1);
  const [i, j] = r.gapIdx[0];
  assert.strictEqual(j, r.points.length - 1, 'the gap runs to the finish');
  assert.ok(TR.dist(r.points[i], ll(3000, 0)) < 5, 'from the end of the track');
});

test('no usable way: straight, status none; ways far away are not used', async () => {
  const R = TR.createRouter({ overpass: async () => answer([way({ highway: 'track' }, [[0, 9000], [8000, 9000]])]) });
  const r = await R.route(ll(0, 0), ll(8000, 0));
  assert.strictEqual(r.status, 'none'); assert.strictEqual(r.points.length, 2); assert.deepStrictEqual(r.gapIdx, [[0, 1]]);
  const R0 = TR.createRouter({ overpass: async () => answer([]) });
  assert.strictEqual((await R0.route(ll(0, 0), ll(3000, 0))).status, 'none');
});

test('leg ends join the network with a short hop (<= 300 m); OSM ways that almost touch are joined (healed)', async () => {
  // two tracks: the second starts 20 m beside the first one's middle, without a shared node
  const els = [way({ highway: 'track' }, [[0, 0], [2000, 0], [4000, 0]]), way({ highway: 'track' }, [[2000, 20], [2000, 3000]])];
  const G = TR.buildGraph([answer(els)], LAT0);
  assert.ok(G.healed >= 1);
  const r = TR.findPath(G, ll(-150, 100), ll(2100, 3000));
  assert.ok(r.gapM === 0, 'no gap: ' + r.gapM);
  assert.ok(r.linkM > 150 && r.linkM < 300, 'hops: ' + r.linkM);
  assert.ok(r.wayM > 4900, 'along both tracks: ' + r.wayM);
});

test('real data (Merzouga, saved Overpass answer): a grade5 track is followed end to end', async () => {
  const ans = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/tracks/merzouga_31.09_-4.01_31.12_-3.94.json'), 'utf8'));
  const R = TR.createRouter({ overpass: async () => ans });
  const t0 = Date.now();
  const r = await R.route([31.102324, -3.960413], [31.103507, -3.994588]);
  assert.strictEqual(r.status, 'ok');
  assert.ok(r.onShare > 0.99 && r.points.length > 100, r.onShare + ' ' + r.points.length);
  assert.ok(Date.now() - t0 < 1000, 'fast: ' + (Date.now() - t0) + ' ms');
});

test('the Overpass hand-off: a regional mirror stays sticky only inside its region', async () => {
  const asked = [];
  const RB = { DEFAULTS: { overpassRegional: [{ ep: 'https://na.example/api', s: 14, w: -170, n: 83, e: -51 }] },
    askOverpass: async (q, o) => { asked.push(o._overpassSticky || null); return { elements: [] }; } };
  const o = { _overpassSticky: 'https://na.example/api' };
  const ask = TR.viaRoadbookGen(RB, o);
  await ask('q', [38.5, -109.6, 38.6, -109.4]);   // Moab: keeps the North America copy
  await ask('q', [31.0, -4.1, 31.1, -4.0]);       // Morocco: must not ask it
  assert.deepStrictEqual(asked, ['https://na.example/api', null]);
  o._overpassSticky = 'https://overpass-api.de/api/interpreter';
  await ask('q', [31.0, -4.1, 31.1, -4.0]);
  assert.strictEqual(asked[2], 'https://overpass-api.de/api/interpreter', 'a world-wide mirror stays sticky');
});

test('an empty answer is not stored in the persistent cache; others are', async () => {
  const put = [];
  const R = TR.createRouter({ overpass: async q => answer(/31\.0[0-9]/.test(q) ? [way({ highway: 'track' }, [[0, 0], [2000, 0]])] : []), cachePut: (k, v) => put.push([k, v.elements.length]) });
  await R.route(ll(0, 0), ll(2000, 0));
  await R.route([20.4, 45.5], [20.42, 45.52]);
  assert.strictEqual(put.length, 1); assert.ok(put[0][1] > 0);
});

test('an Overpass failure is an error (the builder draws the leg straight and says so)', async () => {
  let n = 0;
  const R = TR.createRouter({ overpass: async () => { n++; throw new Error('HTTP 504'); } });
  await assert.rejects(R.route(ll(0, 0), ll(3000, 0)), /504/);
  assert.strictEqual(n, 2, 'asked twice (one retry)');
  let m = 0;
  const R1 = TR.createRouter({ overpass: async () => { if (!m++) throw new Error('no answer in 10 s'); return answer([way({ highway: 'track' }, [[0, 0], [3000, 0]])]); } });
  assert.strictEqual((await R1.route(ll(0, 0), ll(3000, 0))).status, 'ok', 'the retry answers');
  const R2 = TR.createRouter({ overpass: async () => answer([]) });
  await assert.rejects(R2.route([20, 45], [21.5, 45]), /add waypoints/);
});

test('a leg inside an area already loaded asks nothing new', async () => {
  let calls = 0;
  const els = [way({ highway: 'track' }, [[0, 0], [9000, 0]])];
  const R = TR.createRouter({ overpass: async () => { calls++; return answer(els); } });
  await R.route(ll(0, 0), ll(9000, 0));
  await R.route(ll(3000, 0), ll(5000, 0));
  assert.strictEqual(calls, 1);
});

test('1.1.0: two track networks joined by a paved village street are routed through it (no straight gap)', () => {
  // track A 0..3 km, a 1.5 km paved residential street 3..4.5 km (shared nodes), track B 4.5..8 km, offset 2 km north
  const els = [
    way({ highway: 'track', tracktype: 'grade3' }, [[0, 0], [1500, 300], [3000, 2000]], [1, 2, 3]),
    way({ highway: 'residential', surface: 'asphalt' }, [[3000, 2000], [3700, 2600], [4500, 2000]], [3, 4, 5]),
    way({ highway: 'track' }, [[4500, 2000], [6000, 300], [8000, 0]], [5, 6, 7])];
  const r = TR.findPath(TR.buildGraph([answer(els)], LAT0), ll(0, 0), ll(8000, 0));
  assert.ok(r.gapM < 1, 'no gap: ' + r.gapM);
  assert.ok(r.wayM > 9000, 'along the tracks and the street: ' + r.wayM);
  // a primary road is still not used: the same link as primary = a gap
  els[1].tags = { highway: 'primary', surface: 'asphalt' };
  const r2 = TR.findPath(TR.buildGraph([answer(els)], LAT0), ll(0, 0), ll(8000, 0));
  assert.ok(r2.gapM > 500, 'primary is road mode only: gap ' + r2.gapM);
  assert.match(TR.overpassQuery([31, -4.1, 31.1, -4]), /residential\|living_street\|tertiary\|tertiary_link\|secondary/);
});
