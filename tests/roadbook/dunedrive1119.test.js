// 0.6.2 (Wyans 19 Nov): in a dune field the route, and so every km in the book, is the line a car drives round the
// dunes (from the terrain), while the boxes and their CAPs stay on the sparse recce line. No network.
const test = require('node:test'), assert = require('node:assert');
const RB = require('../../stage-builder/roadbook-gen.js');
const { dest, dist, bearing } = RB.geo;
const p0 = [-20, 13];
function line(km) {
  const p1 = dest(p0, 0, km * 1000);
  return { format: 'rallyraid-stage', schemaVersion: 1, id: 'dd', name: 'DD',
    waypoints: [{ id: 'a', n: 0, type: 'DSS', lat: p0[0], lon: p0[1], km: 0 }, { id: 'b', n: 1, type: 'ASS', lat: p1[0], lon: p1[1], km }],
    route: { legs: [{ from: 'a', to: 'b', mode: 'direct', km, points: [p0, p1] }] } };
}
const xy = (lat, lon) => { const d = dist(p0, [lat, lon]), a = bearing(p0, [lat, lon]) * Math.PI / 180; return [d * Math.sin(a), d * Math.cos(a)]; };   // [east, north] m
function sandSquare(halfM, cN) {
  const c = dest(p0, 0, cN), q = [dest(dest(c, 0, halfM), 90, halfM), dest(dest(c, 0, halfM), -90, halfM), dest(dest(c, 0, -halfM), -90, halfM), dest(dest(c, 0, -halfM), 90, halfM)];
  q.push(q[0]); return { type: 'way', id: 1, tags: { natural: 'sand' }, geometry: q.map(p => ({ lat: p[0], lon: p[1] })) };
}
// rolling 10 m dunes everywhere, plus three 45 m star dunes with slip faces right on the heading
const STARS = [[0, 2500], [60, 5000], [-40, 7500]];
const terrain = (lat, lon) => { const [x, y] = xy(lat, lon); let h = 5 * Math.sin(y / 300 * 2 * Math.PI) + 5 * Math.sin(x / 400 * 2 * Math.PI);
  for (const [sx, sy] of STARS) h += 45 * Math.exp(-(((x - sx) / 140) ** 2 + ((y - sy) / 140) ** 2)); return h; };

test('dune drive line goes round the big dunes; distance = the drive line; boxes stay sparse with the heading as CAP', async () => {
  const st = line(10), sand = sandSquare(6000, 5000);
  const rb = await RB.generate(st, { heightFn: terrain, useOsm: false, sand: [sand], planOffPiste: true, density: 10 });
  const leg = rb.route.legs[0];
  assert.ok(leg.drive && leg.recce && leg.duneField, 'drive line on a dune leg');
  const len = leg.points.reduce((s, p, k) => k ? s + dist(leg.points[k - 1], p) : 0, 0);
  assert.ok(Math.abs(leg.km * 1000 - len) < 2, 'leg km is the drive length');
  assert.ok(len > 10000 && len < 10000 * 1.25, 'plausible: a bit longer than the straight 10 km, ' + Math.round(len));
  assert.ok(Math.abs(rb.boxes.at(-1).km - leg.km) < 0.02, 'book distances follow the drive line');
  // it never runs over the top of a star dune
  for (const [sx, sy] of STARS) { let near = Infinity; for (let k = 1; k < leg.points.length; k++) for (let t = 0; t <= 20; t++) { const a = xy(...leg.points[k - 1]), b = xy(...leg.points[k]); near = Math.min(near, Math.hypot(a[0] + (b[0] - a[0]) * t / 20 - sx, a[1] + (b[1] - a[1]) * t / 20 - sy)); } assert.ok(near > 120, 'passes ' + Math.round(near) + ' m from a star dune top'); }
  // sparse: no box per swerve; DNX at the start, END DUNES at the end; CAPs are the heading (north), calculated
  assert.ok(leg.points.length > 4, 'the drive line swerves');
  assert.ok(rb.boxes.length <= 8, 'boxes ' + rb.boxes.length + ': ' + rb.boxes.map(b => b.notes).join(' | '));
  assert.ok(/DNX/.test(rb.boxes[0].notes), rb.boxes[0].notes);
  assert.ok(rb.boxes.some(b => /END DUNES/.test(b.notes)));
  for (const b of rb.boxes.slice(0, -1)) { assert.ok(Math.abs(RB.geo.rel(b.capOut, 0)) <= 3, 'CAP out ' + b.capOut + ' at ' + b.km); if (b.offPiste) assert.strictEqual(b.capType, 'C'); }
  for (let i = 1; i < rb.boxes.length; i++) assert.ok((rb.boxes[i].km - rb.boxes[i - 1].km) * 1000 >= 300 - 1);
  for (const b of rb.boxes) assert.ok(((b.notes || "").match(/CAP \d{3}/g) || []).length <= 1, "one CAP per box: " + b.notes);
});

test('same terrain, same line (no noise); duneDrive off gives the straight recce line', () => {
  const st = line(10), idx = RB.makeSandIndex([sandSquare(6000, 5000)]);
  const a = RB.planOffPiste(st, terrain, [], { sandIndex: idx }).stage.route.legs[0], b = RB.planOffPiste(st, terrain, [], { sandIndex: idx }).stage.route.legs[0];
  assert.deepStrictEqual(a.points, b.points);
  const c = RB.planOffPiste(st, terrain, [], { sandIndex: idx, duneDrive: false }).stage.route.legs[0];
  assert.ok(!c.drive && c.km < a.km, c.km + ' vs ' + a.km);
});

test('no mapped sand: hills are not dunes, no drive line', () => {
  const st = line(10);
  const leg = RB.planOffPiste(st, terrain, [], { sandIndex: RB.makeSandIndex([]) }).stage.route.legs[0];
  assert.ok(!leg.recce && !leg.drive && !leg.duneField);
});
