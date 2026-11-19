// 0.6.1: progress bar and speed (no network). The page shows e.frac; it must never go backwards, every phase must be
// covered, and the dune / sand steps must not block for long. The fast sand index must give the same answers as before.
const test = require('node:test'), assert = require('node:assert');
const RB = require('../../stage-builder/roadbook-gen.js');
const { dest } = RB.geo;

function stage(km, brg, p0) {
  p0 = p0 || [30.9, -4.0];
  const pts = [p0]; for (let k = 1; k <= 4; k++) pts.push(dest(p0, brg, km * 250 * k));
  const wp = pts.map((p, i) => ({ id: 'w' + i, n: i, type: i === 0 ? 'DSS' : i === 4 ? 'ASS' : 'WPM', lat: p[0], lon: p[1], km: km * i / 4 }));
  return { format: 'rallyraid-stage', schemaVersion: 1, id: 'p', name: 'P', waypoints: wp,
    route: { legs: wp.slice(1).map((w, i) => ({ from: wp[i].id, to: w.id, mode: 'direct', km: km / 4, points: [[wp[i].lat, wp[i].lon], [w.lat, w.lon]] })) } };
}
// an erg-like sand polygon with many nodes (a wobbly circle), as OSM maps the big ergs
function bigErg(c, rM, n) {
  const g = []; for (let i = 0; i < n; i++) { const a = i / n * 360, r = rM * (1 + 0.15 * Math.sin(i * 0.37) + 0.05 * Math.cos(i * 1.7)); const p = dest(c, a, r); g.push({ lat: p[0], lon: p[1] }); }
  g.push(g[0]);
  return { type: 'way', id: 7, tags: { natural: 'sand', name: 'Big Erg' }, geometry: g };
}
const dunes = (lat, lon) => 700 + 25 * Math.sin(lat * 111320 / 180) + 15 * Math.sin(lon * 95000 / 140);

test('fast sand index gives exactly the old point-in-ring answer', () => {
  const c = [30.9, -4.0], erg = bigErg(c, 15000, 6000), idx = RB.makeSandIndex([erg]);
  const ring = erg.geometry.map(p => [p.lat, p.lon]);
  let inside = 0;
  for (let i = 0; i < 4000; i++) {
    const p = dest(c, (i * 137.5) % 360, (i * 7.3) % 19000);
    const a = !!idx.at(p[0], p[1]), b = RB.latLonInRing(p[0], p[1], ring);
    assert.strictEqual(a, b, 'point ' + i); if (a) inside++;
  }
  assert.ok(inside > 1000 && inside < 4000);
  // vertices and edge midpoints (boundary cases)
  for (let i = 0; i + 1 < ring.length; i += 13) {
    const m = [(ring[i][0] + ring[i + 1][0]) / 2, (ring[i][1] + ring[i + 1][1]) / 2];
    assert.strictEqual(!!idx.at(m[0], m[1]), RB.latLonInRing(m[0], m[1], ring));
    assert.strictEqual(!!idx.at(ring[i][0], ring[i][1]), RB.latLonInRing(ring[i][0], ring[i][1], ring));
  }
});

test('sand index lookups are fast on a big erg polygon', () => {
  const c = [30.9, -4.0], idx = RB.makeSandIndex([bigErg(c, 15000, 20000)]);
  const t0 = Date.now();
  for (let i = 0; i < 20000; i++) { const p = dest(c, i % 360, (i * 3.1) % 14000); idx.at(p[0], p[1]); }
  assert.ok(Date.now() - t0 < 1500, '20 000 lookups took ' + (Date.now() - t0) + ' ms');
});

test('progress: frac only goes forward, covers sand / plan / assemble, ends at 1; no long main-thread block', async () => {
  const st = stage(40, 80), c = [30.9, -4.0];
  const ev = [];
  let last = Date.now(), maxGap = 0; const iv = setInterval(() => { const n = Date.now(); maxGap = Math.max(maxGap, n - last); last = n; }, 5);
  const osmEmpty = { elements: [] };
  const rb = await RB.generate(st, { heightFn: dunes, sand: [bigErg(dest(c, 80, 20000), 15000, 8000)], fetchOverpass: async () => osmEmpty, overpassRace: true,
    osmOptional: true, onPartial: () => {}, useLandCover: false, useLandmarks: false, onProgress: e => ev.push(e) });
  clearInterval(iv);
  assert.ok(rb.boxes.length > 0);
  for (const e of ev) assert.strictEqual(typeof e.frac, 'number', 'every event has frac: ' + e.phase);
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].frac >= ev[i - 1].frac, 'went back at ' + ev[i].phase + ' ' + ev[i - 1].frac + ' -> ' + ev[i].frac);
  const phases = new Set(ev.map(e => e.phase));
  for (const p of ['sand', 'plan', 'osm', 'assemble', 'done']) assert.ok(phases.has(p), 'phase ' + p);
  assert.strictEqual(ev[ev.length - 1].frac, 1);
  assert.ok(ev.some(e => e.phase === 'plan' && /dune/.test(e.msg || '')), 'a dune label shows while planning');
  assert.ok(maxGap < 1500, 'longest block ' + maxGap + ' ms');
});

test('progress: a single pass (OSM supplied) also runs 0 -> 1 without going back', async () => {
  const ev = [];
  await RB.generate(stage(10, 30), { heightFn: dunes, osm: { elements: [] }, sand: [], onProgress: e => ev.push(e) });
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].frac >= ev[i - 1].frac);
  assert.strictEqual(ev[ev.length - 1].frac, 1);
});
