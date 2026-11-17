// The in-game planner's model (mod/ui/modules/apps/RallyRaidPlanner/planner-core.js), no game and no network:
// node --test tests/planner/
// Also writes tests/fixtures/planner/ingame-test-stage(.roadbook).json, which tests/planner_test.lua loads into the
// rally computer and tests/browser/planner_app_test.js opens in the website's builder and editor.
const test = require('node:test'), assert = require('node:assert'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'mod/ui/modules/apps/RallyRaidPlanner');
const PC = require(path.join(APP, 'planner-core.js'));
const RB = require(path.join(APP, 'roadbook-gen.js'));
const FIX = path.join(ROOT, 'tests/fixtures/planner');

// a drive: from p0, pieces of [metres, heading, climb %], one point every 10 m as the game records it ([lat, lon, alt])
function dest(p, brg, d) { return RB.geo.dest(p, brg, d); }
function driveFrom(p0, alt0, parts) {
  const out = [[p0[0], p0[1], alt0]]; let p = p0, alt = alt0;
  for (const [m, hdg, climb] of parts) for (let d = 10; d <= m; d += 10) { p = dest(p, hdg, 10); alt += (climb || 0) / 100 * 10; out.push([+p[0].toFixed(6), +p[1].toFixed(6), +alt.toFixed(1)]); }
  return out;
}
const at = q => ({ lat: q[0], lon: q[1] });
const DSS = [38.567602, -109.531389];
// 1.2 km north-east with a bend, 1.5 km east over a hill (12 % up, a rounded top, 12 % down), 0.8 km south-east
const LEG1 = driveFrom(DSS, 1350, [[600, 40, 0], [600, 60, 0]]);
const LEG2 = driveFrom(LEG1[LEG1.length - 1], 1350, [[300, 90, 0], [300, 92, 12], [100, 92, 4], [100, 92, -4], [300, 92, -12], [400, 95, 0]]);
const LEG3 = driveFrom(LEG2[LEG2.length - 1], 1350, [[800, 135, 0]]);

function buildDriven() {
  const s = PC.newStage('In-game test stage');
  PC.addPoint(s, at(DSS), { piece: [] });
  PC.addPoint(s, at(LEG1[LEG1.length - 1]), { piece: LEG1, type: 'WPV' });
  PC.addPoint(s, at(LEG2[LEG2.length - 1]), { piece: LEG2.slice(1), type: 'WPM' });
  PC.addPoint(s, at(LEG3[LEG3.length - 1]), { piece: LEG3.slice(1), type: 'ASS' });
  return s;
}

test('SHA-256 shim = node crypto (the roadbook stage hash needs it where crypto.subtle is missing)', async () => {
  for (const s of ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), '\u00e9\u2d43\ud83d\ude00'.repeat(40), JSON.stringify(buildDriven().points)])
    assert.strictEqual(PC.sha256Hex(s), crypto.createHash('sha256').update(s).digest('hex'));
  const win = {};
  assert.strictEqual(PC.installCryptoShim(win), 'shim');
  const buf = await win.crypto.subtle.digest('SHA-256', new TextEncoder().encode('rally'));
  assert.strictEqual(Buffer.from(buf).toString('hex'), crypto.createHash('sha256').update('rally').digest('hex'));
  assert.strictEqual(PC.installCryptoShim(globalThis), 'native');
});

test('the generator in the app is the website\'s, byte for byte', () => {
  assert.ok(fs.readFileSync(path.join(APP, 'roadbook-gen.js')).equals(fs.readFileSync(path.join(ROOT, 'stage-builder/roadbook-gen.js'))));
  assert.ok(fs.readFileSync(path.join(ROOT, 'mod/ui/modules/apps/RallyRaidRoadbook/roadbook-render.js')).equals(fs.readFileSync(path.join(ROOT, 'stage-builder/roadbook-render.js'))));
});

test('every shipped stage: planner import -> export keeps the file (only generator / modified change)', () => {
  let n = 0;
  for (const d of ['mod/rallyraid/stages', 'stage-builder/examples']) for (const f of fs.readdirSync(path.join(ROOT, d))) {
    if (!f.endsWith('.json') || f.includes('.roadbook.')) continue;
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, d, f)));
    if (j.format !== 'rallyraid-stage') continue;
    const o = JSON.parse(JSON.stringify(PC.exportStage(PC.importStage(j))));
    for (const k of ['generator', 'modified']) { delete j[k]; delete o[k]; }
    assert.deepStrictEqual(o, j, f); assert.strictEqual(JSON.stringify(o), JSON.stringify(j), f + ": same field order"); n++;
  }
  assert.ok(n >= 30, 'stages checked: ' + n);
});

test('roadbook stage hash of an exported, unchanged stage = the one in its shipped roadbook', async () => {
  for (const id of ['moab-sand-flats-ss1', 'ksa-hail-jubbah-nafud', 'nam-ss2-terrace-bay-mowe-bay-dunes']) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod/rallyraid/stages', id + '.json')));
    const rb = JSON.parse(fs.readFileSync(path.join(ROOT, 'mod/rallyraid/roadbooks', id + '.roadbook.json')));
    const o = PC.exportStage(PC.importStage(j));
    assert.strictEqual(await PC.roadbookFits(RB, rb, o), 'ok', id);
    const s = PC.importStage(j); PC.movePoint(s, 1, { lat: s.points[1].lat + 0.001, lon: s.points[1].lon });
    assert.strictEqual(await PC.roadbookFits(RB, rb, PC.exportStage(s)), 'stale', id + ' moved');
  }
});

test('building a stage by driving: DSS, driven legs (track), types, numbering, km and CAP', () => {
  const s = buildDriven();
  const o = PC.exportStage(s);
  assert.deepStrictEqual(o.waypoints.map(w => w.type), ['DSS', 'WPV', 'WPM', 'ASS']);
  assert.deepStrictEqual(o.waypoints.map(w => w.n), [0, 1, 2, 3]);
  assert.deepStrictEqual(o.route.legs.map(l => l.mode), ['track', 'track', 'track']);
  assert.ok(Math.abs(o.lengthKm - 3.5) < 0.05, 'length ' + o.lengthKm);
  assert.ok(Math.abs(o.waypoints[1].km - 1.2) < 0.02 && Math.abs(o.waypoints[2].km - 2.7) < 0.03, 'km ' + o.waypoints.map(w => w.km));
  assert.ok(Math.abs(o.waypoints[0].cap - 40) <= 1 && Math.abs(o.waypoints[2].cap - 135) <= 1, 'cap ' + o.waypoints.map(w => w.cap));
  assert.deepStrictEqual(PC.problems(s).filter(p => p[0] === 'err'), []);
  assert.ok(o.route.legs[0].points.length > 100 && o.route.legs[0].points.every(p => p.length === 2), 'leg points are [lat, lon] (heights stay in the planner\'s drive file)');
  assert.strictEqual(o.format, 'rallyraid-stage'); assert.strictEqual(o.id, 'in-game-test-stage');
  assert.ok(/ingame-planner/.test(o.generator));
  // the box list (the builder's roadbook.boxes) has every point with lat / lon, so the website can import it
  assert.deepStrictEqual(o.roadbook.boxes.map(b => b.label), ['DSS', 'WPV 1', 'WPM 2', 'ASS']);
});

test('a piece that does not start near the previous point is not used (straight leg); adding after the ASS moves the finish on', () => {
  const s = buildDriven();
  const far = driveFrom(dest(DSS, 0, 5000), 1300, [[500, 90, 0]]);
  const r = PC.addPoint(s, at(far[far.length - 1]), { piece: far });
  assert.strictEqual(r.point.leg.mode, 'direct');
  assert.deepStrictEqual(r.said, ['the old ASS is now a WPV']);
  assert.strictEqual(s.points[3].type, 'WPV'); assert.strictEqual(r.point.type, 'ASS', 'the next point after an ASS is the new ASS');
  assert.deepStrictEqual(PC.problems(s).filter(p => p[0] === 'err'), []);
  PC.addPoint(s, at(dest(far[far.length - 1], 90, 500)), { type: 'WPC' });
  assert.ok(PC.problems(s).some(p => p[0] === 'err' && /last GPS point must be the ASS/.test(p[1])));
});

test('problems: what the game would refuse (same rules as rallyRaid/stages.lua)', () => {
  const s = PC.newStage('x');
  assert.ok(PC.problems(s).some(p => /No points yet/.test(p[1])));
  PC.addPoint(s, at(DSS), { type: 'WPV' });
  PC.addPoint(s, at(dest(DSS, 90, 3000)), { type: 'DZ' });
  PC.addPoint(s, at(dest(DSS, 90, 6000)), { type: 'ASS' });
  s.points[1].speedLimit = 0;
  const e = PC.problems(s).filter(p => p[0] === 'err').map(p => p[1]).join(' | ');
  assert.ok(/first GPS point must be the DSS/.test(e) && /needs a speed limit/.test(e) && /never closed/.test(e), e);
  assert.strictEqual(PC.nextType(PC.newStage('y')), 'DSS');
});

test('INSERT HERE splits the nearest leg at the car and keeps the driven line on both sides', () => {
  const s = buildDriven();
  const before = PC.exportStage(s).lengthKm;
  const q = LEG2[90];                               // 900 m along leg 2 (on the hill)
  const r = PC.insertPoint(s, { lat: q[0] + 0.0002, lon: q[1] }, { type: 'WPE' });   // ~22 m off the line
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.index, 2); assert.ok(r.offM < 30, 'off ' + r.offM);
  const o = PC.exportStage(s);
  assert.deepStrictEqual(o.waypoints.map(w => w.type), ['DSS', 'WPV', 'WPE', 'WPM', 'ASS']);
  assert.deepStrictEqual(o.route.legs.map(l => l.mode), ['track', 'track', 'track', 'track']);
  assert.ok(Math.abs(o.waypoints[2].km - 2.1) < 0.05, 'WPE km ' + o.waypoints[2].km);
  assert.ok(o.lengthKm - before < 0.06 && o.lengthKm >= before, 'length kept (+ the detour to the car): ' + before + ' -> ' + o.lengthKm);
  const far = PC.insertPoint(s, at(dest(DSS, 270, 2000)));
  assert.ok(/m from the route/.test(far.error), far.error);
});

test('MOVE HERE: a small move re-joins the legs, a big one straightens them (flagged); DELETE joins the legs', () => {
  let s = buildDriven();
  let r = PC.movePoint(s, 1, { lat: s.points[1].lat + 0.0005, lon: s.points[1].lon });   // ~55 m
  assert.ok(!r.straightened && r.movedM > 50 && r.movedM < 60);
  assert.strictEqual(s.points[1].leg.mode, 'track'); assert.strictEqual(s.points[2].leg.mode, 'track');
  assert.deepStrictEqual(s.points[1].leg.points[s.points[1].leg.points.length - 1], [s.points[1].lat, s.points[1].lon]);
  assert.deepStrictEqual(s.points[2].leg.points[0], [s.points[1].lat, s.points[1].lon]);
  r = PC.movePoint(s, 1, { lat: s.points[1].lat + 0.005, lon: s.points[1].lon });          // ~550 m
  assert.ok(r.straightened);
  assert.strictEqual(s.points[1].leg.mode, 'direct'); assert.ok(s.points[1].leg.straightened);
  assert.ok(PC.problems(s).some(p => p[0] === 'warn' && /made straight/.test(p[1])));
  assert.ok(!('straightened' in PC.exportStage(s).route.legs[0]), 'the flag is not written to the file');
  s = buildDriven();
  const len = PC.exportStage(s).lengthKm;
  PC.deletePoint(s, 2);
  const o = PC.exportStage(s);
  assert.deepStrictEqual(o.route.legs.map(l => l.mode), ['track', 'track']);
  assert.ok(Math.abs(o.lengthKm - len) < 0.001, 'joined line keeps the length');
  PC.shiftPoint(s, 1, 1);
  assert.deepStrictEqual(PC.exportStage(s).waypoints.map(w => w.type), ['DSS', 'ASS', 'WPV']);
  assert.ok(PC.exportStage(s).route.legs.every(l => l.mode === 'direct'));
});

test('ROAD legs: routed through OSRM when online, straight + flagged when it fails', async () => {
  const s = buildDriven();
  const mid = dest(DSS, 45, 600);
  const ok = await PC.routeRoadLeg(s, 1, async url => { assert.ok(/router\.project-osrm\.org\/route\/v1\/driving\//.test(url)); return { code: 'Ok', routes: [{ geometry: { coordinates: [[DSS[1], DSS[0]], [mid[1], mid[0]], [s.points[1].lon, s.points[1].lat]] } }] }; });
  assert.ok(ok.ok); assert.strictEqual(s.points[1].leg.mode, 'road'); assert.strictEqual(s.points[1].leg.points.length, 3);
  const bad = await PC.routeRoadLeg(s, 2, async () => { throw new Error('Failed to fetch'); });
  assert.ok(!bad.ok); assert.strictEqual(s.points[2].leg.mode, 'direct'); assert.ok(s.points[2].leg.failed);
  assert.ok(PC.problems(s).some(p => /could not be routed/.test(p[1])));
  assert.strictEqual(PC.setLegMode(s, 3, 'track'), 'ok');
  assert.strictEqual(PC.setLegMode(s, 2, 'track'), 'no-line');
});

test('network check: fails, answers, hangs', async () => {
  assert.strictEqual(await PC.probeOnline(async () => { throw new Error('offline'); }), false);
  assert.strictEqual(await PC.probeOnline(async () => ({ ok: true, status: 200 })), true);
  assert.strictEqual(await PC.probeOnline((u, o) => new Promise((res, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))), null, 50), false);
  assert.strictEqual(await PC.probeOnline(null), false);
});

let RBX = null, STAGE = null;
test('offline roadbook: generated from the route and the heights the car recorded (crest found), valid for the website', async () => {
  const s = buildDriven();
  STAGE = PC.exportStage(s);
  const drive = LEG1.concat(LEG2, LEG3);
  const g = await PC.generateRoadbook(RB, STAGE, { online: false, drive, density: 10 });   // a short stage: 4 boxes / 10 km would prune the hill
  const rb = g.rb; RBX = rb;
  assert.strictEqual(g.mode, 'driven-heights'); assert.strictEqual(rb.partial, 'driven-heights');
  assert.strictEqual(rb.format, 'rallyraid-roadbook'); assert.strictEqual(rb.schemaVersion, 1);
  assert.strictEqual(rb.stage.id, 'in-game-test-stage'); assert.strictEqual(rb.stage.hash, await RB.stageHash(STAGE));
  const live = rb.boxes.filter(b => !b.deleted);
  assert.deepStrictEqual(live.filter(b => b.waypoint).map(b => b.label), ['DSS', 'WPV 1', 'WPM 2', 'ASS']);
  const kinds = live.flatMap(b => (b.features || []).map(f => f.kind));
  assert.ok(kinds.includes('crest') || kinds.includes('climb') || kinds.includes('descent'), 'terrain from the driven heights: ' + kinds.join(','));
  const hill = live.filter(b => (b.features || []).some(f => /^(crest|climb|descent|jump)$/.test(f.kind)));
  assert.ok(hill.length && hill.every(b => b.km > 1.4 && b.km < 2.6), 'terrain boxes only on the hill (1.5-2.3 km): ' + hill.map(b => b.km + ' ' + b.features.map(f => f.kind)).join('; '));
  assert.ok(rb.sources.elevation.name === 'driven-line' && rb.sources.elevation.coveragePct >= 90);
  assert.strictEqual(rb.ingame.mode, 'driven-heights');
  // without any recorded heights: route only, the profile is empty, not a fake flat line
  const g2 = await PC.generateRoadbook(RB, STAGE, { online: false, drive: [] });
  assert.strictEqual(g2.mode, 'route-only'); assert.ok(g2.rb.profile.h.every(h => h === null));
  assert.ok(g2.rb.boxes.filter(b => !b.deleted).length >= 4);
  // online but the tiles fail -> falls back
  // (no real network here: the map servers' fetch fails too)
  const realFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('offline (test)'); };
  try {
    const g3 = await PC.generateRoadbook(RB, STAGE, { online: true, drive, density: 10, fetchBytes: async () => { throw new Error('offline'); } });
    assert.strictEqual(g3.mode, 'driven-heights'); assert.ok(g3.why, 'says why it fell back');
  } finally { globalThis.fetch = realFetch; }
});

test('box edits at the car go through RoadbookGen.applyChanges as editor changes (pinned, history), like the website editor', async () => {
  const rb = JSON.parse(JSON.stringify(RBX));
  const q = LEG2[40];
  const a = PC.addBoxHere(RB, rb, STAGE, { lat: q[0] + 0.0001, lon: q[1] }, { notes: 'GATE' });
  assert.ok(!a.error, a.error);
  const b = rb.boxes.find(x => x.id === a.id);
  assert.ok(Math.abs(b.km - 1.6) < 0.03, 'km on the line ' + b.km);
  assert.ok(b.pinned && b.source === 'editor' && b.history[0].note === 'in-game planner');
  assert.ok(b.tulip && b.tulip.exit && typeof b.tulip.exit.angle === 'number');
  assert.ok(/from the roadbook/.test(PC.addBoxHere(RB, rb, STAGE, at(dest(DSS, 270, 3000))).error));
  PC.updateBox(RB, rb, a.id, { notes: 'GATE, CLOSE IT', danger: 2, symbols: PC.toggleSymbol(b, 'gate') });
  let x = rb.boxes.find(y => y.id === a.id);
  assert.strictEqual(x.notes, 'GATE, CLOSE IT'); assert.strictEqual(x.danger, 2); assert.deepStrictEqual(x.symbols, ['gate']); assert.strictEqual(x.rev, 2);
  const a0 = x.tulip.exit.angle || 0;
  PC.updateBox(RB, rb, a.id, { tulip: PC.turnedTulip(x, -30) });
  x = rb.boxes.find(y => y.id === a.id);
  assert.strictEqual(x.tulip.exit.angle, Math.round((a0 - 30) / 5) * 5);
  assert.deepStrictEqual(PC.toggleSymbol(x, 'gate'), []);
  const q2 = LEG2[60];
  const mv = PC.moveBoxHere(RB, rb, STAGE, a.id, at(q2));
  assert.ok(!mv.error); assert.ok(Math.abs(rb.boxes.find(y => y.id === a.id).km - 1.8) < 0.03);
  const wp = rb.boxes.find(y => y.waypoint && y.label === 'WPV 1');
  assert.ok(/cannot be deleted/.test(PC.deleteBox(RB, rb, wp.id).error));
  const auto = rb.boxes.find(y => !y.waypoint && !y.pinned && !y.deleted);
  PC.deleteBox(RB, rb, auto.id);
  assert.ok(rb.boxes.find(y => y.id === auto.id).deleted);
  // numbering stays 1..N over the live boxes, in km order
  const live = PC.liveBoxes(rb);
  assert.deepStrictEqual(live.map(y => y.n), live.map((_, i) => i + 1));
  // regenerate keeps every edit and the deletion
  const g = await PC.generateRoadbook(RB, STAGE, { online: false, drive: LEG1.concat(LEG2, LEG3), old: rb });
  assert.strictEqual(g.rb.settings.density, 10, 'regenerate keeps the density');
  assert.ok(g.merged);
  const kept = g.rb.boxes.find(y => y.id === a.id);
  assert.ok(kept && kept.notes === 'GATE, CLOSE IT' && kept.danger === 2 && !kept.deleted, 'edited box kept');
  assert.ok(g.rb.boxes.find(y => y.id === auto.id && y.deleted), 'deleted box stays deleted');
  RBX = g.rb;
});

test('draft round trip; fixtures for the Lua and browser tests (ASCII JSON, readable by both)', () => {
  const s = buildDriven();
  const d = PC.readDraft(JSON.parse(PC.asciiJSON(PC.draft(s, RBX, LEG1))));
  assert.strictEqual(d.stage.points.length, 4); assert.strictEqual(d.rb.id, RBX.id); assert.strictEqual(d.drive.length, LEG1.length);
  assert.throws(() => PC.readDraft({ format: 'x' }));
  const st = JSON.parse(JSON.stringify(STAGE)); st.id = 'ingame-test-stage'; st.name = 'In-game test stage';
  const rb = JSON.parse(JSON.stringify(RBX)); rb.stage.id = 'ingame-test-stage'; rb.id = 'ingame-test-stage-rb';
  // non-ASCII survives the ASCII form
  rb.boxes.find(b => b.label === 'WPV 1').notes = 'PISTE \u00c9TROITE';
  const t1 = PC.asciiJSON(st), t2 = PC.asciiJSON(rb);
  assert.ok(!/[^\x00-\x7f]/.test(t2) && /\\u00c9/.test(t2));
  assert.strictEqual(JSON.parse(t2).boxes.find(b => b.label === 'WPV 1').notes, 'PISTE \u00c9TROITE');
  fs.mkdirSync(FIX, { recursive: true });
  fs.writeFileSync(path.join(FIX, 'ingame-test-stage.json'), t1);
  fs.writeFileSync(path.join(FIX, 'ingame-test-stage.roadbook.json'), t2);
  fs.writeFileSync(path.join(FIX, 'ingame-test-stage.drive.json'), JSON.stringify({ format: 'rallyraid-planner-drive', schemaVersion: 1, stage: 'ingame-test-stage', points: LEG1.concat(LEG2.slice(1), LEG3.slice(1)) }));
});
