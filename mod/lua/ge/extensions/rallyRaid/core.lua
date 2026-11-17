-- rally.raid Earth: the rally computer and the stage logic (the game names this extension
-- "rallyRaid_core" from its path). Loaded by scripts/rallyRaid/modScript.lua.
--
-- What it does, ten times a second:
--   * reads the player's position from BeamNG.Earth's modding API (beamngEarth_api.pose(): lat / lon, never game
--     coordinates, so the world's rebasing every ~15 km cannot break anything)
--   * runs the rally computer: CAP (course over ground), trip (adjustable, matches the roadbook), partial, total
--   * runs the stage: DSS start, waypoints in order with the FIM reveal / validation rules, missed-waypoint penalties,
--     DZ / FZ speed zones with impulse penalties, the stage clock, the ASS finish and the results file
--   * sends everything to the HUD app (guihooks 'RallyRaidUpdate') and to a roadbook (guihooks 'RallyRaidRoadbook',
--     the game hooks onRallyRaid*, and optionally a live JSON file): docs/STAGE_FORMAT.md "Roadbook sync"
local geo = require('rallyRaid/geo')
local rulesMod = require('rallyRaid/rules')
local stagesMod = require('rallyRaid/stages')
local recce = require('rallyRaid/recce')
local repair = require('rallyRaid/repair')
local planner = require('rallyRaid/planner')
local resume = require('rallyRaid/resume')            -- RECOVER CAR (the one reset allowed in a stage)
local gameResume = require('rallyRaid/gameResume')    -- the stage saved to disk: resume after a GAME crash
-- official.lua (async events) is omitted from the public zip. A no-op stand-in keeps the rest of the
-- rally computer loading if that file is not in this build. trace.lua stays: ordinary stages still record a line.
local officialOk, official = pcall(require, 'rallyRaid/official')
if not officialOk then
  official = {
    init = function () end,
    attach = function () return nil end,
    preStart = function () return true end,
    finish = function () return nil end,
    refuse = function () return false end,
    cmd = function () end,
    update = function () end,
    active = function () return false end,
    state = function () return { available = false } end,
    load = function () return { error = 'Async Events is not in this build' } end,
    _reset = function () end,
  }
end
local keys = require('rallyRaid/keys')              -- the player's key on each action (text for the apps)
local traceMod = require('rallyRaid/trace')           -- the stage's GPS trace (for the result package)

local M = {}
M.VERSION = '0.2.0'   -- 0.2.0: official event runs (rallyRaid/official.lua)

local SETTINGS_FILE = '/settings/rallyRaid.json'
local RESULTS_DIR = '/rallyraid/results/'
local LIVE_FILE = '/rallyraid/live.json'
local TICK = 0.1                -- s between checks (at 150 km/h the car moves ~4 m: inside even the 20 m WPP radius)
local MAX_JUMP_SPEED = 150      -- m/s; a position jump faster than this is a teleport / reset, not driving

M.settings = { tripStep = 10, units = 'metric', liveFile = false, notify = true }

------------------------------------------------------------------------------------------------------------------
-- state
local S                         -- the running stage (nil = none loaded)
local odo = { trip = 0, partial = 0, total = 0, countDown = false }
local nav = { cap = nil, heading = nil, speed = 0, lat = nil, lon = nil, fwd = 0, ok = false, why = 'starting' }
local tickAcc, liveAcc = 0, 0
local hold = { dir = 0, t = 0, rep = 0 }

local function log_(level, msg) if log then log(level, 'rallyRaid', msg) else print('[rallyRaid] ' .. msg) end end
local function api() local a = rawget(_G, 'beamngEarth_api'); if a and a.version and a.version() == 1 then return a end end
local function ui(name, data) if guihooks and guihooks.trigger then pcall(guihooks.trigger, name, data) end end
local function hook(name, info) if extensions and extensions.hook then pcall(extensions.hook, name, info) end end
local function notify(text, secs)
  if not M.settings.notify then return end
  local a = api()
  if a and a.notify then pcall(a.notify, text, secs or 4) elseif ui_message then pcall(ui_message, text, secs or 4, 'rallyRaid') end
end

local function loadSettings()
  local read = rawget(_G, 'jsonReadFile')
  if not read then return end
  local ok, d = pcall(read, SETTINGS_FILE)
  if ok and type(d) == 'table' then for k, v in pairs(d) do M.settings[k] = v end end
end
local function saveSettings()
  local write = rawget(_G, 'jsonWriteFile')
  if write then pcall(write, SETTINGS_FILE, M.settings, true) end
end

------------------------------------------------------------------------------------------------------------------
-- penalties
local function addPenalty(kind, seconds, detail)
  seconds = tonumber(seconds)
  if not S or not seconds or seconds <= 0 then return end
  local p = { kind = kind, seconds = seconds, detail = detail, t = S.clock }
  S.penalties[#S.penalties + 1] = p
  S.penaltyTotal = S.penaltyTotal + seconds
  return p
end
local function removePenalty(kind, wpIndex)
  for i = #S.penalties, 1, -1 do
    local p = S.penalties[i]
    if p.kind == kind and p.wp == wpIndex then
      S.penaltyTotal = S.penaltyTotal - p.seconds
      table.remove(S.penalties, i)
      return
    end
  end
end

------------------------------------------------------------------------------------------------------------------
-- stage loading
function M.listStages() return stagesMod.list() end

function M.loadStage(path)
  local stage, errs = stagesMod.load(path)
  if not stage then
    local msg = 'rally.raid Earth: cannot load ' .. tostring(path) .. ': ' .. table.concat(errs or {}, '; ')
    log_('E', msg); notify(msg, 8)
    ui('RallyRaidError', { message = msg })
    return false, errs
  end
  return M.loadStageTable(stage)
end

function M.loadStageTable(stage)
  -- a roadbook made in the editor replaces the stage's own (waypoint-only) boxes for the roadbook display / sync
  stage.roadbook = type(stage.roadbook) == 'table' and stage.roadbook or { boxes = {} }
  if not stage.roadbook.stageBoxes then stage.roadbook.stageBoxes = stage.roadbook.boxes end
  local rbBoxes, rbInfo = stagesMod.loadRoadbook(stage)
  local rbMsg
  if rbBoxes then
    stage.roadbook.boxes, stage.roadbook.source = rbBoxes, rbInfo
    stagesMod.applyRoadbookKm(stage, rbBoxes)
    rbMsg = ' Roadbook: ' .. #rbBoxes .. ' boxes.'
    for _, w in ipairs(rbInfo.warnings or {}) do log_('W', w); rbMsg = rbMsg .. ' ' .. w end
  else
    stage.roadbook.boxes, stage.roadbook.source = stage.roadbook.stageBoxes or {}, nil
    stagesMod.applyRoadbookKm(stage, nil)
    for _, w in ipairs(rbInfo or {}) do log_('W', 'roadbook not used: ' .. w) end
  end
  -- recce running: the same stage keeps its recce (its changes show on the fresh boxes again); another stage ends it
  if recce.active() then
    local R = recce.get()
    if R.ctx.stage.id == stage.id then
      R.ctx.stage, R.ctx.boxes, R.ctx.rbInfo = stage, stage.roadbook.boxes, stage.roadbook.source
      for _, c in ipairs(R.doc.changes) do recce.applyToDisplay(stage.roadbook.boxes, c) end
    else recce.stop(); notify('rally.raid Earth: recce saved and stopped (another stage loaded).', 5) end
  end
  if S and S.phase == 'running' then gameResume.abandon('another stage loaded') end
  local rules = rulesMod.build(stage.rules)
  local wps = stage.waypoints
  S = { stage = stage, rules = rules, phase = 'armed', target = 1, clock = 0, countdown = nil,
    state = {}, times = {}, tripAt = {}, wr = {}, penalties = {}, penaltyTotal = 0, impulses = 0,
    zone = nil, globalImpulses = 0, gAcc = nil, atStart = false, flags = {}, startedAt = nil }
  for i, w in ipairs(wps) do S.state[i] = 'pending'; S.wr[i] = rulesMod.forWaypoint(rules, w) end
  S.official = official.attach(stage)            -- an official event run (pack loaded by official.load), else nil
  log_('I', 'loaded stage ' .. stage.id .. ' (' .. #wps .. ' waypoints)')
  notify('rally.raid Earth: ' .. stage.name .. ' loaded.' .. (rbMsg or '') .. ' Drive to the DSS.', rbMsg and 7 or 5)
  hook('onRallyRaidStageLoaded', { id = stage.id, name = stage.name, path = stage.path })
  repair.stageChanged()
  resume.stageChanged()
  gameResume.stageLoaded()                       -- a save of this stage on disk (the game crashed): offer to resume it
  M.requestState()
  return true
end

function M.unloadStage()
  if recce.active() then recce.stop() end
  gameResume.abandon('stage unloaded')
  S = nil
  repair.stageChanged()
  resume.stageChanged()
  M.requestState()
end

function M.teleportToStart()
  local a = api()
  if not (S and a and a.teleport) then return false end
  if S.phase == 'running' then notify('rally.raid Earth: not during a running stage (abort first).', 4); return false end
  local w = S.stage.waypoints[1]
  local st = S.stage.start
  local lat, lon = (st and tonumber(st.lat)) or w.lat, (st and tonumber(st.lon)) or w.lon
  repair.expectReset('teleport')                 -- a teleport may reset the car: not a repair
  local ok, why = a.teleport(lat, lon, 'DSS ' .. S.stage.name)
  if not ok then notify('rally.raid Earth: teleport refused (' .. tostring(why) .. ')', 5) end
  return ok
end

------------------------------------------------------------------------------------------------------------------
-- the stage state machine
local function tracePoint(force)
  if not (S and S.trace and nav.lat) then return end
  traceMod.add(S.trace, { clock = S.clock, wall = os.time(), lat = nav.lat, lon = nav.lon,
    odoKm = (odo.total - (S.totalAtStart or odo.total)) / 1000, kmh = nav.speed * 3.6, heading = nav.cap }, force)
end

local function startClock(reason)
  -- an official run: the files' hashes, the mod version and the event window are checked again first
  if S.official and not official.preStart() then S.phase = 'armed'; S.countdown = nil; M.requestState() return end
  S.phase = 'running'
  S.clock = 0
  S.countdown = nil
  S.state[1] = 'ok'; S.times[1] = 0; S.tripAt[1] = odo.trip
  S.target = 2
  S.startedAt = os.date('!%Y-%m-%dT%H:%M:%SZ')
  S.totalAtStart = odo.total
  if S.rules.tripSnapToWaypoint then odo.trip = (S.stage.waypoints[1].km or 0) * 1000 end
  odo.partial = 0
  S.trace = traceMod.new(os.time())
  tracePoint(true)
  notify('rally.raid Earth: GO! ' .. S.stage.name, 3)
  repair.stageStarted()                          -- closes an open bivouac (its penalties land here), blocks free resets
  resume.stageStarted()                          -- car recovery: recovery states from now on
  gameResume.stageStarted()                      -- game-crash saves to disk from now on
  hook('onRallyRaidStageStart', { id = S.stage.id, reason = reason })
  hook('onRallyRaidWaypoint', { index = 1, n = S.stage.waypoints[1].n, type = 'DSS', status = 'ok', clock = 0,
    trip = odo.trip / 1000 })
end

local function zoneBegin(i)
  local w = S.stage.waypoints[i]
  local fz
  for j = i + 1, #S.stage.waypoints do if S.stage.waypoints[j].type == 'FZ' then fz = j break end end
  S.zone = { dz = i, fz = fz, limit = w.speedLimit, live = false, impulses = 0, over = false, acc = 0, accT = 0 }
end

local function finish()
  S.phase = 'finished'
  local res = M.results()
  S.result = res
  local write = rawget(_G, 'jsonWriteFile')
  if write then
    local safe = tostring(S.stage.id):gsub('[^%w%-_]', '_')
    local path = RESULTS_DIR .. safe .. '_' .. os.date('%Y%m%d_%H%M%S') .. '.json'
    local ok = pcall(write, path, res, true)
    S.resultPath = ok and path or nil
  end
  if res.retired then
    notify('rally.raid Earth: stage RETIRED (' .. tostring(res.retired) .. ').', 10)
  else
    notify(string.format('rally.raid Earth: finish! %s + %s penalties = %s', M.fmtTime(res.stageTime),
      M.fmtTime(res.penaltyTime), M.fmtTime(res.totalTime)), 10)
  end
  if S.official then S.officialFile = official.finish(res, traceMod.export(S.trace)) end
  repair.stageFinished(res)                      -- opens the bivouac
  gameResume.stageFinished()                     -- the stage is over: its game-crash save goes
  hook('onRallyRaidStageFinish', res)
end
-- the stage ends here without reaching the ASS (repair.lua: a reset that is not allowed); the result says why
local function retireStage(reason)
  if not (S and S.phase == 'running') then return end
  S.flags.retired = reason or true
  finish()
end

local function markMissed(j)
  if S.state[j] ~= 'pending' then return end
  S.state[j] = 'missed'
  local w = S.stage.waypoints[j]
  local p = addPenalty('missedWaypoint', S.wr[j].penalty, w.type .. ' ' .. w.n .. ' missed')
  if p then p.wp = j end
  hook('onRallyRaidWaypoint', { index = j, n = w.n, type = w.type, status = 'missed', clock = S.clock, trip = odo.trip / 1000 })
end

local function validate(i)
  local wps = S.stage.waypoints
  for j = S.target, i - 1 do markMissed(j) end
  local w = wps[i]
  S.state[i] = 'ok'; S.times[i] = S.clock; S.tripAt[i] = odo.trip
  S.target = i + 1
  tracePoint(true)
  if S.rules.tripSnapToWaypoint and w.km then odo.trip = w.km * 1000 end
  hook('onRallyRaidWaypoint', { index = i, n = w.n, type = w.type, status = 'ok', clock = S.clock, trip = odo.trip / 1000,
    km = w.km })
  if w.type == 'DZ' then zoneBegin(i)
  elseif w.type == 'FZ' then S.zone = nil end
  if w.type == 'ASS' then finish() else notify(w.type .. ' ' .. w.n .. ' OK', 2) end
end

-- is waypoint i shown on the GPS (distance d metres away)?
local function revealed(i, d)
  local r = S.wr[i]
  local prevOk = (i == 1) or S.state[i - 1] == 'ok'
  if r.reveal == 'always' then return true end
  if r.reveal == 'never' then return false end
  if r.reveal == 'radius' then return d <= (r.radius or 0) end
  if r.reveal == 'prev' then return prevOk or d <= (r.radius or 1000) end
  if r.reveal == 'radiusOrPrev' then
    if d <= (r.radius or 1000) then return true end
    if i > 1 and prevOk then
      local a, b = S.stage.waypoints[i - 1], S.stage.waypoints[i]
      return geo.dist(a.lat, a.lon, b.lat, b.lon) <= (r.radius or 1000)
    end
    return false
  end
  return false
end

local function speedZone(dtMove, dt)
  local z = S.zone
  if not z then return end
  local wps, sz = S.stage.waypoints, S.rules.speedZone
  local dz = wps[z.dz]
  if z.fz and S.state[z.fz] ~= 'pending' then S.zone = nil return end
  -- live between leaving the DZ tolerance circle and entering the FZ tolerance circle
  local dDz = geo.dist(nav.lat, nav.lon, dz.lat, dz.lon)
  local dFz = z.fz and geo.dist(nav.lat, nav.lon, wps[z.fz].lat, wps[z.fz].lon) or math.huge
  local tol = tonumber(sz.tolerance) or 90
  if not z.live and dDz > tol then z.live = true end
  z.tolerance = (not z.live) or dFz <= tol
  if z.tolerance then z.over = false return end
  local kmh = nav.speed * 3.6
  local over = kmh - z.limit
  if over >= 1 then
    local fire = false
    if not z.over then fire = true; z.over = true; z.acc, z.accT = 0, 0
    else
      z.acc, z.accT = z.acc + dtMove, z.accT + dt
      if z.acc >= (tonumber(sz.impulseDistance) or 150) or z.accT >= (tonumber(sz.impulseTime) or 10) then fire = true; z.acc, z.accT = 0, 0 end
    end
    if fire then
      z.impulses = z.impulses + 1
      S.impulses = S.impulses + 1
      local pen = rulesMod.impulsePenalty(S.rules, over)
      addPenalty('speedImpulse', pen, string.format('%d km/h in a %d zone (+%d)', math.floor(kmh), z.limit, math.floor(over)))
      hook('onRallyRaidSpeedImpulse', { kmh = kmh, limit = z.limit, penalty = pen, clock = S.clock })
    end
  else
    z.over = false
  end
end

local function globalSpeed(dtMove, dt)
  local max = tonumber(S.rules.globalMaxKmh)
  if not max then return end
  local kmh = nav.speed * 3.6
  if kmh - max >= 1 then
    local g = S.gAcc
    local fire = false
    if not g then S.gAcc = { acc = 0, accT = 0 }; fire = true
    else
      g.acc, g.accT = g.acc + dtMove, g.accT + dt
      if g.acc >= (tonumber(S.rules.speedZone.impulseDistance) or 150) or g.accT >= (tonumber(S.rules.speedZone.impulseTime) or 10) then fire = true; g.acc, g.accT = 0, 0 end
    end
    if fire then
      S.globalImpulses = S.globalImpulses + 1
      if S.globalImpulses >= 2 then addPenalty('categorySpeed', S.rules.globalImpulsePenalty, string.format('%d km/h over the %d km/h category limit', math.floor(kmh), max)) end
    end
  else
    S.gAcc = nil
  end
end

local function stageTick(dtMove, dt)
  if not S then return end
  local wps = S.stage.waypoints
  local dss = wps[1]
  if S.phase == 'armed' or S.phase == 'countdown' then
    local d = geo.dist(nav.lat, nav.lon, dss.lat, dss.lon)
    local inside = d <= S.wr[1].validate
    if S.phase == 'countdown' then
      if not inside then
        addPenalty('falseStart', S.rules.falseStartPenalty, 'left the DSS during the countdown')
        startClock('falseStart')
      end
    elseif S.atStart and not inside and S.rules.startMode == 'auto' then
      startClock('auto')
    end
    S.atStart = inside
    return
  end
  if S.phase ~= 'running' then return end
  -- validation: the target, or a later one within `lookahead` (that marks the skipped ones missed)
  local last = math.min(S.target + (tonumber(S.rules.lookahead) or 5), #wps)
  for i = S.target, last do
    local w = wps[i]
    local okToTake = true
    -- a loop stage's finish can sit by its start: only take the ASS early once most of the stage is driven
    if w.type == 'ASS' and i > S.target then okToTake = odo.total - (S.totalAtStart or 0) >= 0.5 * (w.km or 0) * 1000 end
    if okToTake and geo.dist(nav.lat, nav.lon, w.lat, w.lon) <= S.wr[i].validate then validate(i) break end
  end
  if S.phase ~= 'running' then return end
  speedZone(dtMove, dt)
  globalSpeed(dtMove, dt)
end

------------------------------------------------------------------------------------------------------------------
-- the rally computer
local lastFix   -- {lat, lon}

local function computerTick(p, dt)
  nav.lat, nav.lon, nav.speed = p.lat, p.lon, p.speed or 0
  nav.heading = p.heading
  local c = geo.course(p.ve, p.vn, 1.0)
  if c then nav.cap = c elseif nav.cap == nil then nav.cap = p.heading end
  -- forward / backward along the car's nose: a rally trip counts down when you reverse
  local fwd = 1
  if p.heading and p.ve and p.vn then
    local h = math.rad(p.heading)
    if (p.ve * math.sin(h) + p.vn * math.cos(h)) < -0.3 then fwd = -1 end
  end
  nav.fwd = fwd
  local moved = 0
  if lastFix then
    moved = geo.dist(lastFix.lat, lastFix.lon, p.lat, p.lon)
    if moved > MAX_JUMP_SPEED * math.max(dt, TICK) + 5 then
      if S and S.phase == 'running' then S.flags.positionJump = true end
      moved = 0
    end
  end
  lastFix = { lat = p.lat, lon = p.lon }
  if moved < 0.05 then moved = 0 end           -- standing still: no GPS drift on the trip
  local sign = fwd * (odo.countDown and -1 or 1)
  odo.trip = odo.trip + sign * moved
  odo.partial = odo.partial + sign * moved
  odo.total = odo.total + moved
  return moved
end

------------------------------------------------------------------------------------------------------------------
-- outputs
function M.fmtTime(s)
  s = math.max(0, s or 0)
  return string.format('%d:%02d:%02d', math.floor(s / 3600), math.floor(s / 60) % 60, math.floor(s) % 60)
end

local function boxAt(tripKm)
  if not S then return nil end
  local boxes = S.stage.roadbook.boxes
  local idx
  for i, b in ipairs(boxes) do if tonumber(b.km) and tonumber(b.km) <= tripKm + 1e-6 then idx = i end end
  return idx
end

-- what the roadbook display shows: the box the odometer is in and the next ones, or the box the driver scrolled to
-- (box up / down keys). A trip change (adjust, reset, set, sync) or reaching the scrolled-to box ends the scroll.
local VIEW_BOXES = 4
local function viewBox(b, cur)
  return { n = b.n, km = b.km, partial = b.partial, cap = b.cap or b.capOut, label = b.label, waypoint = b.waypoint,
    notes = b.notes, danger = b.danger, symbols = b.symbols, tulip = b.tulip, offPiste = b.offPiste, current = cur or nil,
    recce = b.recce, verified = b.verified }
end
function M.roadbookState()
  local tripKm = odo.trip / 1000
  local idx = boxAt(tripKm)
  local boxes = S and S.stage.roadbook.boxes or {}
  -- scrolled ahead and then driven up to that box, or scrolled back and then driven on to the next box: follow again
  if S and S.rbView and idx and idx ~= S.rbAt and (idx >= S.rbView or S.rbView < (S.rbAt or 0)) then S.rbView = nil end
  local top = (S and S.rbView) or idx or 1
  local view = {}
  for i = top, math.min(#boxes, top + VIEW_BOXES - 1) do view[#view + 1] = viewBox(boxes[i], i == idx) end
  local nxt = boxes[(idx or 0) + 1]
  local lastWp
  if S then for i = S.target - 1, 1, -1 do if S.state[i] == 'ok' then local w = S.stage.waypoints[i]; lastWp = { n = w.n, type = w.type, km = w.km } break end end end
  return { schema = 1, stageId = S and S.stage.id or nil, phase = S and S.phase or 'idle',
    trip = tripKm, partial = odo.partial / 1000, total = odo.total / 1000, countDown = odo.countDown,
    cap = nav.cap, speed = nav.speed * 3.6, clock = S and S.clock or 0,
    boxIndex = idx, box = idx and boxes[idx] and boxes[idx].n or nil,
    nextBox = nxt and nxt.n or nil, toNextBox = nxt and tonumber(nxt.km) and (tonumber(nxt.km) - tripKm) or nil,
    lastWaypoint = lastWp, lat = nav.lat, lon = nav.lon,
    boxCount = #boxes, viewIndex = #boxes > 0 and top or nil, manual = (S and S.rbView) and true or false, view = view,
    roadbookFile = S and S.stage.roadbook.source and S.stage.roadbook.source.path or nil,
    recce = recce.state() }
end

local function snapshot()
  local out = { v = M.VERSION, ok = nav.ok, why = nav.why, units = M.settings.units, tripStep = M.settings.tripStep,
    cap = nav.cap, speed = nav.speed * 3.6, fwd = nav.fwd,
    trip = odo.trip / 1000, partial = odo.partial / 1000, total = odo.total / 1000, countDown = odo.countDown }
  if not S then out.phase = 'idle' return out end
  local wps = S.stage.waypoints
  out.phase, out.stage, out.stageId = S.phase, S.stage.name, S.stage.id
  out.paused = (resume.clockPaused() or gameResume.clockPaused()) or nil   -- a recovery / resume running: the clock is stopped
  out.held = gameResume.holding() or nil             -- resumed after a game crash: held until the car moves
  out.clock, out.countdown, out.startMode = S.clock, S.countdown, S.rules.startMode
  out.penalty, out.impulses = S.penaltyTotal, S.impulses
  out.count = #wps
  local okN, missN = 0, 0
  for i = 1, #wps do if S.state[i] == 'ok' then okN = okN + 1 elseif S.state[i] == 'missed' then missN = missN + 1 end end
  out.validated, out.missed = okN, missN
  if S.penalties[#S.penalties] then out.lastPenalty = S.penalties[#S.penalties].detail end
  local i = S.target
  if S.phase == 'armed' or S.phase == 'countdown' then i = 1 end
  local w = wps[i]
  if w and nav.lat and S.phase ~= 'finished' then
    local d = geo.dist(nav.lat, nav.lon, w.lat, w.lon)
    local o = { index = i, n = w.n, type = w.type, name = w.name, revealed = revealed(i, d), validate = S.wr[i].validate }
    if o.revealed then
      o.dtw = d
      o.ctw = geo.bearing(nav.lat, nav.lon, w.lat, w.lon)
      if nav.cap then o.rel = geo.angleDiff(o.ctw, nav.cap) end
      o.inside = d <= S.wr[i].validate
    end
    if w.type == 'DZ' then
      o.speedLimit = w.speedLimit
      o.zoneAhead = d <= (tonumber(S.rules.speedZone.warnBefore) or 90) + S.wr[i].validate
    end
    out.wp = o
    if S.phase == 'armed' then out.atStart = d <= S.wr[1].validate end
  end
  if S.zone then
    out.zone = { limit = S.zone.limit, live = S.zone.live, tolerance = S.zone.tolerance, impulses = S.zone.impulses,
      alert = (nav.speed * 3.6) >= S.zone.limit - (tonumber(S.rules.speedZone.alertMargin) or 5),
      over = (nav.speed * 3.6) - S.zone.limit >= 1 }
  end
  if S.phase == 'finished' and S.result then
    out.result = { stageTime = S.result.stageTime, penaltyTime = S.result.penaltyTime, totalTime = S.result.totalTime,
      file = S.resultPath, missed = missN, retired = S.result.retired }
  end
  return out
end

function M.vehicleName()
  local gpv = rawget(_G, 'getPlayerVehicle')
  local v = gpv and gpv(0)
  if not v then return nil end
  local ok, name = pcall(function() return v:getJBeamFilename() end)
  return ok and name or nil
end

function M.results()
  if not S then return nil end
  local wps, wlog = S.stage.waypoints, {}
  for i, w in ipairs(wps) do
    wlog[i] = { n = w.n, type = w.type, status = S.state[i], time = S.times[i], km = w.km,
      trip = S.tripAt[i] and S.tripAt[i] / 1000 or nil }
  end
  local res = { format = 'rallyraid-result', schemaVersion = 1, stageId = S.stage.id, stageName = S.stage.name,
    stagePath = S.stage.path, rules = S.rules.preset, startedAt = S.startedAt, finishedAt = os.date('!%Y-%m-%dT%H:%M:%SZ'),
    stageTime = S.clock, penaltyTime = S.penaltyTotal, totalTime = S.clock + S.penaltyTotal,
    penalties = S.penalties, waypoints = wlog, speedImpulses = S.impulses, distanceDriven = (odo.total - (S.totalAtStart or 0)) / 1000,
    flags = S.flags, vehicle = M.vehicleName(), retired = S.flags.retired,
    official = not (S.flags.teleported or S.flags.positionJump or S.flags.ipr or S.flags.rallyRetired),
    reviewRequired = (S.flags.reviewRequired or S.flags.restartedAfterGameCrash) and true or nil,
    officialRun = S.official, modVersion = M.VERSION }
  for k, v in pairs(repair.resultFields(S)) do res[k] = v end   -- repairs, resets / resumes, bivouac, rally
  res.carRecovery = resume.resultFields(S)                      -- car recovery attempts, recovery states, rules
  res.gameCrashResume = gameResume.resultFields(S)              -- resumes after a game crash: flagged for review
  if res.gameCrashResume.flagged then res.reviewRequired = true end
  return res
end

------------------------------------------------------------------------------------------------------------------
-- game-crash resume (rallyRaid/gameResume.lua): the running stage as plain data for the save file, and back
local function cp(t) if type(t) ~= 'table' then return t end local c = {} for k, v in pairs(t) do c[k] = cp(v) end return c end
function M.captureStage()
  if not S then return nil end
  local wps = {}
  for i = 1, #S.stage.waypoints do wps[i] = { s = S.state[i], t = S.times[i], trip = S.tripAt[i] } end
  return { phase = S.phase, clock = S.clock, target = S.target, wps = wps, penalties = cp(S.penalties), penaltyTotal = S.penaltyTotal,
    impulses = S.impulses, globalImpulses = S.globalImpulses, zone = cp(S.zone), flags = cp(S.flags), startedAt = S.startedAt,
    totalAtStart = S.totalAtStart, trace = traceMod.export(S.trace), repair = cp(S.repair), carRecoveryLog = cp(S.carRecoveryLog), gameResumeLog = cp(S.gameResumeLog),
    odo = { trip = odo.trip, partial = odo.partial, total = odo.total, countDown = odo.countDown } }
end
-- put a saved stage state back on the loaded stage (same waypoints): it runs on from there
function M.restoreStage(d)
  if not (S and type(d) == 'table' and type(d.wps) == 'table' and #d.wps == #S.stage.waypoints) then return false end
  local function arr(x) if type(x) ~= 'table' then return {} end local o = {} for _, v in ipairs(x) do o[#o + 1] = v end
    if #o == 0 then for _, v in pairs(x) do o[#o + 1] = v end end return o end
  S.phase, S.countdown, S.atStart = 'running', nil, false
  S.clock = tonumber(d.clock) or 0
  S.target = tonumber(d.target) or 2
  for i = 1, #S.stage.waypoints do
    local w = d.wps[i] or {}
    S.state[i] = w.s or 'pending'
    S.times[i] = tonumber(w.t)
    S.tripAt[i] = tonumber(w.trip)
  end
  S.penalties = arr(d.penalties)
  S.penaltyTotal = 0
  for _, p in ipairs(S.penalties) do S.penaltyTotal = S.penaltyTotal + (tonumber(p.seconds) or 0) end
  S.impulses, S.globalImpulses = tonumber(d.impulses) or 0, tonumber(d.globalImpulses) or 0
  S.zone = type(d.zone) == 'table' and next(d.zone) ~= nil and cp(d.zone) or nil
  S.gAcc = nil
  S.flags = type(d.flags) == 'table' and cp(d.flags) or {}
  S.startedAt, S.totalAtStart = d.startedAt, tonumber(d.totalAtStart)
  local rp = type(d.repair) == 'table' and cp(d.repair) or {}
  S.repair = { spares = tonumber(rp.spares) or 0, timeS = tonumber(rp.timeS) or 0, log = arr(rp.log), resets = arr(rp.resets),
    resumes = tonumber(rp.resumes) or 0, resumesLog = arr(rp.resumesLog), bivouac = rp.bivouac }
  S.carRecoveryLog, S.gameResumeLog = arr(d.carRecoveryLog), arr(d.gameResumeLog)
  local o = type(d.odo) == 'table' and d.odo or {}
  odo.trip, odo.partial, odo.total = tonumber(o.trip) or 0, tonumber(o.partial) or 0, tonumber(o.total) or 0
  odo.countDown = o.countDown == true
  if S.totalAtStart == nil then S.totalAtStart = odo.total end
  S.trace = traceMod.import(d.trace) or traceMod.new(os.time())   -- the trace up to the save (the lost part is a gap)
  S.rbView, S.result, S.resultPath = nil, nil, nil
  lastFix = nil
  hook('onRallyRaidStageResumed', { id = S.stage.id, clock = S.clock, target = S.target })
  M.requestState()
  return true
end

function M.requestState()
  ui('RallyRaidUpdate', snapshot())
  ui('RallyRaidRoadbook', M.roadbookState())
  M.pushKeys()
end
-- the player's key on each action ({ action = 'Ctrl+Shift+End' }, unbound actions left out) for the apps' hints
function M.pushKeys(force) ui('RallyRaidKeys', { keys = keys.all(force), source = keys.source }) end
function M.onInputBindingsChanged() keys.invalidate(); M.pushKeys(true) end   -- the player changed a binding
function M.getState() return snapshot() end

------------------------------------------------------------------------------------------------------------------
-- commands (HUD buttons, key bindings, the roadbook)
local function tripChanged(reason)
  if S then S.rbView = nil end                     -- an odometer adjust re-syncs the roadbook display to the trip
  hook('onRallyRaidTripChanged', { trip = odo.trip / 1000, reason = reason })
  M.requestState()
end

------------------------------------------------------------------------------------------------------------------
-- recce mode (rallyRaid/recce.lua): commands 'recce' (on / off), 'recceNew' (on, forgetting an earlier recce of
-- this stage), 'recceDrop' (box here + quick-pick), 'reccePick' {symbol | danger | notes}, 'recceSave', 'recceCancel',
-- 'recceConfirm' / 'recceMove' / 'recceRetag' / 'recceDelete' (the nearest box, or arg = box id), 'recceUndo',
-- 'recceMerge' (arg 'rescale': also re-measure the km from the driven line)
local function reloadBoxes()
  if not S then return nil end
  local boxes = stagesMod.loadRoadbook(S.stage)
  if boxes then return boxes end
  local out = {}
  for i, b in ipairs(S.stage.roadbook.stageBoxes or {}) do local c = {}; for k, v in pairs(b) do c[k] = v end; out[i] = c end
  return out
end
function M.recceCmd(sub, arg)
  local said
  if sub == '' or sub == 'New' then
    if recce.active() and sub == '' then
      local d = recce.stop()
      said = string.format('rally.raid Earth: recce off. %d changes, %.1f km driven, saved to %s', #(d.changes or {}), d.driven.km or 0, recce.path(d.stage.id))
    elseif not S then said = 'rally.raid Earth: load a stage first, then start the recce.'
    else
      if recce.active() then recce.stop() end
      if sub == 'New' then S.stage.roadbook.boxes = reloadBoxes() or S.stage.roadbook.boxes end
      recce.start({ stage = S.stage, boxes = S.stage.roadbook.boxes, rbInfo = S.stage.roadbook.source }, sub == 'New')
      if S.phase == 'running' then S.flags.recce = true end
      local d = recce.get().doc
      said = 'rally.raid Earth: RECCE ON. ' .. (#d.changes > 0 and (#d.changes .. ' earlier changes kept. ') or '') ..
        'Roadbook app recce panel: + BOX HERE' .. keys.hint('rallyRaid_recceDrop') .. ' drops a box here; check / HERE / TAG / delete act on the nearest box.'
    end
  elseif not recce.active() then said = 'rally.raid Earth: recce is off (RECCE in the Roadbook app' .. keys.hint('rallyRaid_recce', ', or %s') .. ').'
  elseif sub == 'Drop' then if recce.get().pending then recce.commitPending() else recce.drop() end
  elseif sub == 'Pick' then recce.pick(arg)
  elseif sub == 'Save' then recce.commitPending()
  elseif sub == 'Cancel' then recce.cancelPending()
  elseif sub == 'Retag' then if not recce.retag(arg) then said = 'rally.raid Earth: no roadbook box within ' .. recce.NEAR_M .. ' m.' end
  elseif sub == 'Confirm' or sub == 'Move' or sub == 'Delete' then
    local c = recce.boxOp(sub:lower(), arg)
    if not c then said = 'rally.raid Earth: no roadbook box within ' .. recce.NEAR_M .. ' m.' end
  elseif sub == 'Undo' then
    local c = recce.undo(reloadBoxes)
    said = c and ('rally.raid Earth: undone (' .. c.op .. ').') or 'rally.raid Earth: nothing to undo.'
  elseif sub == 'Merge' then
    local res, why = recce.merge(S and S.stage.roadbook.source and S.stage.roadbook.source.path, { rescale = arg == 'rescale' or arg == true })
    if res then
      local boxes, info = stagesMod.loadRoadbook(S.stage)
      if boxes then S.stage.roadbook.boxes, S.stage.roadbook.source = boxes, info; stagesMod.applyRoadbookKm(S.stage, boxes); recce.get().ctx.boxes = boxes; recce.get().ctx.rbInfo = info end
      said = string.format('rally.raid Earth: recce merged into the roadbook (rev %s): %d applied, %d conflicts%s.', tostring(res.revision), res.applied, #res.conflicts,
        res.rescaled > 0 and (', km re-measured on ' .. res.rescaled .. ' boxes') or '')
    else said = 'rally.raid Earth: recce not merged: ' .. tostring(why) end
  end
  if said then notify(said, 6) end
  M.requestState()
end

function M.cmd(name, arg)
  local step = tonumber(arg) or tonumber(M.settings.tripStep) or 10
  if name == 'tripPlus' then odo.trip = odo.trip + step; tripChanged('plus')
  elseif name == 'tripMinus' then odo.trip = odo.trip - step; tripChanged('minus')
  elseif name == 'tripReset' then odo.trip = 0; tripChanged('reset')
  elseif name == 'tripSet' then odo.trip = (tonumber(arg) or 0) * 1000; tripChanged('set')
  elseif name == 'partialReset' then odo.partial = 0; tripChanged('partial')
  elseif name == 'countDown' then odo.countDown = not odo.countDown; tripChanged('direction')
  elseif name == 'tripStep' then M.settings.tripStep = tonumber(arg) or 10; saveSettings(); M.requestState()
  elseif name == 'syncBox' then                                -- the roadbook says "I'm at box n": trip := box km
    for _, b in ipairs(S and S.stage.roadbook.boxes or {}) do
      if tostring(b.n) == tostring(arg) and tonumber(b.km) then odo.trip = tonumber(b.km) * 1000; tripChanged('box') break end
    end
  elseif name == 'boxNext' or name == 'boxPrev' then        -- scroll the roadbook display (does not touch the trip)
    local boxes = S and S.stage.roadbook.boxes or {}
    if #boxes > 0 then
      local cur = S.rbView or boxAt(odo.trip / 1000) or 1
      S.rbView = math.max(1, math.min(#boxes, cur + (name == 'boxNext' and 1 or -1)))
      S.rbAt = boxAt(odo.trip / 1000)
      if S.rbView == S.rbAt then S.rbView = nil end
    end
    M.requestState()
  elseif name == 'boxSync' then                               -- "I'm at the box on screen": trip := that box's km
    local boxes = S and S.stage.roadbook.boxes or {}
    local b = boxes[(S and S.rbView) or boxAt(odo.trip / 1000) or 1]
    if b and tonumber(b.km) then odo.trip = tonumber(b.km) * 1000; tripChanged('box') else M.requestState() end
  elseif name == 'reloadRoadbook' and official.refuse('the roadbook is locked') then M.requestState()
  elseif name:sub(1, 5) == 'recce' and official.refuse('no recce') then M.requestState()
  elseif name:sub(1, 7) == 'planner' and official.refuse('no planner: the route stays hidden') then M.requestState()
  elseif name:sub(1, 8) == 'official' then official.cmd(name:sub(9), arg)
  elseif name == 'reloadRoadbook' then
    -- re-read the roadbook file (edited while playing) without touching the running stage
    if S then
      local rbBoxes, rbInfo = stagesMod.loadRoadbook(S.stage)
      if rbBoxes then S.stage.roadbook.boxes, S.stage.roadbook.source = rbBoxes, rbInfo; stagesMod.applyRoadbookKm(S.stage, rbBoxes); notify('rally.raid Earth: roadbook reloaded, ' .. #rbBoxes .. ' boxes.', 4)
      else notify('rally.raid Earth: no roadbook file found for this stage.', 5) end
      S.rbView = nil
    end
    M.requestState()
  elseif name == 'wPlus' then
    if S and S.phase == 'running' and S.target < #S.stage.waypoints then markMissed(S.target); S.target = S.target + 1 end
    M.requestState()
  elseif name == 'wMinus' then                                -- go back to a missed waypoint (its penalty is lifted)
    if S and S.phase == 'running' and S.target > 2 and S.state[S.target - 1] == 'missed' then
      S.target = S.target - 1; S.state[S.target] = 'pending'; removePenalty('missedWaypoint', S.target)
    end
    M.requestState()
  elseif name == 'start' then
    if S and S.phase == 'armed' then
      if S.atStart then S.phase = 'countdown'; S.countdown = tonumber(S.rules.countdown) or 5
      else notify('rally.raid Earth: drive into the DSS circle first.', 3) end
    end
    M.requestState()
  elseif name == 'abort' then
    if S then gameResume.abandon('aborted'); S.phase = 'armed'; local st = S.stage; M.loadStageTable(st) end
  elseif name == 'unload' then M.unloadStage()
  elseif name == 'teleport' then M.teleportToStart()
  elseif name == 'load' then M.loadStage(arg)
  elseif name:sub(1, 5) == 'recce' then M.recceCmd(name:sub(6), arg)
  elseif name:sub(1, 6) == 'repair' then
    repair.cmd(name:sub(7), arg)
    if name == 'repairAppHere' then resume.push(); gameResume.push() end   -- the app just opened: everything it shows
  elseif name:sub(1, 7) == 'recover' then resume.cmd(name:sub(8), arg)   -- RECOVER CAR (GPS / Repair app button)
  elseif name:sub(1, 10) == 'gameResume' then gameResume.cmd(name:sub(11), arg)   -- after a game crash (RESUME in the GPS / Repair app)
  elseif name:sub(1, 6) == 'resume' then resume.cmd(name:sub(7), arg)   -- (older name of the recover commands)
  elseif name:sub(1, 7) == 'planner' then planner.cmd(name:sub(8), arg)
  elseif name == 'rallyNew' then repair.newRally()
  elseif name == 'keys' then M.pushKeys(true)
  elseif name == 'liveFile' then M.settings.liveFile = not M.settings.liveFile; saveSettings(); M.requestState()
  else log_('W', 'unknown command ' .. tostring(name)) end
end

-- held trip buttons / keys repeat (as a real rally computer's remote)
function M.tripHold(dir) hold.dir, hold.t, hold.rep = dir or 0, 0, 0; if dir and dir ~= 0 then M.cmd(dir > 0 and 'tripPlus' or 'tripMinus') end end

------------------------------------------------------------------------------------------------------------------
-- game hooks
function M.onUpdate(dtReal, dtSim)
  dtReal, dtSim = dtReal or 0, dtSim or dtReal or 0
  if hold.dir ~= 0 then
    hold.t = hold.t + dtReal
    if hold.t > 0.4 then hold.rep = hold.rep + dtReal; while hold.rep >= 0.08 do hold.rep = hold.rep - 0.08; M.cmd(hold.dir > 0 and 'tripPlus' or 'tripMinus') end end
  end
  -- the stage clock stops while a car recovery runs (its penalty is added as time instead), while a game-crash resume
  -- puts the car back, and after it until the car moves
  if S and S.phase == 'running' and not resume.clockPaused() and not gameResume.clockPaused() then S.clock = S.clock + dtSim end
  repair.update(dtReal)
  official.update(dtReal)
  resume.update(dtReal, dtSim)
  gameResume.update(dtReal)
  planner.update(dtReal)
  if recce.active() and dtSim > 0 then
    local a0 = api()
    if not (a0 and a0.rebasing and a0.rebasing()) then recce.frame(dtSim, recce.sampler and recce.sampler()) end
  end
  if S and S.phase == 'countdown' and S.countdown then
    S.countdown = S.countdown - dtSim
    if S.countdown <= 0 then startClock('countdown') end
  end
  tickAcc = tickAcc + dtReal
  if tickAcc < TICK then return end
  local dt = tickAcc
  tickAcc = 0
  local a = api()
  if not a then nav.ok, nav.why = false, 'BeamNG.Earth not found'; M.requestState() return end
  if not a.ready() then nav.ok, nav.why = false, 'waiting for the world'; lastFix = nil; M.requestState() return end
  if a.rebasing and a.rebasing() then return end      -- between a rebase's two frames: leave positions alone
  local p = a.pose()
  if not p or p.camera or not p.lat then nav.ok, nav.why = false, 'no vehicle'; lastFix = nil; M.requestState() return end
  nav.ok, nav.why = true, nil
  planner.tick(p)
  local holdNav = resume.holdNav() or gameResume.holdNav()
  if holdNav then lastFix = nil end                -- the car is being moved back: no trip, no jump flag
  local moved = computerTick(p, dt)
  if not holdNav then stageTick(moved, dt) end
  if S and S.phase == 'running' and not holdNav then tracePoint(false) end
  if recce.active() then recce.tick({ lat = p.lat, lon = p.lon, trip = odo.trip / 1000, speed = p.speed }, dt) end
  local snap = snapshot()
  ui('RallyRaidUpdate', snap)
  local rb = M.roadbookState()
  ui('RallyRaidRoadbook', rb)
  hook('onRallyRaidTick', rb)
  if M.settings.liveFile then
    liveAcc = liveAcc + dt
    if liveAcc >= 0.5 then
      liveAcc = 0
      local write = rawget(_G, 'jsonWriteFile')
      if write then pcall(write, LIVE_FILE, rb, false) end
    end
  end
end

function M.onBeamNGEarthTeleported(info)
  lastFix = nil
  planner.teleported()
  if resume.busy() then resume.teleported() return end   -- the car recovery's own teleport (far from the car)
  if gameResume.busy() then gameResume.teleported() return end   -- the game-crash resume's own teleport
  if S and S.phase == 'running' then S.flags.teleported = true; notify('rally.raid Earth: teleported during the stage: result marked unofficial.', 6) end
end
function M.onBeamNGEarthRebased() lastFix = lastFix end  -- nothing to fix: everything is kept in lat / lon
-- any reset: ours (a repair), or one the app did not make (counted as a crash resume in a running stage)
function M.onVehicleResetted(vehId)
  lastFix = nil
  local r = resume.onVehicleResetted(vehId)            -- the car recovery setting the car down: ours
  if r then return r end
  r = gameResume.onVehicleResetted(vehId)              -- the game-crash resume setting the car down: ours
  if r then return r end
  return repair.onVehicleResetted(vehId)
end
function M.repairReply(d)
  if type(d) == 'table' and type(d.kind) == 'string' and d.kind:sub(1, 6) == 'resume' then resume.reply(d)
  elseif type(d) == 'table' and type(d.kind) == 'string' and d.kind:sub(1, 4) == 'game' then gameResume.reply(d)
  else repair.reply(d) end
end
function M.resumeState() return resume.state() end
function M.gameResumeState() return gameResume.state() end
-- the game is closing / the level is left mid-stage: one last game-crash save
function M.onExit() gameResume.onExit('quit') end
function M.onClientEndMission() gameResume.onExit('level left') end
function M.repairState() return repair.state() end
function M.recceVeh(wheel, throttle) recce.vehData(wheel, throttle) end
-- the in-game planner app (rallyRaid/planner.lua): plannerCall(name, argsJson, text)
function M.plannerCall(name, argsJson, text)
  if official.active() and name ~= 'state' then return { error = 'official run: the planner is off (no route on the map)' } end
  return planner.call(name, argsJson, text)
end
function M.officialState() return official.state() end
function M.loadOfficial(path) return official.load(path) end
function M.onExtensionLoaded() loadSettings(); log_('I', 'rally.raid Earth ' .. M.VERSION .. ' loaded') end

-- for tests
function M._debug() return S, odo, nav end
function M._reset() keys.invalidate(); recce._reset(); repair._reset(); resume._reset(); gameResume._reset(); planner._reset(); official._reset(); S = nil; odo = { trip = 0, partial = 0, total = 0, countDown = false }; lastFix = nil; tickAcc = 0 end

repair.init({ S = function() return S end, nav = function() return nav end, addPenalty = addPenalty, notify = notify,
  ui = ui, hook = hook, log = log_, retireStage = function(reason) retireStage(reason) end,
  km = function() return odo.trip / 1000 end, resumeBusy = function() return resume.busy() or gameResume.busy() end })
resume.init({ S = function() return S end, nav = function() return nav end, api = api, addPenalty = addPenalty,
  notify = notify, ui = ui, hook = hook, log = log_, retireStage = function(reason) retireStage(reason) end,
  tripKm = function() return odo.trip / 1000 end,
  setTripKm = function(km) if tonumber(km) then odo.trip = tonumber(km) * 1000; tripChanged('resume') end end,
  repair = repair, otherBusy = function() return gameResume.busy() end })
gameResume.init({ S = function() return S end, nav = function() return nav end, api = api, addPenalty = addPenalty,
  notify = notify, ui = ui, hook = hook, log = log_, retireStage = function(reason) retireStage(reason) end,
  captureStage = function() return M.captureStage() end, restoreStage = function(d) return M.restoreStage(d) end,
  rallyId = function() return repair.ledger().id end, repair = repair, recovery = resume, modVersion = M.VERSION })
planner.init({ api = api, ui = ui, notify = notify, log = log_, listStages = function() return stagesMod.list() end,
  loadStage = function(path) return M.loadStage(path) end, teleport = function() return M.teleportToStart() end,
  reloadRoadbook = function() M.cmd('reloadRoadbook') end,
  stageInfo = function() if not S then return {} end return { id = S.stage.id, name = S.stage.name, phase = S.phase, path = S.stage.path } end })

official.init({ log = log_, notify = notify, ui = ui, modVersion = M.VERSION,
  loadStageTable = function(stage) return M.loadStageTable(stage) end })

return M
