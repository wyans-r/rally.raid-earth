// node --test test/checks.test.mjs : the server checks on the package the Lua test drove (tests/fixtures/events)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { checkPackage, buildLeaderboard, versionAtLeast, tracePoints } from '../worker/src/checks.js'

const MOD = '/workspace/rallyraid'
const pkg0 = JSON.parse(fs.readFileSync(`${MOD}/tests/fixtures/events/moab_official_package.json`, 'utf8'))
const stageText = fs.readFileSync(`${MOD}/mod/rallyraid/stages/moab-sand-flats-ss1.json`, 'utf8')
const rbText = fs.readFileSync(`${MOD}/mod/rallyraid/roadbooks/moab-sand-flats-ss1.roadbook.json`, 'utf8')
const sha = t => crypto.createHash('sha256').update(t).digest('hex')
const stageFile = JSON.parse(stageText)
const event = { id: 'ev1', opens_at: '2026-11-01T00:00:00Z', closes_at: '2099-01-01T00:00:00Z', min_mod_version: '0.2.0', rules: {} }
const stage = { idx: 1, stage_id: stageFile.id, stage_sha256: sha(stageText), roadbook_sha256: sha(rbText) }
const clone = () => JSON.parse(JSON.stringify(pkg0))
// spread the trace's wall clock like a real run (the Lua test ran in milliseconds)
function realWall(p) { for (const q of p.trace.pts) q[1] = Math.round(q[0]); return p }
const run = (p, extra = {}) => checkPackage({ event, stage, stageFile, pkg: p, entry: { id: 'en1' }, receivedAt: new Date().toISOString(), ...extra })

test('hashes from the Lua package = node sha256 of the files', () => {
  assert.equal(pkg0.hashes.stage, stage.stage_sha256)
  assert.equal(pkg0.hashes.roadbook, stage.roadbook_sha256)
})
test('the clean official run passes every check', () => {
  const r = run(realWall(clone()))
  assert.equal(r.status, 'pass', JSON.stringify(r.checks.filter(c => !c.ok), null, 1))
  assert.ok(r.points > 150)
})
test('a changed roadbook hash is flagged', () => {
  const p = realWall(clone()); p.hashes.roadbook = 'x'.repeat(64)
  const r = run(p); assert.equal(r.status, 'flagged'); assert.ok(r.failed.includes('hashRoadbook'))
})
test('too old a mod version is flagged', () => {
  const p = realWall(clone()); p.modVersion = '0.1.0'
  assert.ok(run(p).failed.includes('modVersion'))
})
test('waypoints out of order are flagged', () => {
  const p = realWall(clone()); const w = p.result.waypoints; const t = w[2].time; w[2].time = w[3].time + 5; w[3].time = t
  assert.ok(run(p).failed.includes('waypointOrder'))
})
test('a teleport in the trace is flagged', () => {
  const p = realWall(clone()); const q = p.trace.pts[50]; q[2] += 0.05     // 5.5 km sideways in a few seconds
  const r = run(p); assert.ok(r.failed.includes('teleport') && r.failed.includes('speed'), r.failed.join())
})
test('impossible speed is flagged', () => {
  const p = realWall(clone()); p.trace.pts[30][5] = 320
  assert.ok(run(p).failed.includes('speed'))
})
test('a 3 min break is flagged (one sitting), a game-crash resume covering it is not a sitting break', () => {
  const p = realWall(clone()); for (let i = 100; i < p.trace.pts.length; i++) p.trace.pts[i][1] += 180
  let r = run(p); assert.ok(r.failed.includes('oneSitting'), r.failed.join())
  const e0 = p.trace.epoch0, w = p.trace.pts[99][1]
  p.result.gameCrashResume = { ...p.result.gameCrashResume, flagged: true, count: 1,
    resumes: [{ kind: 'gameCrashResume', savedEpoch: e0 + w, resumedEpoch: e0 + w + 180, wallGapS: 180 }] }
  r = run(p)
  assert.ok(!r.failed.includes('oneSitting'), 'resume gap excluded')
  assert.ok(r.failed.includes('gameCrashResume'), 'the resume itself is flagged for review')
  assert.equal(r.status, 'flagged')
})
test('a 90 s break is fine', () => {
  const p = realWall(clone()); for (let i = 100; i < p.trace.pts.length; i++) p.trace.pts[i][1] += 90
  assert.ok(!run(p).failed.includes('oneSitting'))
})
test('a short cut (trace step longer than the odometer) is flagged', () => {
  const p = realWall(clone()); const pts = p.trace.pts
  for (let i = 60; i < pts.length; i++) pts[i][4] -= 1.0      // odometer 1 km short from point 60
  const r = run(p); assert.ok(r.failed.includes('odometer') || r.failed.includes('traceOrder'), r.failed.join())
})
test('a missing trace fails', () => {
  const p = realWall(clone()); p.trace.pts = p.trace.pts.slice(0, 5)
  assert.ok(run(p).failed.includes('traceLength'))
})
test('extra attempts and late uploads are flagged, never rejected', () => {
  const r = run(realWall(clone()), { attempt: 2, receivedAt: '2099-01-05T00:00:00Z' })
  assert.equal(r.status, 'flagged'); assert.ok(r.failed.includes('attempt') && r.failed.includes('upload'))
})
test('unofficial mode is an error', () => {
  const p = realWall(clone()); p.rules.official = false
  assert.ok(run(p).failed.includes('officialRules'))
})
test('versionAtLeast + tracePoints', () => {
  assert.ok(versionAtLeast('0.10.0', '0.9.9') && !versionAtLeast('0.1.9', '0.2.0'))
  assert.equal(tracePoints({ cols: ['t', 'w', 'lat', 'lon', 'odo', 'kmh'], pts: [[1, 2, 3, 4, 5, 6]] })[0].kmh, 6)
})
test('leaderboard: classes, HC apart, pending, known stage', () => {
  const ev = { classes: ['T1', 'T3'] }
  const stages = [{ idx: 1, name: 'SS1', known_stage: 1, known_reason: 'example stage' }, { idx: 2, name: 'SS2', known_stage: 0 }]
  const entries = [
    { id: 'a', display_name: 'Ann', class: 'T1' }, { id: 'b', display_name: 'Bob', class: 'T1' },
    { id: 'c', display_name: 'Cat', class: 'T3' }, { id: 'w', display_name: 'Wyans', class: 'T1', hc: 1 }]
  const R = (id, e, idx, total, status = 'pass', extra = {}) => ({ id, entry_id: e, stage_idx: idx, total_time: total, status, attempt: 1, received_at: id, review_penalty: 0, ...extra })
  const results = [R('1', 'a', 1, 100), R('2', 'a', 2, 200), R('3', 'b', 1, 90), R('4', 'b', 2, 250, 'approved', { review_penalty: 60 }),
    R('5', 'c', 1, 50), R('6', 'c', 2, 70, 'flagged'), R('7', 'w', 1, 80), R('8', 'w', 2, 80), R('9', 'a', 2, 10, 'pass', { attempt: 2 })]
  const lb = buildLeaderboard({ event: ev, stages, entries, results })
  const t1 = lb.classes[0].rows
  assert.deepEqual(t1.map(r => [r.name, r.pos, r.overall]), [['Ann', 1, 300], ['Bob', 2, 400]])
  assert.equal(lb.classes[1].rows[0].complete, false); assert.equal(lb.classes[1].rows[0].pending, 1)
  assert.equal(lb.horsClassement[0].name, 'Wyans'); assert.ok(!t1.some(r => r.name === 'Wyans'))
  assert.equal(lb.stages[0].known, true)
})
