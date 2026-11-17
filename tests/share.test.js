// Share-link codec (stage-builder/share.js): pack / unpack, lengths, damage, versions.
// node --test tests/share.test.js
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), path = require('path');
const S = require('../stage-builder/share.js');
const RB = require('../stage-builder/roadbook-gen.js');
const EX = path.join(__dirname, '../stage-builder/examples');
const manifest = JSON.parse(fs.readFileSync(path.join(EX, 'index.json'), 'utf8'));
const BASE_S = 'https://stagebuilder.wyans.net/';
const BASE_R = 'https://stagebuilder.wyans.net/roadbook.html';

function loadPair(s) {
  const stage = JSON.parse(fs.readFileSync(path.join(EX, s.file), 'utf8'));
  const roadbook = JSON.parse(fs.readFileSync(path.join(EX, s.id + '.roadbook.json'), 'utf8'));
  return { stage, roadbook };
}

test('all 15 examples pack and unpack losslessly (stage and roadbook+stage)', async () => {
  const rows = [];
  for (const s of manifest.stages) {
    const { stage, roadbook } = loadPair(s);
    const stFrag = S.packStage(stage);
    const rbFrag = S.packRoadbook(roadbook, stage);
    const stInfo = S.linkFor(BASE_S, stFrag);
    const rbInfo = S.linkFor(BASE_R, rbFrag);
    const st2 = S.unpack(S.parseHash('#' + stFrag));
    const rb2 = S.unpack(S.parseHash('#' + rbFrag));
    assert.strictEqual(st2.kind, 'stage');
    assert.deepStrictEqual(st2.stage, stage);
    assert.strictEqual(rb2.kind, 'roadbook');
    assert.deepStrictEqual(rb2.roadbook, roadbook);
    assert.deepStrictEqual(rb2.stage, stage);
    const hash = await RB.stageHash(rb2.stage);
    assert.strictEqual(hash, roadbook.stage.hash, s.id + ' stage hash after unpack');
    rows.push({ id: s.id, stageLen: stInfo.length, roadbookLen: rbInfo.length, stageWarn: stInfo.warning, roadbookWarn: rbInfo.warning });
  }
  assert.strictEqual(rows.length, 15);
  // thresholds should match the real sizes: every shipped stage is over the soft warning,
  // every shipped roadbook link is at least a strong warning
  for (const r of rows) {
    assert.ok(r.stageLen > 2000, r.id + ' stage link unexpectedly short: ' + r.stageLen);
    assert.ok(r.roadbookLen > 8000, r.id + ' roadbook link unexpectedly short: ' + r.roadbookLen);
    assert.ok(r.stageWarn === 'soft' || r.stageWarn === 'strong', r.id + ' stage warn ' + r.stageWarn);
    assert.ok(r.roadbookWarn === 'strong' || r.roadbookWarn === 'very', r.id + ' roadbook warn ' + r.roadbookWarn);
  }
  // print a compact table for the report
  for (const r of rows) console.log(r.id, 'stage', r.stageLen, r.stageWarn, 'roadbook', r.roadbookLen, r.roadbookWarn);
});

test('truncated and corrupt fragments throw a clear damaged-link error', () => {
  const { stage } = loadPair(manifest.stages[0]);
  const frag = S.packStage(stage);
  const cut = frag.slice(0, Math.max(8, frag.length - 30));
  assert.throws(() => S.unpack(S.parseHash('#' + cut)), /damaged or was cut off/);
  assert.throws(() => S.unpack(S.parseHash('#s1=@@@not-base64@@@')), /damaged or was cut off/);
  assert.throws(() => S.unpack({ kind: 'stage', version: 1, data: 'AAAA' }), /damaged or was cut off/);
});

test('unknown fragment versions are rejected', () => {
  assert.throws(() => S.unpack({ kind: 'stage', version: 2, data: 'aa' }), /newer version/);
  assert.strictEqual(S.parseHash('#s1=abc').version, 1);
  assert.strictEqual(S.parseHash('#r1=abc').kind, 'roadbook');
  assert.strictEqual(S.parseHash('#other=abc'), null);
  assert.strictEqual(S.parseHash(''), null);
});

test('warning thresholds: soft 2000, strong 8000, very 30000', () => {
  assert.strictEqual(S.warnLevel(1999), null);
  assert.strictEqual(S.warnLevel(2000), 'soft');
  assert.strictEqual(S.warnLevel(7999), 'soft');
  assert.strictEqual(S.warnLevel(8000), 'strong');
  assert.strictEqual(S.warnLevel(29999), 'strong');
  assert.strictEqual(S.warnLevel(30000), 'very');
  assert.match(S.warnMessage(2500), /SMS|messaging/);
  assert.match(S.warnMessage(9000), /long/);
  assert.match(S.warnMessage(40000), /very long/);
});
