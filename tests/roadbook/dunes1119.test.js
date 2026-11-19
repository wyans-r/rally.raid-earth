// 0.6.0 dune recce line and caution notes (no network)
const test = require('node:test'), assert = require('node:assert');
const RB = require('../../stage-builder/roadbook-gen.js');
const { dest, dist } = RB.geo;

function line(km, brg, mode, p0) {
  p0 = p0 || [-20, 13];
  const p1 = dest(p0, brg, km * 1000);
  return { format: 'rallyraid-stage', schemaVersion: 1, id: 't', name: 'T',
    waypoints: [{ id: 'a', n: 0, type: 'DSS', lat: p0[0], lon: p0[1], km: 0 }, { id: 'b', n: 1, type: 'ASS', lat: p1[0], lon: p1[1], km }],
    route: { legs: [{ from: 'a', to: 'b', mode, km, points: [p0, p1] }] } };
}
const along = (stage, f) => (lat, lon) => {
  const p0 = [stage.waypoints[0].lat, stage.waypoints[0].lon];
  const brg = RB.geo.bearing(p0, [stage.waypoints[1].lat, stage.waypoints[1].lon]);
  const d = dist(p0, [lat, lon]), a = RB.geo.bearing(p0, [lat, lon]);
  return f(d * Math.cos((a - brg) * Math.PI / 180), d * Math.sin((a - brg) * Math.PI / 180));
};
function sandSquare(p0, brg, atM, halfM) {
  const c = dest(p0, brg, atM);
  const corners = [dest(dest(c, brg, halfM), brg + 90, halfM), dest(dest(c, brg, halfM), brg - 90, halfM),
    dest(dest(c, brg, -halfM), brg - 90, halfM), dest(dest(c, brg, -halfM), brg + 90, halfM)];
  corners.push(corners[0]);
  return { type: 'way', id: 1, tags: { natural: 'sand', name: 'Test Erg' }, geometry: corners.map(p => ({ lat: p[0], lon: p[1] })) };
}

test('suggestWpType: WPN in a dune field, never overrides a user-set type', () => {
  assert.strictEqual(RB.suggestWpType({ prevType: 'DSS', current: 'WPM', inDune: true }), 'WPN');
  assert.strictEqual(RB.suggestWpType({ prevType: 'DSS', current: 'WPM', inDune: false }), 'WPM');
  assert.strictEqual(RB.suggestWpType({ prevType: 'DSS', current: 'WPE', inDune: true, userSet: true }), 'WPE');
  assert.strictEqual(RB.suggestWpType({ prevType: 'DZ', current: 'FZ', inDune: true }), 'FZ');
});

test('makeSandIndex: a closed sand way contains points inside and not outside', () => {
  const p0 = [-20, 13], ring = sandSquare(p0, 0, 3000, 2000);
  const idx = RB.makeSandIndex([ring]);
  assert.ok(idx.count >= 1);
  const mid = dest(p0, 0, 3000);
  assert.ok(idx.at(mid[0], mid[1]), 'centre of the square is sand');
  const out = dest(p0, 90, 8000);
  assert.ok(!idx.at(out[0], out[1]), 'well outside is not sand');
});

test('a sand-covered off-piste leg uses a recce line, not an A* weave around a ridge', () => {
  const st = line(8, 0, 'direct'), p0 = [-20, 13];
  // sand over the whole leg, plus a 40 m ridge at 4 km with a saddle 600 m to the right
  const sand = sandSquare(p0, 0, 4000, 5000);
  const hf = along(st, (x, y) => { const ridge = 40 * Math.exp(-(((x - 4000) / 120) ** 2)); const saddle = 1 - 0.85 * Math.exp(-(((y - 600) / 250) ** 2)); return ridge * saddle; });
  const info = RB.legInDuneField([p0, st.route.legs[0].points[1]][0], st.route.legs[0].points[1], hf, RB.makeSandIndex([sand]), {});
  assert.ok(info.yes && info.fracSand > 0.5, JSON.stringify({ yes: info.yes, fracSand: info.fracSand }));
  // (0.6.2: duneDrive off = the 0.6.0 recce line as the route; the drive line is tested in dunedrive1119.test.js)
  const r = RB.planOffPiste(st, hf, [], { sandIndex: RB.makeSandIndex([sand]), duneDrive: false });
  const leg = r.stage.route.legs[0];
  assert.ok(leg.recce && leg.duneField, 'leg marked recce');
  assert.ok(r.stats[0].recce);
  // the line stays close to the CAP (does not divert 600 m to the saddle)
  const P = RB.geo.projector(-20), O = P.xy(p0);
  let maxOff = 0;
  for (const p of leg.points) maxOff = Math.max(maxOff, Math.abs(P.xy(p)[0] - O[0]));
  assert.ok(maxOff < 250, 'recce line wandered ' + maxOff + ' m off the heading (should not go to the 600 m saddle)');
  // distances are along the recce line
  assert.ok(Math.abs(leg.km * 1000 - leg.points.slice(1).reduce((s, p, i) => s + dist(leg.points[i], p), 0)) < 2);
});

test('0.6.2: height ripples alone (no mapped sand) are NOT a dune field; with duneNeedsSand off they still are', () => {
  const st = line(8, 0, 'direct');
  // 16 m dunes, 200 m wavelength, from 1 km to 7 km
  const hf = along(st, x => (x > 1000 && x < 7000) ? 8 * (1 - Math.cos(2 * Math.PI * (x - 1000) / 200)) : 0);
  const A = st.route.legs[0].points[0], B = st.route.legs[0].points[1];
  const info = RB.legInDuneField(A, B, hf, RB.makeSandIndex([]), {});
  assert.ok(!info.yes && info.fracRev >= 0.35, 'fracRev ' + info.fracRev);
  assert.ok(!RB.planOffPiste(st, hf, [], { sandIndex: RB.makeSandIndex([]) }).stage.route.legs[0].recce);
  assert.ok(RB.legInDuneField(A, B, hf, RB.makeSandIndex([]), { duneNeedsSand: false }).yes);
  // the same ripples next to mapped sand (within duneNearM) do count
  const sand = sandSquare([-20, 13], 0, 4000, 3200);
  assert.ok(RB.legInDuneField(A, B, hf, RB.makeSandIndex([sand]), {}).yes);
});

test('roadbook in a dune field: DNX, cautions for a steep drop, long gaps, calculated CAP, few boxes', async () => {
  const st = line(10, 0, 'direct'), p0 = [-20, 13];
  const sand = sandSquare(p0, 0, 5000, 6000);
  // rolling 12 m dunes, and a 50% drop at 6 km for 80 m
  const hf = along(st, x => {
    const dunes = 6 * Math.sin(x / 180 * 2 * Math.PI);
    if (x >= 6000 && x < 6080) return dunes - (x - 6000) * 0.50;
    if (x >= 6080) return dunes - 40;
    return dunes;
  });
  const rb = await RB.generate(st, { heightFn: hf, useOsm: false, sand: [sand], planOffPiste: true, density: 10 });
  const notes = rb.boxes.map(b => b.notes).join(' | ');
  assert.ok(rb.boxes.some(b => /DNX/.test(b.notes) || (b.symbols || []).includes('dunes')), 'expected DNX / dunes: ' + notes);
  const drop = rb.boxes.find(b => /STEEP DROP/.test(b.notes));
  assert.ok(drop, 'expected STEEP DROP caution: ' + notes);
  assert.ok(drop.danger >= 1);
  assert.ok(drop.danger >= 2 || drop.notes.includes('50') || /4[5-9]|5\d/.test(drop.notes));
  // calculated CAP on off-piste boxes
  const off = rb.boxes.filter(b => b.offPiste && b.capOut != null);
  assert.ok(off.length, 'off-piste boxes');
  assert.ok(off.every(b => b.capType === 'C'));
  assert.ok(off.some(b => /CAP \d{3} C/.test(b.notes || '')), notes);
  // not a dense weave: far fewer boxes than the old 4 per 10 km plus a box per dodge
  assert.ok(rb.boxes.length <= 12, 'too many boxes in a dune field: ' + rb.boxes.length + ' ' + notes);
  // distances follow the recce line (stage length equals last box km)
  assert.ok(Math.abs(rb.boxes.at(-1).km - rb.route.legs[0].km) < 0.02);
});

test('a single isolated ridge (not a dune field) is still crossed at its saddle', () => {
  const p0 = [-20, 13];
  const st = { id: 'multi', name: 'M', waypoints: [{ id: 'w0', n: 0, type: 'DSS', lat: p0[0], lon: p0[1], km: 0 }, { id: 'w1', n: 1, type: 'ASS', lat: dest(p0, 0, 6000)[0], lon: dest(p0, 0, 6000)[1], km: 6 }],
    route: { legs: [{ from: 'w0', to: 'w1', mode: 'direct', km: 6, points: [p0, dest(p0, 0, 6000)] }] } };
  const hf = along(st, (x, y) => { const ridge = 40 * Math.exp(-(((x - 3000) / 120) ** 2)); const saddle = 1 - 0.85 * Math.exp(-(((y - 600) / 250) ** 2)); return ridge * saddle; });
  const info = RB.legInDuneField(p0, dest(p0, 0, 6000), hf, RB.makeSandIndex([]), {});
  assert.ok(!info.yes, 'a single ridge must not be a dune field (fracRev ' + info.fracRev + ')');
  const leg = RB.planOffPiste(st, hf, [], {}).stage.route.legs[0];
  assert.ok(!leg.recce);
  const P = RB.geo.projector(-20), O = P.xy(p0);
  let cross = null;
  for (let k = 1; k < leg.points.length; k++) { const a = P.xy(leg.points[k - 1]), b = P.xy(leg.points[k]); const ya = a[1] - O[1], yb = b[1] - O[1]; if ((ya - 3000) * (yb - 3000) <= 0) { const t = (3000 - ya) / (yb - ya); cross = (a[0] + (b[0] - a[0]) * t) - O[0]; } }
  assert.ok(cross > 350 && cross < 850, 'crossed at ' + cross + ' m east');
});

test('capLabel marks calculated headings off-piste only', () => {
  assert.strictEqual(RB.capLabel(25, true), 'CAP 025 C');
  assert.strictEqual(RB.capLabel(25, false), 'CAP 025');
});
