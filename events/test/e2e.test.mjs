// End-to-end run of a fake event against the local Worker (wrangler dev --local on :8787, fake D1 + R2):
// admin + organizer approval, create, stage files, lock, entries (email code + Discord mock), packs, fake result
// packages uploaded from the "game" (Bearer key) and the website (file), checks, leaderboard, review.
//   node --test test/e2e.test.mjs        (BASE=http://127.0.0.1:8787)
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import crypto from 'node:crypto'

const BASE = process.env.BASE || 'http://127.0.0.1:8787'
const MOD = '/workspace/rallyraid'
const stageText = fs.readFileSync(`${MOD}/mod/rallyraid/stages/moab-sand-flats-ss1.json`, 'utf8')
const rbText = fs.readFileSync(`${MOD}/mod/rallyraid/roadbooks/moab-sand-flats-ss1.roadbook.json`, 'utf8')
const pkg0 = JSON.parse(fs.readFileSync(`${MOD}/tests/fixtures/events/moab_official_package.json`, 'utf8'))
const sha = t => crypto.createHash('sha256').update(t).digest('hex')
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
const RUN = Date.now().toString(36)
export const STATE = {}

// a cookie jar per user
function client() {
  let cookie = ''
  const c = async (method, path, body, { raw, headers = {}, redirect = 'follow' } = {}) => {
    const h = { 'X-RR': '1', ...headers }
    if (cookie) h.Cookie = cookie
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json'
    const r = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect })
    const sc = r.headers.get('set-cookie')
    if (sc) cookie = sc.split(';')[0]
    const t = await r.text()
    let d; try { d = JSON.parse(t) } catch { d = t }
    return { status: r.status, d, headers: r.headers }
  }
  c.cookie = () => cookie
  return c
}
async function emailLogin(c, email) {
  assert.equal((await c('POST', '/api/auth/email/start', { email })).status, 200)
  const box = (await c('GET', '/api/dev/outbox')).d.mails
  const m = box.find(x => x.to_addr === email)
  const code = /code is (\d{6})/.exec(m.body)[1]
  const bad = await c('POST', '/api/auth/email/verify', { email, code: code === '000000' ? '111111' : '000000' })
  assert.equal(bad.status, 400)
  const r = await c('POST', '/api/auth/email/verify', { email, code })
  assert.equal(r.status, 200, JSON.stringify(r.d))
  return r.d.user
}

// a Discord stand-in on :8799 (token + /users/@me)
let mock
before(async () => {
  mock = http.createServer((q, s) => {
    if (q.url.startsWith('/api/oauth2/token')) { s.setHeader('content-type', 'application/json'); return s.end(JSON.stringify({ access_token: 'mock-token', token_type: 'Bearer' })) }
    if (q.url.startsWith('/api/users/@me')) { s.setHeader('content-type', 'application/json'); return s.end(JSON.stringify({ id: '9000' + RUN.length + '42', username: 'dune_rider_' + RUN, global_name: 'Dune Rider' })) }
    s.statusCode = 404; s.end()
  }).listen(8799)
})
after(() => mock.close())

// a package for an entry, as the game makes it (the Lua test's run), its clock moved into the event window
function pkgFor(ev, entry, tweak) {
  const p = JSON.parse(JSON.stringify(pkg0))
  p.event = { id: ev.id, name: ev.name }; p.stage.index = 1; p.entry = { id: entry.id, displayName: entry.name, class: entry.class }
  const start = Date.now() - 40 * 60e3
  p.result.startedAt = iso(start); p.result.finishedAt = iso(start + p.result.stageTime * 1000)
  p.trace.epoch0 = Math.floor(start / 1000)
  for (const q of p.trace.pts) q[1] = Math.round(q[0])
  if (tweak) tweak(p)
  return JSON.stringify(p)
}

const admin = client(), org = client(), d1 = client(), d2 = client(), d3 = client(), anon = client()
let ev, entries = {}

test('admin + organizer approval flow', async () => {
  const a = await emailLogin(admin, 'wyans@example.com')
  assert.equal(a.role, 'admin')
  const o = await emailLogin(org, `org_${RUN}@example.com`)
  assert.equal(o.role, 'entrant')
  assert.equal((await org('POST', '/api/events', { name: 'x' })).status, 403, 'entrant cannot create events')
  assert.equal((await org('POST', '/api/organizer/request', { note: 'I want to run the Moab Winter Rally' })).status, 200)
  assert.equal((await org('GET', '/api/admin/organizer-requests')).status, 403, 'only the admin sees requests')
  const list = (await admin('GET', '/api/admin/organizer-requests')).d.requests
  const rq = list.find(r => r.email === `org_${RUN}@example.com` && r.status === 'pending')
  assert.ok(rq)
  assert.equal((await admin('POST', '/api/admin/organizer-requests/' + rq.id, { decision: 'approve' })).status, 200)
  assert.equal((await org('GET', '/api/me')).d.user.role, 'organizer')
  await org('POST', '/api/me/name', { name: 'Organizer Olly' })
})

test('CSRF header required for cookie writes', async () => {
  const r = await fetch(BASE + '/api/events', { method: 'POST', headers: { Cookie: org.cookie(), 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(r.status, 403)
})

test('create a draft event, stage files, edit, lock', async () => {
  const now = Date.now()
  const r = await org('POST', '/api/events', { name: 'Moab Winter Rally ' + RUN, opensAt: iso(now - 2 * 3600e3), closesAt: iso(now + 7 * 864e5), roadbookReleaseAt: iso(now - 3600e3),
    classes: ['T1 Prototype', 'T3 Light prototype'], rulesText: 'Roadbook only.\nOne sitting per stage.', minModVersion: '0.2.0' })
  assert.equal(r.status, 200, JSON.stringify(r.d))
  ev = { id: r.d.id, slug: r.d.slug }
  assert.equal((await anon('GET', '/api/events/' + ev.id)).status, 404, 'a draft is not public')
  const bad = await org('PUT', `/api/events/${ev.id}/stages/1`, { stageText: '{"x":1}', roadbookText: rbText })
  assert.equal(bad.status, 400)
  const wrongRb = await org('PUT', `/api/events/${ev.id}/stages/1`, { stageText, roadbookText: fs.readFileSync(`${MOD}/mod/rallyraid/roadbooks/mex-baja-ojos-negros-mikes.roadbook.json`, 'utf8') })
  assert.equal(wrongRb.status, 400, 'a roadbook of another stage is refused')
  const put = await org('PUT', `/api/events/${ev.id}/stages/1`, { name: 'SS1 Sand Flats', stageText, roadbookText: rbText })
  assert.equal(put.status, 200, JSON.stringify(put.d))
  assert.equal(put.d.stageSha256, sha(stageText)); assert.equal(put.d.roadbookSha256, sha(rbText))
  assert.equal(put.d.known, true, 'moab is a builder example: known stage')
  assert.equal((await org('PUT', '/api/events/' + ev.id, { rulesText: 'Roadbook only.\nOne sitting per stage.\nReplay on request.' })).status, 200)
  assert.equal((await d1('POST', `/api/events/${ev.id}/lock`, {})).status, 401)
  const lock = await org('POST', `/api/events/${ev.id}/lock`, {})
  assert.equal(lock.status, 200)
  assert.equal(lock.d.lockHash, sha(ev.id + '|' + `ss1:${sha(stageText)}:${sha(rbText)}`), 'event hash = SHA-256 over the stage hashes')
  assert.equal((await org('PUT', `/api/events/${ev.id}/stages/1`, { stageText, roadbookText: rbText })).status, 409, 'locked: files cannot change')
  assert.equal((await org('PUT', '/api/events/' + ev.id, { name: 'renamed' })).status, 409, 'locked: details cannot change')
  const pub = await anon('GET', '/api/events/' + ev.slug)
  assert.equal(pub.status, 200); assert.equal(pub.d.event.phase, 'open')
  assert.equal(pub.d.event.stages[0].stageSha256, sha(stageText)); assert.ok(pub.d.event.stages[0].known)
  STATE.ev = ev
})

test('entries: email + Discord login, classes, organizer is HC', async () => {
  await emailLogin(d1, `alice_${RUN}@example.com`); await d1('POST', '/api/me/name', { name: 'Alice' })
  // Discord: start -> (mock authorize) -> callback with code + state
  const st = await d2('GET', '/api/auth/discord/start', undefined, { redirect: 'manual' })
  assert.equal(st.status, 302)
  const loc = new URL(st.headers.get('location'))
  assert.equal(loc.searchParams.get('scope'), 'identify')
  const cb = await d2('GET', `/api/auth/discord/callback?code=abc&state=${loc.searchParams.get('state')}`, undefined, { redirect: 'manual' })
  assert.equal(cb.status, 302); assert.ok(d2.cookie())
  const me2 = (await d2('GET', '/api/me')).d.user
  assert.equal(me2.name, 'Dune Rider'); assert.ok(me2.discord)
  const replay = await anon('GET', `/api/auth/discord/callback?code=abc&state=${loc.searchParams.get('state')}`, undefined, { redirect: 'manual' })
  assert.match(replay.headers.get('location'), /error=/, 'an OAuth state works once')
  await emailLogin(d3, `carl_${RUN}@example.com`); await d3('POST', '/api/me/name', { name: 'Carl' })
  assert.equal((await d1('POST', `/api/events/${ev.id}/enter`, { class: 'Bike' })).status, 400, 'class must be an event class')
  for (const [c, cls, veh, k] of [[d1, 'T1 Prototype', 'Gavril D-Series rally', 'alice'], [d2, 'T1 Prototype', 'Hirochi Sunburst', 'dune'], [d3, 'T3 Light prototype', 'Ibishu Pigeon', 'carl'], [org, 'T1 Prototype', 'Gavril D-Series', 'org']]) {
    const r = await c('POST', `/api/events/${ev.id}/enter`, { class: cls, vehicle: veh })
    assert.equal(r.status, 200, JSON.stringify(r.d))
    entries[k] = { id: r.d.entryId, class: cls, name: k, hc: r.d.hc }
  }
  assert.equal(entries.org.hc, true); assert.equal(entries.alice.hc, false)
})

test('event packs: locked bytes, hashes, personal upload key', async () => {
  assert.equal((await anon('GET', `/api/events/${ev.id}/stages/1/pack`)).status, 401)
  const p = await d1('GET', `/api/events/${ev.id}/stages/1/pack`)
  assert.equal(p.status, 200)
  assert.match(p.headers.get('content-disposition'), /rrevent\.json/)
  const pack = p.d
  assert.equal(pack.format, 'rallyraid-event-pack')
  assert.equal(sha(pack.files.stage.text), pack.files.stage.sha256); assert.equal(pack.files.stage.text, stageText)
  assert.equal(sha(pack.files.roadbook.text), pack.files.roadbook.sha256)
  assert.match(pack.entry.token, /^rrk_en_/)
  assert.match(pack.event.uploadUrl, /\/api\/game\/results$/)
  entries.alice.token = pack.entry.token
  entries.org.token = (await org('GET', `/api/events/${ev.id}/stages/1/pack`)).d.entry.token
  entries.carl.token = (await d3('GET', `/api/events/${ev.id}/stages/1/pack`)).d.entry.token
  fs.mkdirSync('/workspace/rallyraid-events/test/out', { recursive: true })
  fs.writeFileSync('/workspace/rallyraid-events/test/out/alice-ss1.rrevent.json', p.d && JSON.stringify(pack))
})

test('results: game upload (Bearer key) and website upload (file), checks', async () => {
  const bad = await anon('POST', '/api/game/results', pkgFor(ev, entries.alice), { raw: true, headers: { Authorization: 'Bearer rrk_en_nope_' + 'x'.repeat(32) } })
  assert.equal(bad.status, 401)
  // Alice: clean run from the game
  const a = await anon('POST', '/api/game/results', pkgFor(ev, entries.alice), { raw: true, headers: { Authorization: 'Bearer ' + entries.alice.token, 'Content-Type': 'application/json' } })
  assert.equal(a.status, 200, JSON.stringify(a.d)); assert.equal(a.d.status, 'pass', JSON.stringify(a.d))
  const dup = await anon('POST', '/api/game/results', pkgFor(ev, entries.alice), { raw: true, headers: { Authorization: 'Bearer ' + entries.alice.token } })
  assert.ok(dup.d.duplicate || dup.d.attempt === 2)
  // the organizer (HC): clean run from the game
  const o = await anon('POST', '/api/game/results', pkgFor(ev, entries.org, p => { p.result.stageTime -= 30; p.result.totalTime -= 30; p.result.waypoints[p.result.waypoints.length - 1].time -= 30 }), { raw: true, headers: { Authorization: 'Bearer ' + entries.org.token } })
  assert.equal(o.d.status, 'flagged', 'the organizer\'s tweaked times no longer match the trace -> flagged: ' + JSON.stringify(o.d.failed))
  const o2 = await anon('POST', '/api/game/results', pkgFor(ev, entries.org, p => { p.createdAt = 'second' }), { raw: true, headers: { Authorization: 'Bearer ' + entries.org.token } })
  assert.equal(o2.d.attempt, 2)
  // Dune Rider (Discord): the upload failed in the game; the file goes in on the website. 3 min break in the trace
  const dr = await d2('POST', `/api/events/${ev.id}/results`, pkgFor(ev, entries.dune, p => {
    for (let i = 120; i < p.trace.pts.length; i++) p.trace.pts[i][1] += 185
    p.result.stageTime += 4; p.result.totalTime += 4; p.result.waypoints[p.result.waypoints.length - 1].time += 4
  }), { raw: true })
  assert.equal(dr.status, 200, JSON.stringify(dr.d)); assert.equal(dr.d.status, 'flagged'); assert.ok(dr.d.failed.includes('oneSitting'), dr.d.failed.join())
  // someone else's file on the website is refused
  assert.equal((await d1('POST', `/api/events/${ev.id}/results`, pkgFor(ev, entries.dune), { raw: true })).status, 403)
  // Carl: a teleport + a changed roadbook hash
  const c = await anon('POST', '/api/game/results', pkgFor(ev, entries.carl, p => { p.trace.pts[80][2] += 0.04; p.hashes.roadbook = sha('another roadbook') }), { raw: true, headers: { Authorization: 'Bearer ' + entries.carl.token } })
  assert.equal(c.d.status, 'flagged'); assert.ok(c.d.failed.includes('teleport') && c.d.failed.includes('hashRoadbook'), c.d.failed.join())
  STATE.results = { alice: a.d.resultId, dune: dr.d.resultId, carl: c.d.resultId, org: o.d.resultId, org2: o2.d.resultId }
  assert.equal(o2.d.status, 'flagged', 'an extra attempt is flagged')
})

test('leaderboard before review', async () => {
  const lb = (await anon('GET', `/api/events/${ev.id}/leaderboard`)).d.leaderboard
  const t1 = lb.classes.find(c => c.class === 'T1 Prototype').rows
  assert.equal(t1[0].name, 'Alice'); assert.equal(t1[0].pos, 1)
  assert.equal(t1.find(r => r.name === 'Dune Rider').pending, 1)
  assert.ok(!t1.some(r => r.hc))
  assert.equal(lb.horsClassement.length, 1); assert.equal(lb.horsClassement[0].hc, true)
  assert.equal(lb.stages[0].known, true)
})

test('flag review: approve with a penalty, reject with a reason, permissions', async () => {
  assert.equal((await d1('GET', `/api/events/${ev.id}/review`)).status, 403, 'an entrant cannot review')
  assert.equal((await d1('POST', `/api/results/${STATE.results.dune}/review`, { decision: 'approve' })).status, 403)
  const list = (await org('GET', `/api/events/${ev.id}/review`)).d.results
  assert.equal(list[0].status, 'flagged')
  const det = await org('GET', `/api/results/${STATE.results.dune}`)
  assert.ok(det.d.trace.length > 100 && det.d.waypoints.length > 2)
  assert.equal((await d1('GET', `/api/results/${STATE.results.dune}`)).status, 403, 'not your result')
  assert.equal((await d2('GET', `/api/results/${STATE.results.dune}`)).status, 200, 'your own result')
  assert.equal((await org('POST', `/api/results/${STATE.results.carl}/review`, { decision: 'reject' })).status, 400, 'a rejection needs a reason')
  assert.equal((await org('POST', `/api/results/${STATE.results.carl}/review`, { decision: 'reject', note: 'roadbook file changed + teleport at 7 min; replay requested, none sent' })).status, 200)
  assert.equal((await org('POST', `/api/results/${STATE.results.dune}/review`, { decision: 'approve', penaltyS: 60, note: 'game paused 3 min (phone call): ok, +1 min' })).status, 200)
  // the admin can review any event
  assert.equal((await admin('POST', `/api/results/${STATE.results.org}/review`, { decision: 'reject', note: 'times edited by hand (test)' })).status, 200)
  let lb = (await anon('GET', `/api/events/${ev.id}/leaderboard`)).d.leaderboard
  assert.equal(lb.horsClassement[0].overall, null, 'the 2nd attempt waits for review')
  assert.equal((await admin('POST', `/api/results/${STATE.results.org2}/review`, { decision: 'approve', note: 'first run was a test' })).status, 200)
  lb = (await anon('GET', `/api/events/${ev.id}/leaderboard`)).d.leaderboard
  const t1 = lb.classes.find(c => c.class === 'T1 Prototype').rows
  const dune = t1.find(r => r.name === 'Dune Rider'), alice = t1.find(r => r.name === 'Alice')
  assert.ok(dune.overall != null && Math.abs(dune.overall - (alice.overall + 4 + 60)) < 1, `approved +60 s: ${dune.overall} vs ${alice.overall}`)
  assert.equal(lb.classes.find(c => c.class === 'T3 Light prototype').rows[0].overall, null, 'rejected = no time')
  assert.equal(lb.horsClassement[0].overall != null, true, 'the organizer\'s 2nd attempt counts (the 1st rejected)')
  fs.writeFileSync('/workspace/rallyraid-events/test/out/e2e_state.json', JSON.stringify({ ev, results: STATE.results }))
})

test('a pack before the roadbook release is refused', async () => {
  const now = Date.now()
  const r = await org('POST', '/api/events', { name: 'Future Rally ' + RUN, opensAt: iso(now + 864e5), closesAt: iso(now + 9 * 864e5), roadbookReleaseAt: iso(now + 864e5), classes: ['T1'], rulesText: '' })
  await org('PUT', `/api/events/${r.d.id}/stages/1`, { stageText, roadbookText: rbText })
  await org('POST', `/api/events/${r.d.id}/lock`, {})
  await d1('POST', `/api/events/${r.d.id}/enter`, { class: 'T1' })
  const p = await d1('GET', `/api/events/${r.d.id}/stages/1/pack`)
  assert.equal(p.status, 403); assert.match(p.d.error, /released/)
})
