// Server checks of an official result package (docs: EVENTS.md "Server checks"). Pure functions: no I/O, so the
// same code runs in the Worker and in node's unit tests. Nothing here disqualifies anyone: a failed check only
// flags the result for the organizer's review ("pass" goes straight to the leaderboard, "flagged" waits).
//
// check = { id, level: 'error' | 'review' | 'info', ok, msg }. Any failed error/review check => status 'flagged'.

export const DEFAULTS = {
  maxKmh: 250,            // a car faster than this between two trace points (or reporting it) is implausible
  teleportKmh: 400,       // faster than this between two points = a teleport / position jump
  gapS: 120,              // a wall-clock gap between two trace points longer than this = not one sitting (review)
  sparseS: 30,            // stage clock between two trace points longer than this = trace incomplete
  startEndM: 400,         // first / last trace point within this of the DSS / ASS
  wpTraceM: 300,          // a validated waypoint has a trace point within this, at its validation time (±2 s)
  lateUploadH: 48,        // an upload this long after the event closed is flagged
  resumeSlackS: 15,       // a game-crash resume covers the gap [saved - slack, resumed + slack]
}

export function versionAtLeast(have, need) {
  if (!need) return true
  const a = String(have || '').match(/\d+/g) || [], b = String(need).match(/\d+/g) || []
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = +(a[i] || 0), y = +(b[i] || 0)
    if (x !== y) return x > y
  }
  return true
}

export function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = Math.PI / 180
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)))
}

const fmt = s => { s = Math.round(s); return `${Math.floor(s / 60)} min ${s % 60} s` }

// the trace as objects (the package stores arrays with the column names in trace.cols)
export function tracePoints(trace) {
  if (!trace || !Array.isArray(trace.pts)) return []
  const cols = Array.isArray(trace.cols) ? trace.cols : ['t', 'w', 'lat', 'lon', 'odo', 'kmh']
  const ix = n => cols.indexOf(n)
  const [it, iw, ila, ilo, io, ik] = ['t', 'w', 'lat', 'lon', 'odo', 'kmh'].map(ix)
  return trace.pts.filter(Array.isArray).map(p => ({ t: +p[it], w: +p[iw], lat: +p[ila], lon: +p[ilo], odo: +p[io], kmh: +p[ik] }))
}

// gaps covered by a flagged game-crash resume (already a review item of its own): [from, to] in trace wall seconds
function resumeWindows(result, epoch0, slack) {
  const out = []
  const list = result && result.gameCrashResume && Array.isArray(result.gameCrashResume.resumes) ? result.gameCrashResume.resumes : []
  for (const r of list) {
    const a = +r.savedEpoch, b = +r.resumedEpoch
    if (Number.isFinite(a) && Number.isFinite(b)) out.push([a - epoch0 - slack, b - epoch0 + slack])
  }
  return out
}

export function checkPackage({ event, stage, stageFile, pkg, entry, receivedAt, attempt = 1, opts = {} }) {
  const O = { ...DEFAULTS, ...((event && event.rules && event.rules.checks) || {}), ...opts }
  const checks = []
  const add = (id, level, ok, msg) => { checks.push({ id, level, ok: !!ok, msg }); return ok }
  const res = (pkg && pkg.result) || {}

  // --- the package itself
  if (!add('format', 'error', pkg && pkg.format === 'rallyraid-result-package' && pkg.schemaVersion === 1 && pkg.result,
    'result package format')) return summarize(checks)
  add('event', 'error', pkg.event && pkg.event.id === event.id, `package is for event ${pkg.event && pkg.event.id}`)
  add('stage', 'error', pkg.stage && +pkg.stage.index === +stage.idx && res.stageId === stage.stage_id,
    `package is for stage ${pkg.stage && pkg.stage.index} (${res.stageId}), expected SS${stage.idx} (${stage.stage_id})`)
  if (entry) add('entry', 'error', pkg.entry && pkg.entry.id === entry.id, 'package belongs to this entry')
  add('modVersion', 'error', versionAtLeast(pkg.modVersion, event.min_mod_version),
    `mod version ${pkg.modVersion} (event needs ${event.min_mod_version} or newer)`)

  // --- locked files
  const h = pkg.hashes || {}
  add('hashStage', 'error', h.stage === stage.stage_sha256, h.stage === stage.stage_sha256 ? 'stage file = published hash' : 'stage file hash differs from the published one')
  if (stage.roadbook_sha256) add('hashRoadbook', 'error', h.roadbook === stage.roadbook_sha256,
    h.roadbook === stage.roadbook_sha256 ? 'roadbook file = published hash' : 'roadbook file hash differs from the published one')

  // --- official rules + the game's own flags
  const gcr = res.gameCrashResume || {}
  add('officialRules', 'error', pkg.rules && pkg.rules.official === true && gcr.rules && gcr.rules.useOfficialRules === true,
    'run in official mode (official rules, resume limits on)')
  add('officialFlag', 'review', res.official === true,
    res.official === true ? 'no teleport / position jump / part-repair mod' : 'the game marked the run unofficial: ' +
      Object.keys(res.flags || {}).filter(k => ['teleported', 'positionJump', 'ipr', 'rallyRetired'].includes(k)).join(', '))
  const nRes = Array.isArray(gcr.resumes) ? gcr.resumes.length : 0
  add('gameCrashResume', 'review', !gcr.flagged, gcr.flagged ? `${nRes} game-crash resume(s): review the gap and saved vs resumed state` : 'no game-crash resume')
  const rec = res.carRecovery || {}
  const recLog = Array.isArray(rec.log) ? rec.log : Array.isArray(rec.attempts) ? rec.attempts : []
  const recUsed = recLog.filter(e => e && (e.ok || e.done || e.kind === 'carRecovery')).length
  add('carRecovery', 'info', true, recUsed ? `${recUsed} car recovery(ies), penalties already in the time` : 'no car recovery')
  if (res.reviewRequired) add('gameReview', 'review', false, 'the game asked for a review (reviewRequired)')

  // --- times + waypoints in order
  const st = +res.stageTime, pt = +res.penaltyTime, tt = +res.totalTime
  add('times', 'error', Number.isFinite(st) && st > 0 && Math.abs(st + pt - tt) < 0.6, `stage ${(+st).toFixed(1)} s + penalties ${(+pt).toFixed(1)} s = total ${(+tt).toFixed(1)} s`)
  const penSum = (res.penalties || []).reduce((s, p) => s + (+p.seconds || 0), 0)
  add('penalties', 'error', Math.abs(penSum - pt) < 0.6, `penalty list adds up to ${penSum} s (total says ${pt} s)`)
  const sw = (stageFile && stageFile.waypoints) || [], rw = res.waypoints || []
  let orderOk = rw.length === sw.length, why = orderOk ? '' : `${rw.length} waypoints in the log, ${sw.length} in the stage`
  let last = -1
  for (let i = 0; orderOk && i < rw.length; i++) {
    const w = rw[i], s = sw[i]
    if (String(w.type).toUpperCase() !== String(s.type).toUpperCase()) { orderOk = false; why = `waypoint ${i + 1} is ${w.type}, stage says ${s.type}` }
    else if (w.status === 'ok') {
      if (!(+w.time >= last - 0.01)) { orderOk = false; why = `waypoint ${i + 1} validated before waypoint ${i}` }
      last = +w.time
    }
  }
  if (orderOk && rw.length) {
    if (rw[0].status !== 'ok' || +rw[0].time !== 0) { orderOk = false; why = 'DSS not validated at 0' }
    else if (!res.retired && rw[rw.length - 1].status !== 'ok') { orderOk = false; why = 'ASS not validated' }
    else if (!res.retired && Math.abs(+rw[rw.length - 1].time - st) > 1) { orderOk = false; why = 'ASS time differs from the stage time' }
  }
  add('waypointOrder', 'error', orderOk, orderOk ? `${rw.filter(w => w.status === 'ok').length} of ${rw.length} waypoints validated in order` : why)
  const missed = rw.filter(w => w.status === 'missed').length
  if (missed) add('missed', 'info', true, `${missed} waypoint(s) missed (penalised in the time)`)

  // --- the event window (the game's clock) and the upload time (the server's)
  const t0 = Date.parse(res.startedAt), t1 = Date.parse(res.finishedAt)
  add('window', 'review', t0 >= Date.parse(event.opens_at) && t1 <= Date.parse(event.closes_at) + 60e3,
    `driven ${res.startedAt} - ${res.finishedAt} (event ${event.opens_at} - ${event.closes_at})`)
  const late = (Date.parse(receivedAt) - Date.parse(event.closes_at)) / 3600e3
  add('upload', 'review', !(late > O.lateUploadH), late > 0 ? `uploaded ${late.toFixed(1)} h after the close` : 'uploaded in time')
  if (attempt > 1) add('attempt', 'review', false, `extra attempt #${attempt} of this stage (the first one counts unless the organizer decides otherwise)`)

  // --- the trace
  const tr = pkg.trace || {}
  const P = tracePoints(tr)
  const minPts = Math.max(3, Math.floor(st / ((+tr.everyS || 5) * 2)))
  if (!add('traceLength', 'error', P.length >= minPts, `${P.length} trace points (at least ${minPts} expected for ${fmt(st)})`)) return summarize(checks, P)
  let mono = true, maxKmh = 0, maxSeg = null, teleports = [], sparse = [], gaps = [], odoBad = 0
  const win = resumeWindows(res, +tr.epoch0 || 0, O.resumeSlackS)
  const covered = (a, b) => win.some(([x, y]) => a >= x && b <= y)
  let straight = 0
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i]
    const dt = b.t - a.t, dw = b.w - a.w
    if (dt < -0.05 || dw < -1 || b.odo < a.odo - 0.002) mono = false
    const d = distM(a.lat, a.lon, b.lat, b.lon)
    straight += d
    if (dt > 0.05) {
      const kmh = d / dt * 3.6
      if (kmh > maxKmh) { maxKmh = kmh; maxSeg = i }
      if (kmh > O.teleportKmh && d > 50) teleports.push({ i, t: a.t, d: Math.round(d), kmh: Math.round(kmh) })
    } else if (d > 100) teleports.push({ i, t: a.t, d: Math.round(d), kmh: Infinity })
    if (dt > O.sparseS) sparse.push({ i, t: a.t, dt })
    if (dw > O.gapS && !covered(a.w, b.w)) gaps.push({ i, t: a.t, w: a.w, gapS: dw })
    // the car's own odometer must cover at least the straight line between the two points (a short cut can't)
    const dOdo = (b.odo - a.odo) * 1000
    if (d > dOdo * 1.1 + 30) odoBad++
  }
  add('traceOrder', 'error', mono, mono ? 'trace times and odometer only go forward' : 'trace times or odometer go backwards')
  add('teleport', 'review', teleports.length === 0, teleports.length ? `${teleports.length} jump(s), first at ${fmt(teleports[0].t)}: ${teleports[0].d} m` : 'no position jumps')
  const repKmh = Math.max(0, ...P.map(p => p.kmh || 0))
  add('speed', 'review', maxKmh <= O.maxKmh && repKmh <= O.maxKmh,
    `top speed ${Math.round(Math.max(maxKmh, repKmh))} km/h (limit for plausibility ${O.maxKmh})`)
  add('oneSitting', 'review', gaps.length === 0, gaps.length
    ? `${gaps.length} break(s) over ${O.gapS / 60} min in the trace (game paused or closed), longest ${fmt(Math.max(...gaps.map(g => g.gapS)))} at stage time ${fmt(gaps[0].t)}`
    : `no break over ${O.gapS / 60} min` + (win.length ? ' (game-crash resume gaps excluded: reviewed on their own)' : ''))
  add('traceDense', 'review', sparse.length === 0, sparse.length ? `${sparse.length} hole(s) in the trace (> ${O.sparseS} s of stage time)` : 'trace has no holes')
  add('odometer', 'review', odoBad === 0, odoBad ? `${odoBad} trace step(s) longer than the odometer allows (short cut?)` : 'odometer covers every step')
  const odoEnd = P[P.length - 1].odo
  add('distance', 'review', Math.abs(odoEnd - (+res.distanceDriven || 0)) < 0.2 && straight / 1000 <= odoEnd * 1.05 + 0.3,
    `driven ${(+res.distanceDriven || 0).toFixed(2)} km, trace odometer ${odoEnd.toFixed(2)} km, straight-line sum ${(straight / 1000).toFixed(2)} km`)
  const dss = sw[0], ass = sw[sw.length - 1]
  if (dss) add('traceStart', 'review', distM(P[0].lat, P[0].lon, dss.lat, dss.lon) <= O.startEndM && P[0].t < 2, 'trace starts at the DSS')
  if (ass && !res.retired) add('traceEnd', 'review', distM(P[P.length - 1].lat, P[P.length - 1].lon, ass.lat, ass.lon) <= O.startEndM, 'trace ends at the ASS')
  // every validated waypoint: a trace point at its time, near it
  let wpBad = []
  for (let i = 0; i < rw.length && i < sw.length; i++) {
    if (rw[i].status !== 'ok') continue
    const tw = +rw[i].time
    let best = Infinity
    for (const p of P) if (Math.abs(p.t - tw) <= 2) best = Math.min(best, distM(p.lat, p.lon, sw[i].lat, sw[i].lon))
    if (!(best <= O.wpTraceM)) wpBad.push(i + 1)
  }
  add('waypointTrace', 'review', wpBad.length === 0, wpBad.length ? `no trace point near waypoint(s) ${wpBad.slice(0, 8).join(', ')} at their validation time` : 'every validated waypoint is on the trace')
  return summarize(checks, P, { maxKmh: Math.round(maxKmh), gaps, teleports, resumeWindows: win })
}

function summarize(checks, P, extra) {
  const failed = checks.filter(c => !c.ok && c.level !== 'info')
  return { status: failed.length ? 'flagged' : 'pass', checks, failed: failed.map(c => c.id), points: P ? P.length : 0, ...(extra || {}) }
}

// leaderboard: the results that count (pass / approved, first attempt unless approved), per class and HC apart
export function buildLeaderboard({ event, stages, entries, results }) {
  const byEntry = new Map(entries.map(e => [e.id, e]))
  const counted = new Map()       // `${entry}:${idx}` -> result
  const pending = new Map()
  for (const r of results.slice().sort((a, b) => a.attempt - b.attempt || (a.received_at < b.received_at ? -1 : 1))) {
    const k = r.entry_id + ':' + r.stage_idx
    if (r.status === 'pass' || r.status === 'approved') { if (!counted.has(k)) counted.set(k, r) }
    else if (r.status === 'flagged') pending.set(k, (pending.get(k) || 0) + 1)
  }
  const time = r => (+r.total_time || 0) + (+r.review_penalty || 0)
  const rows = entries.map(e => {
    const per = stages.map(s => {
      const r = counted.get(e.id + ':' + s.idx)
      return r ? { idx: s.idx, total: r.retired ? null : time(r), retired: r.retired || null, resultId: r.id, reviewed: r.status === 'approved' }
        : { idx: s.idx, total: null, pending: pending.get(e.id + ':' + s.idx) || 0 }
    })
    const done = per.filter(p => p.total != null)
    return { entryId: e.id, name: e.display_name, class: e.class, vehicle: e.vehicle, hc: !!e.hc, stages: per,
      complete: done.length === stages.length, overall: done.length === stages.length ? done.reduce((s, p) => s + p.total, 0) : null,
      pending: per.reduce((s, p) => s + (p.pending || 0), 0) }
  })
  const rank = list => {
    list.sort((a, b) => (a.overall == null) - (b.overall == null) || (a.overall || 0) - (b.overall || 0) || a.name.localeCompare(b.name))
    let pos = 0
    for (const r of list) r.pos = r.overall == null ? null : ++pos
    return list
  }
  const classes = (event.classes || []).map(c => ({ class: c, rows: rank(rows.filter(r => !r.hc && r.class === c)) }))
  const other = rows.filter(r => !r.hc && !(event.classes || []).includes(r.class))
  if (other.length) classes.push({ class: 'Other', rows: rank(other) })
  return { classes, horsClassement: rank(rows.filter(r => r.hc)),
    stages: stages.map(s => ({ idx: s.idx, name: s.name, known: !!s.known_stage, knownReason: s.known_reason || null, lengthKm: s.length_km })) }
}
