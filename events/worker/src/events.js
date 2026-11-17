// Events API: create / edit (draft), lock (publish hashes), entries, event packs, result upload (game + web), review,
// leaderboard. Files live in R2 (env.FILES), everything else in D1 (env.DB).
import { now, sha256Hex, randomId, json, fail, readJson, readText, clean, slugify, isoOk, audit, hmac, safeEqual } from './util.js'
import { currentUser, requireUser, requireRole } from './auth.js'
import { checkPackage, buildLeaderboard, tracePoints } from './checks.js'

const MAX_FILE = 5e6, MAX_PACKAGE = 4e6

const parseJ = (s, d) => { try { return JSON.parse(s) } catch { return d } }
function eventOut(e, stages, extra = {}) {
  return { id: e.id, slug: e.slug, name: e.name, organizerId: e.organizer_id, organizer: e.organizer_name, opensAt: e.opens_at, closesAt: e.closes_at,
    roadbookReleaseAt: e.roadbook_release_at, classes: parseJ(e.classes_json, []), rulesText: e.rules_text, rules: parseJ(e.rules_json, {}),
    minModVersion: e.min_mod_version, status: e.status, lockedAt: e.locked_at, lockHash: e.lock_hash, phase: phase(e),
    stages: (stages || []).map(s => ({ idx: s.idx, name: s.name, stageId: s.stage_id, lengthKm: s.length_km, waypoints: s.waypoint_count,
      stageSha256: s.stage_sha256, roadbookSha256: s.roadbook_sha256, stageBytes: s.stage_bytes, roadbookBytes: s.roadbook_bytes,
      known: !!s.known_stage, knownReason: s.known_reason })), ...extra }
}
export function phase(e, t = now()) {
  if (e.status !== 'locked') return 'draft'
  if (t < e.opens_at) return 'upcoming'
  if (t <= e.closes_at) return 'open'
  return 'closed'
}
async function getEvent(env, id) {
  const e = await env.DB.prepare('SELECT e.*, u.display_name AS organizer_name FROM events e JOIN users u ON u.id = e.organizer_id WHERE e.id = ? OR e.slug = ?').bind(id, id).first()
  if (!e) fail(404, 'no such event')
  return e
}
const stagesOf = async (env, id) => (await env.DB.prepare('SELECT * FROM event_stages WHERE event_id = ? ORDER BY idx').bind(id).all()).results
const canManage = (u, e) => u && (u.role === 'admin' || (u.role === 'organizer' && u.id === e.organizer_id))
async function requireManager(env, req, e) { const u = await requireUser(env, req); if (!canManage(u, e)) fail(403, 'only the organizer or an admin'); return u }

function validateEventFields(b, partial) {
  const o = {}
  if (!partial || b.name !== undefined) { o.name = clean(b.name, 100); if (o.name.length < 3) fail(400, 'name: at least 3 characters') }
  for (const k of ['opensAt', 'closesAt', 'roadbookReleaseAt']) if (!partial || b[k] !== undefined) { if (!isoOk(b[k])) fail(400, `${k}: an ISO UTC time like 2026-12-01T18:00:00Z`); o[k] = b[k] }
  if (!partial || b.classes !== undefined) {
    o.classes = (Array.isArray(b.classes) ? b.classes : String(b.classes || '').split(/\n|,/)).map(c => clean(c, 40)).filter(Boolean).slice(0, 20)
    if (!o.classes.length) fail(400, 'classes: at least one vehicle class')
  }
  if (b.rulesText !== undefined || !partial) o.rulesText = String(b.rulesText || '').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').slice(0, 20000)
  if (b.rules !== undefined || !partial) {
    const r = typeof b.rules === 'object' && b.rules ? b.rules : {}
    const g = r.gameCrashResume || {}
    o.rules = { gameCrashResume: { firstPenaltyS: Math.max(0, +g.firstPenaltyS || 0), laterPenaltyS: Math.max(0, +g.laterPenaltyS || 0) } }
    if (r.checks && typeof r.checks === 'object') o.rules.checks = Object.fromEntries(Object.entries(r.checks).filter(([k, v]) => ['maxKmh', 'gapS', 'lateUploadH'].includes(k) && +v > 0).map(([k, v]) => [k, +v]))
  }
  if (b.minModVersion !== undefined || !partial) { o.minModVersion = clean(b.minModVersion || '0.2.0', 20); if (!/^\d+(\.\d+){0,3}$/.test(o.minModVersion)) fail(400, 'minModVersion like 0.2.0') }
  const oa = o.opensAt ?? b._opens, ca = o.closesAt ?? b._closes, ra = o.roadbookReleaseAt ?? b._release
  if (oa && ca && ca <= oa) fail(400, 'the event must close after it opens')
  if (ra && ca && ra > ca) fail(400, 'the roadbook release must be before the close')
  return o
}

// stage + roadbook files: the exact bytes are stored and hashed
function checkStageText(t) {
  const s = parseJ(t, null)
  if (!s || (s.format && s.format !== 'rallyraid-stage')) fail(400, 'stage file: not a rallyraid-stage JSON file')
  const w = Array.isArray(s.waypoints) ? s.waypoints : []
  if (w.length < 2 || String(w[0].type).toUpperCase() !== 'DSS' || String(w[w.length - 1].type).toUpperCase() !== 'ASS') fail(400, 'stage file: needs waypoints from a DSS to an ASS')
  if (!s.id) fail(400, 'stage file: no id')
  return s
}
function checkRoadbookText(t, stage) {
  const r = parseJ(t, null)
  if (!r || r.format !== 'rallyraid-roadbook') fail(400, 'roadbook file: not a rallyraid-roadbook JSON file')
  if (r.stage && r.stage.id && String(r.stage.id) !== String(stage.id)) fail(400, `roadbook file is for stage ${r.stage.id}, not ${stage.id}`)
  if (!Array.isArray(r.boxes) || !r.boxes.length) fail(400, 'roadbook file: no boxes')
  return r
}
// "known stage": the stage is one of the site's examples (anyone may have driven it)
async function knownExample(env, stageId, sha) {
  try {
    const r = await env.ASSETS.fetch(new Request('https://assets.local/examples/index.json'))
    if (!r.ok) return null
    const idx = await r.json()
    const list = Array.isArray(idx) ? idx : idx.examples || idx.stages || []
    const hit = list.find(x => x && (x.id === stageId || String(x.file || '').replace(/\.json$/, '') === stageId))
    return hit ? 'one of the stage builder examples (' + (hit.name || stageId) + ')' : null
  } catch { return null }
}

// the upload key in an entrant's event pack: rrk_<entry id>_<HMAC>. Not stored; a key_version bump revokes old packs.
export async function uploadKey(env, entry) { return 'rrk_' + entry.id + '_' + (await hmac(env.SESSION_SECRET, 'upload|' + entry.id + '|' + entry.key_version)).slice(0, 32) }
async function entryFromKey(env, key) {
  const m = /^rrk_(en_[\w-]+)_([\w-]{32})$/.exec(key || '')
  if (!m) return null
  const e = await env.DB.prepare('SELECT * FROM entries WHERE id = ?').bind(m[1]).first()
  if (!e) return null
  return safeEqual(await uploadKey(env, e), key) ? e : null
}

async function r2Text(env, key) { const o = await env.FILES.get(key); return o ? await o.text() : null }

// ---- the result pipeline (game upload and website upload)
async function ingest(env, { entry, event, text, via }) {
  let pkg
  try { pkg = JSON.parse(text) } catch { fail(400, 'not a result file (JSON expected)') }
  if (!pkg || pkg.format !== 'rallyraid-result-package') fail(400, 'not a Rally Raid result package (.rrresult.json)')
  if (pkg.event && pkg.event.id !== event.id) fail(400, `this result is for another event (${pkg.event.id})`)
  const idx = +(pkg.stage && pkg.stage.index)
  const stage = await env.DB.prepare('SELECT * FROM event_stages WHERE event_id = ? AND idx = ?').bind(event.id, idx).first()
  if (!stage) fail(400, 'this event has no stage SS' + idx)
  const sha = await sha256Hex(text)
  const dup = await env.DB.prepare('SELECT id, status FROM results WHERE entry_id = ? AND package_sha256 = ?').bind(entry.id, sha).first()
  if (dup) return { duplicate: true, resultId: dup.id, status: dup.status }
  const stageFile = parseJ(await r2Text(env, `events/${event.id}/ss${idx}/stage.json`), null)
  const prev = await env.DB.prepare('SELECT COUNT(*) AS n FROM results WHERE entry_id = ? AND stage_idx = ?').bind(entry.id, idx).first()
  const attempt = (prev?.n || 0) + 1
  const rec = await checkPackage({ event: { ...event, rules: parseJ(event.rules_json, {}) }, stage, stageFile, pkg, entry, receivedAt: now(), attempt })
  const id = 'rs_' + randomId(9)
  const key = `results/${event.id}/${id}.json`
  await env.FILES.put(key, text, { httpMetadata: { contentType: 'application/json' } })
  const r = pkg.result || {}
  await env.DB.prepare(`INSERT INTO results (id, event_id, entry_id, stage_idx, attempt, received_at, via, package_key, package_sha256, package_bytes,
    stage_time, penalty_time, total_time, retired, status, checks_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, event.id, entry.id, idx, attempt, now(), via, key, sha, text.length, +r.stageTime || null, +r.penaltyTime || 0, +r.totalTime || null,
      r.retired ? String(r.retired).slice(0, 200) : null, rec.status, JSON.stringify(rec.checks)).run()
  await audit(env, entry.user_id, 'result.' + via, { id, status: rec.status, failed: rec.failed })
  return { resultId: id, status: rec.status, failed: rec.failed, attempt }
}

export async function eventRoutes(env, req, path) {
  const m = req.method
  let mm

  // ---- the game's upload: Authorization: Bearer <upload key>. The only API path allowed over plain HTTP.
  if (path === '/api/game/results' && m === 'POST') {
    const key = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
    const entry = await entryFromKey(env, key)
    if (!entry) fail(401, 'unknown or revoked upload key: upload the file on the event page')
    const event = await getEvent(env, entry.event_id)
    const out = await ingest(env, { entry, event, text: await readText(req, MAX_PACKAGE), via: 'game' })
    return json({ ...out, url: (env.PUBLIC_BASE || '') + '/events/#/e/' + event.slug })
  }

  if (path === '/api/events' && m === 'GET') {
    const u = await currentUser(env, req)
    const rows = (await env.DB.prepare(`SELECT e.*, u.display_name AS organizer_name, (SELECT COUNT(*) FROM event_stages s WHERE s.event_id = e.id) AS n_stages,
      (SELECT COUNT(*) FROM entries x WHERE x.event_id = e.id) AS n_entries FROM events e JOIN users u ON u.id = e.organizer_id
      WHERE e.status = 'locked' OR e.organizer_id = ? OR ? = 'admin' ORDER BY e.opens_at DESC LIMIT 200`).bind(u?.id || '', u?.role || '').all()).results
    return json({ events: rows.map(e => eventOut(e, [], { stageCount: e.n_stages, entryCount: e.n_entries, canManage: canManage(u, e) })) })
  }
  if (path === '/api/events' && m === 'POST') {
    const u = await requireRole(env, req, 'organizer', 'admin')
    const b = await readJson(req, 64e3)
    const o = validateEventFields(b, false)
    let slug = slugify(b.slug || o.name) || 'event'
    if (await env.DB.prepare('SELECT 1 FROM events WHERE slug = ?').bind(slug).first()) slug += '-' + randomId(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')
    const id = 'ev_' + randomId(9)
    await env.DB.prepare(`INSERT INTO events (id, slug, name, organizer_id, opens_at, closes_at, roadbook_release_at, classes_json, rules_text, rules_json,
      min_mod_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, slug, o.name, u.id, o.opensAt, o.closesAt, o.roadbookReleaseAt, JSON.stringify(o.classes), o.rulesText, JSON.stringify(o.rules), o.minModVersion, now(), now()).run()
    await audit(env, u.id, 'event.created', id)
    return json({ ok: true, id, slug })
  }

  if ((mm = path.match(/^\/api\/events\/([\w-]+)$/))) {
    const e = await getEvent(env, mm[1])
    const u = await currentUser(env, req)
    if (m === 'GET') {
      if (e.status !== 'locked' && !canManage(u, e)) fail(404, 'no such event')
      const stages = await stagesOf(env, e.id)
      let entry = null
      if (u) {
        const x = await env.DB.prepare('SELECT * FROM entries WHERE event_id = ? AND user_id = ?').bind(e.id, u.id).first()
        if (x) entry = { id: x.id, class: x.class, vehicle: x.vehicle, displayName: x.display_name, hc: !!x.hc,
          results: (await env.DB.prepare('SELECT id, stage_idx, attempt, status, total_time, received_at, via FROM results WHERE entry_id = ? ORDER BY received_at').bind(x.id).all()).results }
      }
      const pendingReview = canManage(u, e) ? (await env.DB.prepare("SELECT COUNT(*) AS n FROM results WHERE event_id = ? AND status = 'flagged'").bind(e.id).first()).n : undefined
      return json({ event: eventOut(e, stages, { canManage: canManage(u, e), myEntry: entry, pendingReview, packsReleased: now() >= e.roadbook_release_at }) })
    }
    if (m === 'PUT') {
      const u2 = await requireManager(env, req, e)
      if (e.status === 'locked') fail(409, 'the event is locked: its files and rules can no longer change')
      const b = await readJson(req, 64e3)
      const o = validateEventFields({ ...b, _opens: e.opens_at, _closes: e.closes_at, _release: e.roadbook_release_at }, true)
      const map = { name: 'name', opensAt: 'opens_at', closesAt: 'closes_at', roadbookReleaseAt: 'roadbook_release_at', rulesText: 'rules_text', minModVersion: 'min_mod_version' }
      for (const [k, col] of Object.entries(map)) if (o[k] !== undefined) await env.DB.prepare(`UPDATE events SET ${col} = ? WHERE id = ?`).bind(o[k], e.id).run()
      if (o.classes) await env.DB.prepare('UPDATE events SET classes_json = ? WHERE id = ?').bind(JSON.stringify(o.classes), e.id).run()
      if (o.rules) await env.DB.prepare('UPDATE events SET rules_json = ? WHERE id = ?').bind(JSON.stringify(o.rules), e.id).run()
      await env.DB.prepare('UPDATE events SET updated_at = ? WHERE id = ?').bind(now(), e.id).run()
      await audit(env, u2.id, 'event.updated', e.id)
      return json({ ok: true })
    }
    if (m === 'DELETE') {
      const u2 = await requireManager(env, req, e)
      if (e.status === 'locked') fail(409, 'a locked event cannot be deleted')
      await env.DB.prepare('DELETE FROM event_stages WHERE event_id = ?').bind(e.id).run()
      await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(e.id).run()
      await audit(env, u2.id, 'event.deleted', e.id)
      return json({ ok: true })
    }
  }

  // stage files (draft only)
  if ((mm = path.match(/^\/api\/events\/([\w-]+)\/stages\/(\d+)$/))) {
    const e = await getEvent(env, mm[1]); const idx = +mm[2]
    const u = await requireManager(env, req, e)
    if (e.status === 'locked') fail(409, 'the event is locked: its files can no longer change')
    if (idx < 1 || idx > 20) fail(400, 'stage number 1-20')
    if (m === 'PUT') {
      const b = await readJson(req, 2 * MAX_FILE + 1e5)
      const stageText = String(b.stageText || ''), rbText = String(b.roadbookText || '')
      if (stageText.length > MAX_FILE || rbText.length > MAX_FILE) fail(413, 'a file is over 5 MB')
      const s = checkStageText(stageText)
      if (!rbText) fail(400, 'the roadbook file is required (official runs are roadbook-only)')
      checkRoadbookText(rbText, s)
      const stageSha = await sha256Hex(stageText), rbSha = await sha256Hex(rbText)
      await env.FILES.put(`events/${e.id}/ss${idx}/stage.json`, stageText)
      await env.FILES.put(`events/${e.id}/ss${idx}/roadbook.json`, rbText)
      const w = s.waypoints, last = w[w.length - 1]
      const autoKnown = await knownExample(env, s.id, stageSha)
      const known = b.known === true || !!autoKnown
      const reason = b.known === true ? clean(b.knownReason || 'marked by the organizer', 200) : autoKnown
      await env.DB.prepare(`INSERT OR REPLACE INTO event_stages (event_id, idx, name, stage_id, length_km, waypoint_count, stage_sha256, roadbook_sha256,
        stage_bytes, roadbook_bytes, known_stage, known_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(e.id, idx, clean(b.name || s.name || ('SS' + idx), 100), String(s.id), +(last.km || last.stageKm || 0) || null, w.length, stageSha, rbSha,
          new TextEncoder().encode(stageText).length, new TextEncoder().encode(rbText).length, known ? 1 : 0, known ? reason : null).run()
      await audit(env, u.id, 'stage.put', { event: e.id, idx, stageSha, rbSha })
      return json({ ok: true, stageSha256: stageSha, roadbookSha256: rbSha, known, knownReason: known ? reason : null })
    }
    if (m === 'DELETE') {
      await env.DB.prepare('DELETE FROM event_stages WHERE event_id = ? AND idx = ?').bind(e.id, idx).run()
      await env.FILES.delete([`events/${e.id}/ss${idx}/stage.json`, `events/${e.id}/ss${idx}/roadbook.json`])
      return json({ ok: true })
    }
  }

  // lock = publish: hashes recomputed from the stored bytes, one event hash over all of them
  if ((mm = path.match(/^\/api\/events\/([\w-]+)\/lock$/)) && m === 'POST') {
    const e = await getEvent(env, mm[1])
    const u = await requireManager(env, req, e)
    if (e.status === 'locked') fail(409, 'already locked')
    const stages = await stagesOf(env, e.id)
    if (!stages.length) fail(400, 'add at least one stage first')
    const parts = []
    for (const s of stages) {
      const st = await r2Text(env, `events/${e.id}/ss${s.idx}/stage.json`), rb = await r2Text(env, `events/${e.id}/ss${s.idx}/roadbook.json`)
      if (st == null || rb == null) fail(500, `SS${s.idx}: a stored file is missing`)
      const a = await sha256Hex(st), b = await sha256Hex(rb)
      if (a !== s.stage_sha256 || b !== s.roadbook_sha256) fail(500, `SS${s.idx}: stored file does not match its hash`)
      parts.push(`ss${s.idx}:${a}:${b}`)
    }
    const lockHash = await sha256Hex(e.id + '|' + parts.join('|'))
    await env.DB.prepare("UPDATE events SET status = 'locked', locked_at = ?, lock_hash = ?, updated_at = ? WHERE id = ? AND status = 'draft'").bind(now(), lockHash, now(), e.id).run()
    await audit(env, u.id, 'event.locked', { id: e.id, lockHash })
    return json({ ok: true, lockHash })
  }

  // entering
  if ((mm = path.match(/^\/api\/events\/([\w-]+)\/enter$/)) && m === 'POST') {
    const e = await getEvent(env, mm[1])
    const u = await requireUser(env, req)
    if (e.status !== 'locked') fail(409, 'the event is not published yet')
    if (phase(e) === 'closed') fail(409, 'the event is closed')
    const b = await readJson(req, 4096)
    const classes = parseJ(e.classes_json, [])
    if (!classes.includes(b.class)) fail(400, 'pick one of the event classes: ' + classes.join(', '))
    const old = await env.DB.prepare('SELECT * FROM entries WHERE event_id = ? AND user_id = ?').bind(e.id, u.id).first()
    const hc = u.id === e.organizer_id ? 1 : 0          // the organizer drives hors classement on his own stages
    if (old) {
      const hasResults = (await env.DB.prepare('SELECT COUNT(*) AS n FROM results WHERE entry_id = ?').bind(old.id).first()).n
      if (hasResults && old.class !== b.class) fail(409, 'results are in: the class can no longer change')
      await env.DB.prepare('UPDATE entries SET class = ?, vehicle = ?, display_name = ? WHERE id = ?').bind(b.class, clean(b.vehicle, 80), u.display_name, old.id).run()
      return json({ ok: true, entryId: old.id })
    }
    const id = 'en_' + randomId(9)
    await env.DB.prepare('INSERT INTO entries (id, event_id, user_id, display_name, class, vehicle, hc, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, e.id, u.id, u.display_name, b.class, clean(b.vehicle, 80), hc, now()).run()
    await audit(env, u.id, 'entry.created', { event: e.id, id, hc })
    return json({ ok: true, entryId: id, hc: !!hc })
  }
  if ((mm = path.match(/^\/api\/events\/([\w-]+)\/new-key$/)) && m === 'POST') {
    const e = await getEvent(env, mm[1]); const u = await requireUser(env, req)
    await env.DB.prepare('UPDATE entries SET key_version = key_version + 1 WHERE event_id = ? AND user_id = ?').bind(e.id, u.id).run()
    return json({ ok: true, note: 'old event packs can no longer upload: download the packs again' })
  }

  // the event pack (stage + roadbook text, hashes, window, rules, upload key): from the roadbook release on
  if ((mm = path.match(/^\/api\/events\/([\w-]+)\/stages\/(\d+)\/pack$/)) && m === 'GET') {
    const e = await getEvent(env, mm[1]); const idx = +mm[2]
    const u = await requireUser(env, req)
    if (e.status !== 'locked') fail(409, 'the event is not locked yet')
    const entry = await env.DB.prepare('SELECT * FROM entries WHERE event_id = ? AND user_id = ?').bind(e.id, u.id).first()
    if (!entry) fail(403, 'enter the event first')
    if (now() < e.roadbook_release_at && !canManage(u, e)) fail(403, 'the roadbook is released at ' + e.roadbook_release_at + ' (UTC)')
    if (phase(e) === 'closed') fail(409, 'the event is closed')
    const s = await env.DB.prepare('SELECT * FROM event_stages WHERE event_id = ? AND idx = ?').bind(e.id, idx).first()
    if (!s) fail(404, 'no such stage')
    const st = await r2Text(env, `events/${e.id}/ss${idx}/stage.json`), rb = await r2Text(env, `events/${e.id}/ss${idx}/roadbook.json`)
    if ((await sha256Hex(st)) !== s.stage_sha256 || (await sha256Hex(rb)) !== s.roadbook_sha256) {
      await audit(env, u.id, 'pack.hashMismatch', { event: e.id, idx }); fail(500, 'stored files do not match the published hashes: the organizer has been told')
    }
    const pack = {
      format: 'rallyraid-event-pack', schemaVersion: 1, createdAt: now(),
      event: { id: e.id, slug: e.slug, name: e.name, opensAt: e.opens_at, closesAt: e.closes_at, minModVersion: e.min_mod_version, lockHash: e.lock_hash,
        rules: parseJ(e.rules_json, {}), uploadUrl: (env.GAME_UPLOAD_BASE || 'http://stagebuilder.wyans.net') + '/api/game/results',
        page: (env.PUBLIC_BASE || '') + '/events/#/e/' + e.slug },
      stage: { index: idx, key: 'ss' + idx, name: s.name, id: s.stage_id, known: !!s.known_stage },
      files: { stage: { text: st, sha256: s.stage_sha256 }, roadbook: { text: rb, sha256: s.roadbook_sha256 } },
      entry: { id: entry.id, displayName: entry.display_name, class: entry.class, hc: !!entry.hc, token: await uploadKey(env, entry) },
    }
    await audit(env, u.id, 'pack.download', { event: e.id, idx })
    return new Response(JSON.stringify(pack), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${e.slug}-ss${idx}.rrevent.json"` } })
  }

  // the website fallback upload (drag and drop the .rrresult.json file)
  if ((mm = path.match(/^\/api\/events\/([\w-]+)\/results$/)) && m === 'POST') {
    const e = await getEvent(env, mm[1]); const u = await requireUser(env, req)
    const entry = await env.DB.prepare('SELECT * FROM entries WHERE event_id = ? AND user_id = ?').bind(e.id, u.id).first()
    if (!entry) fail(403, 'enter the event first')
    const text = await readText(req, MAX_PACKAGE)
    const pkg = parseJ(text, null)
    if (pkg && pkg.entry && pkg.entry.id && pkg.entry.id !== entry.id) fail(403, 'this result file belongs to another entrant')
    return json(await ingest(env, { entry, event: e, text, via: 'web' }))
  }

  if ((mm = path.match(/^\/api\/events\/([\w-]+)\/leaderboard$/)) && m === 'GET') {
    const e = await getEvent(env, mm[1])
    const u = await currentUser(env, req)
    if (e.status !== 'locked' && !canManage(u, e)) fail(404, 'no such event')
    const stages = await stagesOf(env, e.id)
    const entries = (await env.DB.prepare('SELECT * FROM entries WHERE event_id = ?').bind(e.id).all()).results
    const results = (await env.DB.prepare('SELECT id, entry_id, stage_idx, attempt, status, total_time, review_penalty, retired, received_at FROM results WHERE event_id = ?').bind(e.id).all()).results
    return json({ leaderboard: buildLeaderboard({ event: { classes: parseJ(e.classes_json, []) }, stages, entries, results }), phase: phase(e) })
  }

  // review: the organizer's list, one result with its trace, a decision
  if ((mm = path.match(/^\/api\/events\/([\w-]+)\/review$/)) && m === 'GET') {
    const e = await getEvent(env, mm[1]); await requireManager(env, req, e)
    const rows = (await env.DB.prepare(`SELECT r.*, x.display_name, x.class FROM results r JOIN entries x ON x.id = r.entry_id WHERE r.event_id = ?
      ORDER BY (r.status = 'flagged') DESC, r.received_at DESC LIMIT 500`).bind(e.id).all()).results
    return json({ results: rows.map(r => ({ ...r, checks: parseJ(r.checks_json, []), checks_json: undefined })) })
  }
  if ((mm = path.match(/^\/api\/results\/([\w-]+)$/)) && m === 'GET') {
    const u = await requireUser(env, req)
    const r = await env.DB.prepare('SELECT r.*, x.user_id, x.display_name, x.class FROM results r JOIN entries x ON x.id = r.entry_id WHERE r.id = ?').bind(mm[1]).first()
    if (!r) fail(404, 'no such result')
    const e = await getEvent(env, r.event_id)
    if (!canManage(u, e) && u.id !== r.user_id) fail(403, 'not your result')
    const pkg = parseJ(await r2Text(env, r.package_key), {})
    const sf = parseJ(await r2Text(env, `events/${e.id}/ss${r.stage_idx}/stage.json`), {})
    const res = pkg.result || {}
    return json({ result: { ...r, checks: parseJ(r.checks_json, []), checks_json: undefined },
      detail: { stageTime: res.stageTime, penalties: res.penalties, waypoints: res.waypoints, gameCrashResume: res.gameCrashResume && { count: res.gameCrashResume.count, review: res.gameCrashResume.review, resumes: (res.gameCrashResume.resumes || []).map(x => ({ savedAt: x.savedAt, resumedAt: x.resumedAt, wallGapS: x.wallGapS, diff: x.diff, summary: x.summary })) },
        carRecovery: res.carRecovery && { attempts: res.carRecovery.attempts }, vehicle: res.vehicle, modVersion: pkg.modVersion, startedAt: res.startedAt, finishedAt: res.finishedAt },
      trace: tracePoints(pkg.trace).map(p => [p.t, p.w, p.lat, p.lon, p.odo, p.kmh]),
      waypoints: (sf.waypoints || []).map(w => ({ type: w.type, lat: w.lat, lon: w.lon, n: w.n })) })
  }
  if ((mm = path.match(/^\/api\/results\/([\w-]+)\/review$/)) && m === 'POST') {
    const u = await requireUser(env, req)
    const r = await env.DB.prepare('SELECT * FROM results WHERE id = ?').bind(mm[1]).first()
    if (!r) fail(404, 'no such result')
    const e = await getEvent(env, r.event_id)
    if (!canManage(u, e)) fail(403, 'only the organizer or an admin')
    const b = await readJson(req, 8192)
    const status = { approve: 'approved', reject: 'rejected', reopen: 'flagged' }[b.decision]
    if (!status) fail(400, 'decision: approve, reject or reopen')
    const pen = Math.max(0, Math.min(36000, +b.penaltyS || 0))
    const note = clean(b.note, 1000)
    if (status === 'rejected' && note.length < 3) fail(400, 'say why (the entrant sees it)')
    await env.DB.prepare('UPDATE results SET status = ?, review_penalty = ?, review_note = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?')
      .bind(status, status === 'approved' ? pen : 0, note, u.id, now(), r.id).run()
    await audit(env, u.id, 'result.review', { id: r.id, status, pen, note })
    return json({ ok: true, status })
  }
  return null
}
