// Rally viewer: parse a rallyraid-rally file and build map geometry (no network)
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path');
const RV = require('../../stage-builder/rally-view.js');
const Share = require('../../stage-builder/share.js');

const FILE = path.join(__dirname, '../../stage-builder/rallies/atlantic-to-atlas-2027.rally.json');
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));

test('Atlantic to Atlas 2027 parses as a rally v1 file', () => {
  const p = RV.parse(raw);
  assert.ok(p.ok, p.errors.join('; '));
  assert.strictEqual(p.rally.id, 'atlantic-to-atlas-2027');
  assert.strictEqual(p.rally.days.length, 15);
  assert.strictEqual(p.rally.bivouacs.length, 8);
});

test('parse rejects a file that is not a rally', () => {
  assert.ok(!RV.parse(null).ok);
  assert.ok(!RV.parse({ format: 'rallyraid-stage', schemaVersion: 1, id: 'x', name: 'X', bivouacs: [{}], days: [{}] }).ok);
  assert.ok(!RV.parse({ format: 'rallyraid-rally', schemaVersion: 2, id: 'x', name: 'X', bivouacs: [{ id: 'a', lat: 0, lon: 0 }], days: [{ n: 1, type: 'rest', from: 'a', to: 'a' }] }).ok);
});

test('safePath only allows bundled rallies/ files', () => {
  assert.strictEqual(RV.safePath('rallies/atlantic-to-atlas-2027.rally.json', 'rally'), 'rallies/atlantic-to-atlas-2027.rally.json');
  assert.strictEqual(RV.safePath('rallies/atlantic-to-atlas-2027/stages/ata27-ss2.json', 'stage'), 'rallies/atlantic-to-atlas-2027/stages/ata27-ss2.json');
  assert.strictEqual(RV.safePath('../rallies/x.json', 'rally'), null);
  assert.strictEqual(RV.safePath('rallies/../../etc/passwd.json', 'rally'), null);
  assert.strictEqual(RV.safePath('https://evil.example/x.json', 'rally'), null);
  assert.strictEqual(RV.safePath('/etc/passwd.json', 'rally'), null);
});

test('geometry: every SS, the prologue, liaisons, the sea transfer, rest day and marathon flags', () => {
  const g = RV.geometry(raw);
  assert.ok(g.ok, (g.errors || []).join('; '));
  assert.strictEqual(g.days.length, 15);
  const stages = g.days.filter(d => d.stageLine && d.stageLine.length >= 2);
  assert.strictEqual(stages.length, 13, '13 special stages including the prologue');
  const prologue = g.days.find(d => d.code === 'P');
  assert.ok(prologue && prologue.typeLabel === 'Prologue' && prologue.stageLine);
  const rest = g.days.find(d => d.code === 'REST' || d.rest);
  assert.ok(rest && rest.rest && rest.from && rest.from.kind === 'rest');
  const marathons = g.days.filter(d => d.marathon);
  assert.strictEqual(marathons.length, 2);
  assert.ok(g.bivouacs.some(b => b.kind === 'marathon'));
  const tr = g.days.find(d => d.transfer);
  assert.ok(tr, 'transfer day');
  assert.ok(tr.teleport && tr.ferry);
  assert.strictEqual(tr.transferLabel, 'Transfer (teleport)');
  assert.ok(tr.transferLine && tr.transferLine.length >= 4);
  assert.ok(tr.transferVia && tr.transferVia.id === 'nador', 'sea crossing goes via Nador');
  assert.strictEqual(tr.liaisonKm, 590);
  // the line starts at Loulé-Faro and ends at Bouarfa
  const a = tr.transferLine[0], b = tr.transferLine.at(-1);
  assert.ok(Math.abs(a[0] - tr.from.lat) < 1e-6 && Math.abs(b[0] - tr.to.lat) < 1e-6);
  // a port via-point is actually on the line
  const viaOn = tr.transferLine.some(p => Math.abs(p[0] - tr.transferVia.lat) < 1e-6 && Math.abs(p[1] - tr.transferVia.lon) < 1e-6);
  assert.ok(viaOn, 'Nador is on the transfer line');
  // liaisons exist on stage days
  const withLiaison = g.days.filter(d => d.liaisonOut && d.liaisonIn);
  assert.ok(withLiaison.length >= 12);
  assert.ok(g.bounds && g.bounds[0][0] < g.bounds[1][0]);
});

test('great-circle length is close to the haversine distance', () => {
  const a = [37.088239, -7.974663], b = [35.265351, -2.930574];
  const line = RV.greatCircle(a, b, 25);
  let len = 0;
  for (let i = 1; i < line.length; i++) len += RV.distKm(line[i - 1], line[i]);
  assert.ok(Math.abs(len - RV.distKm(a, b)) < 1, 'gc ' + len + ' vs ' + RV.distKm(a, b));
  assert.ok(line.length > 8);
});

test('Open in builder points at the bundled stage file', () => {
  const g = RV.geometry(raw);
  const ss2 = g.days.find(d => d.code === 'SS2');
  const href = RV.stageOpenHref(ss2, { builder: '/' });
  assert.ok(href.includes('stage=rallies%2Fatlantic-to-atlas-2027%2Fstages%2Fata27-ss2.json'), href);
  const lite = RV.lightweightStage(ss2);
  assert.strictEqual(lite.format, 'rallyraid-stage');
  assert.ok(lite.route.legs[0].points.length > 10);
});

test('totals: 13 stages, published SS and liaison kilometres', () => {
  const T = RV.totalsOf(RV.geometry(raw));
  assert.strictEqual(T.days, 15);
  assert.strictEqual(T.stages, 13);
  assert.ok(T.ssKm > 4000 && T.ssKm < 4500);
  assert.strictEqual(T.liaisonKm, 3483);
  assert.strictEqual(T.publishedTotalKm, 7824);
});

test('Share packs and unpacks a rally; the payload stays under the 256 KB cap', () => {
  const frag = Share.packRally(raw);
  assert.match(frag, /^y1=/);
  const parsed = Share.parseHash('#' + frag);
  assert.strictEqual(parsed.kind, 'rally');
  const u = Share.unpack(parsed);
  assert.strictEqual(u.kind, 'rally');
  assert.strictEqual(u.rally.id, raw.id);
  assert.strictEqual(u.rally.days.length, raw.days.length);
  // POST body is JSON {v,kind,data} — data is the fragment after y1=
  const data = frag.slice(3);
  const body = JSON.stringify({ v: 1, kind: 'rally', data: data });
  assert.ok(body.length < 256 * 1024, 'post ' + body.length);
});

test('dayTypeLabel and stage-open reject a transfer day', () => {
  const g = RV.geometry(raw);
  const t = g.days.find(d => d.transfer);
  assert.strictEqual(RV.dayTypeLabel(raw.days.find(d => d.type === 'transfer')), 'Transfer (teleport)');
  assert.strictEqual(RV.stageOpenHref(t, { builder: '/' }), null);
  assert.strictEqual(RV.lightweightStage(t), null);
});
