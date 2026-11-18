-- rally.raid Earth: GAME-CRASH RESUME (B11 rework). Required by core.lua. For the GAME crashing or being
-- force-quit mid-stage (a CTD, a BeamNG error), not the car crashing (that is RECOVER CAR, rallyRaid/resume.lua).
-- Every tunable is in rallyRaid/repairConfig.lua M.gameCrashResume. Players' guide: docs/REPAIR.md "Game crash".
--
--   * during a running stage the stage state is written to disk every 30 s of stage clock and at once after anything
--     that changes the result (CP / WP passed or missed, a penalty, a repair, a car recovery, the start):
--     <user folder>/settings/rallyraid/resume/<rallyId>_<stageId>.json. Atomic: a temp file is written, read back
--     and checked, then renamed over the save; the 2 older saves are kept (.1.json, .2.json) so a corrupt or
--     half-written file falls back to the one before. A tiny heartbeat file (every 5 s) tells how far the stage got
--     after the last save.
--   * what is saved: the car's place (lat / lon, alt, heading: never game x / y, BeamNG.Earth rebases), its model and
--     part config, its damage (vehRepair.gameCapture: damaged / broken beams, their nodes in the car's frame, flat
--     tyres, fuel, engine flags, damage per group), the stage clock, every waypoint's status / time / trip, penalties,
--     speed-zone state, flags, repairs and spares used, car recoveries and resets (counts and log), game-crash resumes
--     so far, the bivouac that closed at the start, and the odometers
--   * after a relaunch, loading that stage offers "Resume from last save (h:mm:ss elapsed, saved X ago)" or "Discard"
--     (RESUME in the GPS app, or a bound key twice). Resume: the saved car model is spawned if another one is out, the car is set
--     down where it was (BeamNG.Earth's teleport first if that part of the world is not loaded), its damage is put back,
--     the stage state is restored and the clock is held at the saved time until the car moves (or GO)
--   * policy (Wyans 2026-11-16): no time penalty, no limits, but every resume is flagged for organizer review in the
--     stage result and the rally ledger: real time of the resume, the gap (wall clock since the save, stage time lost
--     estimated from the heartbeat), and the saved vs resumed state. The original rules are one switch away
--     (useOfficialRules)
--   * the save is cleared when the stage finishes (or is retired), is aborted / unloaded / replaced, or is discarded
local cfgAll = require('rallyRaid/repairConfig')
local keys = require('rallyRaid/keys')
local geo = require('rallyRaid/geo')

local M = {}
M.cfg = cfgAll
M.FORMAT = 'rallyraid-gamesave'
M.SCHEMA = 1

local H = {}   -- hooks from core: S(), nav(), api(), notify(text, s), ui(name, data), hook(name, info), log(level, msg),
               -- addPenalty(kind, s, detail), retireStage(reason), captureStage(), restoreStage(saved), rallyId(),
               -- repair (module), recovery (module: rallyRaid/resume.lua), modVersion
local R

local function fresh()
  return { t = 0, offer = nil, busy = nil, hold = nil, msg = nil, msgAt = nil, nextSaveClock = nil, beatAcc = 0, sig = nil,
    req = 0, pendingSave = nil, lastCar = nil, savesWritten = 0, saveFails = 0, seq = 0, lastSaveAt = nil, lastSaveClock = nil,
    lastSaveEpoch = nil, askDiscard = false, keyT = nil, lastFlag = nil, base = nil }
end
R = fresh()

local function C()
  local c = cfgAll.gameCrashResume
  if not c.useOfficialRules then return c end
  local o = {}
  for k, v in pairs(c) do o[k] = v end
  for k, v in pairs(cfgAll.gameCrashResumeOfficial or {}) do o[k] = v end
  return o
end
M.rules = C
local function S() return H.S and H.S() end
local function nav() return (H.nav and H.nav()) or {} end
local function api() return H.api and H.api() end
local function notify(t, s) if H.notify then H.notify(t, s) end end
local function log_(l, m) if H.log then H.log(l, m) end end
local function round(x, n) if not tonumber(x) then return nil end local k = 10 ^ (n or 0); return math.floor(x * k + 0.5) / k end
local function copy(t) if type(t) ~= 'table' then return t end local c = {} for k, v in pairs(t) do c[k] = copy(v) end return c end
local function isoUtc(epoch) return os.date('!%Y-%m-%dT%H:%M:%SZ', epoch) end
local function hms(s) s = math.max(0, math.floor((s or 0) + 0.5)); return string.format('%d:%02d:%02d', math.floor(s / 3600), math.floor(s / 60) % 60, s % 60) end
local function ago(s)
  s = math.max(0, math.floor(s or 0))
  if s < 90 then return s .. ' s' end
  if s < 5400 then return math.floor(s / 60 + 0.5) .. ' min' end
  if s < 172800 then return string.format('%.1f h', s / 3600) end
  return math.floor(s / 86400) .. ' days'
end
M.hms, M.ago = hms, ago

------------------------------------------------------------------------------------------------------------------
-- files (replaced in tests). BeamNG: writeFile / readFile / FS:renameFile / FS:removeFile / FS:fileExists /
-- jsonEncode / jsonDecode, all on the game's virtual file system (the user folder)
local function fs() return rawget(_G, 'FS') end
-- io.open (BeamNG maps it onto the same virtual file system) when writeFile / readFile are missing or fail
local function ioWrite(path, text)
  if not (io and io.open) then return false end
  local ok, f = pcall(io.open, path, 'wb')
  if not ok or not f then return false end
  local okW = pcall(function() f:write(text) end)
  pcall(function() f:close() end)
  return okW
end
local function ioRead(path)
  if not (io and io.open) then return nil end
  local ok, f = pcall(io.open, path, 'rb')
  if not ok or not f then return nil end
  local okR, t = pcall(function() return f:read('*a') end)
  pcall(function() f:close() end)
  if okR and type(t) == 'string' then return t end
end
M.io = {
  write = function(path, text)
    local w = rawget(_G, 'writeFile')
    if w and pcall(w, path, text) then return true end   -- (writeFile's return value differs between versions: the caller reads it back)
    return ioWrite(path, text)
  end,
  read = function(path)
    local r = rawget(_G, 'readFile')
    if r then
      local ok, t = pcall(r, path)
      if ok and type(t) == 'string' then return t end
    end
    return ioRead(path)
  end,
  exists = function(path)
    local f = fs()
    if f and f.fileExists then local ok, r = pcall(f.fileExists, f, path); return ok and r and true or false end
    return M.io.read(path) ~= nil
  end,
  rename = function(a, b)
    local f = fs()
    if not (f and f.renameFile) then return false end
    pcall(f.renameFile, f, a, b)
    return M.io.exists(b)
  end,
  remove = function(path) local f = fs(); if f and f.removeFile then pcall(f.removeFile, f, path) end end,
  mkdir = function(dir)
    local f = fs()
    if f and f.directoryExists then local ok, r = pcall(f.directoryExists, f, dir); if ok and r then return true end end
    if f and f.directoryCreate then local ok = pcall(f.directoryCreate, f, dir, true); if not ok then pcall(f.directoryCreate, f, dir) end end
    return true
  end,
  list = function(dir)                 -- the .json files in dir (FS:findFiles, as stages.lua lists the stages)
    local f = fs()
    if not (f and f.findFiles) then return {} end
    local ok, files = pcall(function() return f:findFiles(dir, '*.json', 0, false, false) end)
    return ok and type(files) == 'table' and files or {}
  end,
  encode = function(t) local e = rawget(_G, 'jsonEncode'); if not e then return nil end local ok, s = pcall(e, t); return ok and s or nil end,
  decode = function(s) local d = rawget(_G, 'jsonDecode'); if not d then return nil end local ok, r = pcall(d, s); if ok then return r end end,
  time = function() return os.time() end,
}

-- a table JSON can carry both ways: arrays stay arrays only when dense; other number keys become strings; no functions
local function jsonSafe(v, depth)
  depth = depth or 0
  if type(v) == 'number' then if v ~= v or v == math.huge or v == -math.huge then return nil end return v end
  if type(v) == 'string' or type(v) == 'boolean' then return v end
  if type(v) ~= 'table' or depth > 30 then return nil end
  local n, maxK, other = 0, 0, false
  for k in pairs(v) do
    n = n + 1
    if type(k) == 'number' and k >= 1 and k == math.floor(k) then if k > maxK then maxK = k end else other = true end
  end
  local out = {}
  if not other and maxK == n then
    for i = 1, n do out[i] = jsonSafe(v[i], depth + 1) end
    -- a hole (nil inside) would break the array: keep it as a map then
    for i = 1, n do if out[i] == nil then local m = {} for k, x in pairs(v) do m[tostring(k)] = jsonSafe(x, depth + 1) end return m end end
    return out
  end
  for k, x in pairs(v) do
    if type(k) == 'string' or type(k) == 'number' then out[tostring(k)] = jsonSafe(x, depth + 1) end
  end
  return out
end
M.jsonSafe = jsonSafe

local function safeName(x) return (tostring(x or 'none'):gsub('[^%w%-_]', '_')) end
function M.basePath(rallyId, stageId) return C().dir .. safeName(rallyId) .. '_' .. safeName(stageId) end
-- the save files, newest first: <base>.json, <base>.1.json, <base>.2.json
function M.paths(base)
  local out = { base .. '.json' }
  for i = 1, math.max(1, (C().keepSaves or 3)) - 1 do out[#out + 1] = base .. '.' .. i .. '.json' end
  return out
end
local function beatPath(base) return base .. '.beat.json' end

-- a rename, or (a file system without one) a copy that is read back, then the old name removed
local function move(a, b)
  if M.io.rename(a, b) then return true end
  local text = M.io.read(a)
  if not text then return false end
  if not (M.io.write(b, text) and M.io.read(b) == text) then return false end
  M.io.remove(a)
  return true
end

-- write doc as the newest save: temp file, read back and check, rotate the older ones, rename the temp over the save
function M.writeAtomic(base, doc)
  local text = M.io.encode(doc)
  if not text then return false, 'no JSON encoder' end
  local tmp = base .. '.json.tmp'
  M.io.mkdir(C().dir)
  if not M.io.write(tmp, text) then return false, 'the temp file could not be written' end
  local back = M.io.read(tmp)
  if back ~= text then
    local d = back and M.io.decode(back)
    if not (type(d) == 'table' and d.format == doc.format and d.seq == doc.seq) then
      M.io.remove(tmp)
      return false, 'the temp file did not read back'
    end
  end
  local names = M.paths(base)
  M.io.remove(names[#names])
  for i = #names - 1, 1, -1 do if M.io.exists(names[i]) then move(names[i], names[i + 1]) end end
  if not move(tmp, names[1]) then return false, 'the save could not be renamed or written' end
  return true
end

-- is this a save of this rally's stage we can resume? (nil = yes, else why not)
function M.invalid(d, rallyId, stage)
  if type(d) ~= 'table' then return 'not JSON (corrupt or half-written)' end
  if d.format ~= M.FORMAT then return 'not a save file' end
  if tonumber(d.schemaVersion) ~= M.SCHEMA then return 'save format ' .. tostring(d.schemaVersion) end
  if rallyId and tostring(d.rallyId) ~= tostring(rallyId) then return 'another rally' end
  if stage and tostring(d.stageId) ~= tostring(stage.id) then return 'another stage' end
  local st = d.stage
  if type(st) ~= 'table' or not tonumber(st.clock) or type(st.wps) ~= 'table' then return 'no stage state' end
  if stage and (tonumber(d.wpCount) ~= #stage.waypoints or #st.wps ~= #stage.waypoints) then return 'the stage file has changed (waypoints)' end
  if type(d.pos) ~= 'table' or not tonumber(d.pos.lat) or not tonumber(d.pos.lon) then return 'no position' end
  return nil
end

-- the newest good save: { doc, used = 1 (newest) | 2 | 3, file, skipped = { { file, why } }, base, otherRally }
local function tryBase(base, rallyId, stage, skipped)
  for i, f in ipairs(M.paths(base)) do
    local text = M.io.read(f)
    if text then
      local d = M.io.decode(text)
      local why = M.invalid(d, rallyId, stage)
      if not why then return { doc = d, used = i, file = f, skipped = skipped, base = base } end
      skipped[#skipped + 1] = { file = f, why = why }
      log_('W', 'game-crash save ' .. f .. ' not used: ' .. why)
    end
  end
end
-- the save files on disk (the newest file of each rally + stage): { base, file, rallyId, stageId }
function M.saveBases()
  local out = {}
  for _, p in ipairs(M.io.list and M.io.list(C().dir) or {}) do
    local name = tostring(p):match('([^/\\]+)$') or ''
    local r, st = name:match('^([^_.]+)_([^.]+)%.json$')            -- <rallyId>_<stageId>.json (not .1.json / .beat.json)
    if r then out[#out + 1] = { base = C().dir .. name:sub(1, -6), file = C().dir .. name, rallyId = r, stageId = st } end
  end
  return out
end
function M.loadSave(rallyId, stage)
  local base = M.basePath(rallyId, stage.id)
  local skipped = {}
  log_('I', 'crash save: looking for ' .. base .. '.json (stage ' .. tostring(stage.id) .. ', rally ' .. tostring(rallyId) .. ')')
  local found = tryBase(base, rallyId, stage, skipped)
  if found then return found end
  -- not under this rally's id (the rally ledger was not kept, or the rally was restarted since): the newest save of the
  -- same stage under any rally id. The stage is matched by its id and its waypoints (M.invalid).
  local best
  for _, b in ipairs(M.saveBases()) do
    if b.base ~= base and b.stageId == safeName(stage.id) then
      local f = tryBase(b.base, nil, stage, skipped)
      if f and (not best or (tonumber(f.doc.savedEpoch) or 0) > (tonumber(best.doc.savedEpoch) or 0)) then best = f end
    end
  end
  if best then best.otherRally = best.doc.rallyId; log_('I', 'crash save: found ' .. best.file .. ' (saved under rally ' .. tostring(best.doc.rallyId) .. ')') return best end
  return nil, skipped
end
function M.readBeat(base)
  local text = M.io.read(beatPath(base))
  local d = text and M.io.decode(text)
  if type(d) == 'table' and d.format == 'rallyraid-heartbeat' and tonumber(d.clock) and tonumber(d.epoch) then return d end
end
function M.clearFiles(base)
  if not base then return end
  if R and R.pending then for i = #R.pending, 1, -1 do if R.pending[i].file == base .. '.json' then table.remove(R.pending, i) end end end
  for _, f in ipairs(M.paths(base)) do M.io.remove(f) end
  M.io.remove(base .. '.json.tmp')
  M.io.remove(beatPath(base))
end

------------------------------------------------------------------------------------------------------------------
-- game access (replaced in tests)
local function recovery() return H.recovery end
M.game = {
  vehicleInfo = function()
    local be_, gpv = rawget(_G, 'be'), rawget(_G, 'getPlayerVehicle')
    local v = (be_ and be_:getPlayerVehicle(0)) or (gpv and gpv(0))
    if not v then return nil end
    local out = {}
    local ok, m = pcall(function() return v:getJBeamFilename() end); if ok then out.model = m end
    local okC, c = pcall(function() return v.partConfig end); if okC and type(c) == 'string' then out.config = c end
    local okI, id = pcall(function() return v:getID() end); if okI then out.vehId = id end
    return out
  end,
  replaceVehicle = function(model, config)
    local cv = rawget(_G, 'core_vehicles')
    if not (cv and cv.replaceVehicle) then return false, 'core_vehicles missing' end
    -- partConfig is a .pc path, or a serialized table for a config changed in the parts menu
    local ds = rawget(_G, 'deserialize')
    if type(config) == 'string' and config:sub(1, 1) == '{' and ds then local okD, t = pcall(ds, config); if okD and type(t) == 'table' then config = t end end
    local ok, err = pcall(cv.replaceVehicle, model, { config = config })
    return ok, ok and nil or tostring(err)
  end,
  send = function(cmd) local rm = H.repair; return rm and rm.game.send(cmd) end,
  pose = function() local a = api(); if a and a.pose then local ok, p = pcall(a.pose); if ok then return p end end end,
  -- the set-down is RECOVER CAR's (rallyRaid/resume.lua): same functions, so a fix there helps both
  place = function(t) return recovery().game.place(t) end,
  teleport = function(lat, lon, name) return recovery().game.teleport(lat, lon, name) end,
  canPlaceLocally = function(t) return recovery().game.canPlaceLocally(t) end,
  resetInPlace = function() local rm = H.repair; return rm and rm.game.resetInPlace() end,
}

local function vehCall(fn, ...)
  local rm = H.repair
  local s = rawget(_G, 'serialize')
  local args = { s and s(rm.vehCfg()) or 'nil' }
  for _, a in ipairs({ ... }) do args[#args + 1] = type(a) == 'table' and (s and s(a) or 'nil') or tostring(a) end
  local ext = rm.VEH_EXT
  return M.game.send('extensions.load("' .. ext .. '"); if ' .. ext .. ' then ' .. ext .. '.' .. fn .. '(' .. table.concat(args, ', ') .. ') end')
end

------------------------------------------------------------------------------------------------------------------
-- what a save holds, in short (the offer, the review flag's "saved" and "resumed" sides)
local function summarize(st, pos, car, vehicle)
  st = st or {}
  local ok, miss = 0, 0
  for _, w in ipairs(st.wps or {}) do if w.s == 'ok' then ok = ok + 1 elseif w.s == 'missed' then miss = miss + 1 end end
  local rep = type(st.repair) == 'table' and st.repair or {}
  return { clock = round(st.clock, 1), target = st.target, validated = ok, missed = miss,
    penaltyTotal = round(st.penaltyTotal or 0, 1), penalties = #(st.penalties or {}),
    sparesUsed = rep.spares or 0, repairTimeS = rep.timeS or 0, repairs = #(rep.log or {}),
    recoveries = rep.resumes or 0, gameResumes = #(st.gameResumeLog or {}),
    trip = st.odo and round((st.odo.trip or 0) / 1000, 3) or nil,
    lat = pos and pos.lat, lon = pos and pos.lon, heading = pos and round(pos.heading, 1),
    damage = car and car.damage or nil, vehicle = vehicle and vehicle.model or nil }
end
M.summarize = summarize

-- the review entry's comparison of the two sides
local function compare(a, b)
  local d = {}
  if a.lat and b.lat then d.positionM = round(geo.dist(a.lat, a.lon, b.lat, b.lon), 1) end
  if a.heading and b.heading then d.headingDeg = round(math.abs(geo.angleDiff(a.heading, b.heading)), 1) end
  d.clockS = round((b.clock or 0) - (a.clock or 0), 1)
  d.penaltyS = round((b.penaltyTotal or 0) - (a.penaltyTotal or 0), 1)
  d.validated = (b.validated or 0) - (a.validated or 0)
  d.sparesUsed = (b.sparesUsed or 0) - (a.sparesUsed or 0)
  if type(a.damage) == 'table' and type(b.damage) == 'table' then
    local worst, groups = 0, {}
    for g, x in pairs(a.damage) do groups[g] = true end
    for g in pairs(b.damage) do groups[g] = true end
    for g in pairs(groups) do worst = math.max(worst, math.abs((tonumber(b.damage[g]) or 0) - (tonumber(a.damage[g]) or 0))) end
    d.damageMaxDiff = round(worst, 3)
  end
  d.sameVehicle = (a.vehicle == nil or b.vehicle == nil or a.vehicle == b.vehicle)
  return d
end

------------------------------------------------------------------------------------------------------------------
-- saving
local function base()
  local s = S()
  if not (s and H.rallyId) then return nil end
  return M.basePath(H.rallyId(), s.stage.id)
end
local function signature(s)
  local ok, miss = 0, 0
  for i = 1, #(s.state or {}) do if s.state[i] == 'ok' then ok = ok + 1 elseif s.state[i] == 'missed' then miss = miss + 1 end end
  local rp = s.repair or {}
  return table.concat({ s.target or 0, ok, miss, #(s.penalties or {}), rp.spares or 0, rp.resumes or 0, #(rp.log or {}),
    #(s.gameResumeLog or {}) }, '|')
end
-- why canSave() says no (for the log)
function M.whyNoSave()
  local s, n = S(), nav()
  if not C().enabled then return 'switched off (repairConfig gameCrashResume.enabled)' end
  if not (s and s.phase == 'running') then return 'no running stage' end
  if R.busy then return 'a resume is running' end
  if not (n.ok and n.lat) then return 'no position yet' end
  return 'a recovery / repair is running or the world is rebasing'
end
local function canSave()
  local s, n = S(), nav()
  if not (C().enabled and s and s.phase == 'running') then return false end
  if R.busy then return false end
  if H.recovery and H.recovery.busy() then return false end
  if H.repair and H.repair._R().busy then return false end
  if not (n.ok and n.lat) then return false end
  local a = api()
  if a and a.rebasing and a.rebasing() then return false end
  return true
end
local function pose()
  local n = nav()
  local p = M.game.pose() or {}
  return { lat = n.lat, lon = n.lon, alt = tonumber(p.alt), heading = round(n.heading or p.heading, 2), speedKmh = round((n.speed or 0) * 3.6, 1) }
end

-- build and write the save (car = the damage the car sent, or the last one it sent)
local function writeSave(p, car, carFresh)
  local s = S()
  if not s then return false end
  R.seq = R.seq + 1
  local now = M.io.time()
  local doc = { format = M.FORMAT, schemaVersion = M.SCHEMA, modVersion = H.modVersion, seq = R.seq, reason = p.reason,
    savedAt = isoUtc(now), savedEpoch = now, rallyId = H.rallyId(), stageId = s.stage.id, stageName = s.stage.name,
    stagePath = s.stage.path, wpCount = #s.stage.waypoints, pos = p.pos, vehicle = p.vehicle, stage = p.stage,
    car = car, carFresh = carFresh and true or false, carAgeS = car and car.epoch and (now - car.epoch) or nil }
  doc.summary = summarize(p.stage, p.pos, car, p.vehicle)
  local rp = s.repair and s.repair.bivouac
  if rp then doc.bivouac = { usedMin = rp.usedMin, budgetMin = rp.budgetMin, overMin = rp.overMin, engineChanges = rp.engineChanges } end
  local ok, why = M.writeAtomic(p.base, jsonSafe(doc))
  if ok then
    R.savesWritten = R.savesWritten + 1
    R.lastSaveAt, R.lastSaveClock, R.lastSaveEpoch, R.lastSaveReason = doc.savedAt, p.stage.clock, now, p.reason
    log_('I', string.format('crash save %d written: %s.json (%s, stage clock %s, car damage %s)', R.savesWritten, tostring(p.base),
      tostring(p.reason), hms(p.stage and p.stage.clock), car and (carFresh and 'fresh' or 'last known') or 'none'))
  else
    R.saveFails = R.saveFails + 1
    log_('W', 'crash save FAILED (' .. R.saveFails .. '): ' .. tostring(p.base) .. '.json: ' .. tostring(why))
  end
  return ok, why
end

-- a save: the stage as it is now; the car is asked for its damage and the file is written when it answers (or after
-- carAnswerS with the last damage it sent)
function M.requestSave(reason)
  if not canSave() then
    if reason ~= 'timer' and reason ~= 'event' then log_('I', 'crash save (' .. tostring(reason) .. ') not possible now: ' .. M.whyNoSave()) end
    return false
  end
  local s = S()
  R.req = R.req + 1
  R.pendingSave = { reqId = R.req, reason = reason, t = R.t, base = base(), pos = pose(), stage = jsonSafe(H.captureStage()),
    vehicle = M.game.vehicleInfo() }
  R.sig = signature(s)
  R.nextSaveClock = s.clock + C().saveEveryS
  vehCall('gameCapture', R.req)
  return true
end
-- straight to disk with the last damage the car sent (the game is closing: no time to ask the car)
function M.saveNow(reason)
  if not canSave() then return false end
  local p = { reqId = -1, reason = reason, base = base(), pos = pose(), stage = jsonSafe(H.captureStage()), vehicle = M.game.vehicleInfo() }
  R.pendingSave = nil
  return writeSave(p, R.lastCar, false)
end

local function writeBeat()
  local s = S()
  local b = base()
  if not (s and b) then return end
  local text = M.io.encode({ format = 'rallyraid-heartbeat', clock = round(s.clock, 1), epoch = M.io.time(), at = isoUtc(M.io.time()),
    seq = R.seq })
  if text then M.io.write(beatPath(b), text) end
end

------------------------------------------------------------------------------------------------------------------
-- the stage's life (core)
local function ledger() return H.repair and H.repair.ledger() end
local function stageDiscards(stageId)
  local L = ledger()
  local out = {}
  for _, d in ipairs(L and L.gameResumeDiscards or {}) do if d.stageId == stageId then out[#out + 1] = d end end
  return out
end

-- a stage was loaded: is there a save to resume?
function M.stageLoaded()
  R.offer, R.askDiscard, R.keyT, R.busy, R.hold = nil, false, nil, nil, nil
  local s = S()
  if not (C().enabled and s and H.rallyId) then M.push(); return nil end
  local found, skipped = M.loadSave(H.rallyId(), s.stage)
  if not found then
    log_('I', 'crash save: none for stage ' .. tostring(s.stage.id) .. ((skipped and #skipped > 0) and (' (' .. #skipped .. ' file(s) not usable: ' .. tostring(skipped[1].why) .. ')') or ''))
    if skipped and #skipped > 0 then
      R.msg, R.msgAt = 'A saved stage was found but could not be used (' .. skipped[1].why .. ').', R.t
      notify('rally.raid Earth: ' .. R.msg, 6)
    end
    M.push()
    return nil
  end
  local d = found.doc
  local now = M.io.time()
  local agoS = now - (tonumber(d.savedEpoch) or now)
  if C().maxSaveAgeH and agoS > C().maxSaveAgeH * 3600 then
    R.msg, R.msgAt = 'A saved stage was found but it is older than ' .. C().maxSaveAgeH .. ' h: not offered.', R.t
    M.push()
    return nil
  end
  local beat = M.readBeat(found.base)
  local o = { elapsedS = tonumber(d.stage.clock), savedAgoS = agoS, savedAt = d.savedAt, saveReason = d.reason, used = found.used,
    skipped = found.skipped, summary = d.summary, stageName = d.stageName or s.stage.name, vehicle = d.vehicle and d.vehicle.model,
    hasDamage = d.car ~= nil }
  if beat and tonumber(beat.clock) and beat.clock >= o.elapsedS then
    o.lastAliveClock, o.lastAliveAgoS = beat.clock, now - beat.epoch
    o.stageTimeLostS = round(beat.clock - o.elapsedS, 1)
  end
  o.policy = M.policy(d)
  o.text = string.format('Resume from last save (%s elapsed, saved %s ago)', hms(o.elapsedS), ago(agoS))
  R.offer = { doc = d, found = found, beat = beat, o = o }
  log_('I', 'crash save OFFERED: ' .. found.file .. ' (' .. o.text .. ')')
  notify('rally.raid Earth: ' .. o.text .. '? RESUME in the GPS app' .. keys.hint('rallyRaid_gameResume', ' (or %s twice)') .. '; DISCARD (GPS MENU > REPAIR) starts the stage again.', 10)
  M.push()
  return o
end

-- crash saves on disk at startup / after a level loaded: logged, and listed in the GPS MENU (LOAD -> the offer)
function M.startupScan()
  local out = {}
  local now = M.io.time()
  for _, b in ipairs(M.saveBases()) do
    local d = M.io.decode(M.io.read(b.file) or '')
    if type(d) == 'table' and d.format == M.FORMAT then
      out[#out + 1] = { stageId = d.stageId, stageName = d.stageName, stagePath = d.stagePath, savedAt = d.savedAt,
        agoS = now - (tonumber(d.savedEpoch) or now), clock = type(d.stage) == 'table' and tonumber(d.stage.clock) or nil, file = b.file }
    end
  end
  table.sort(out, function(a, b) return (a.agoS or 0) < (b.agoS or 0) end)
  R.pending = out
  log_('I', 'crash saves on disk (' .. C().dir .. '): ' .. #out .. (#out > 0 and (', newest: ' .. tostring(out[1].stageName) .. ' saved ' .. ago(out[1].agoS) .. ' ago') or ''))
  M.push()
  return out
end

-- what the rules say for this save: { penaltyS, rallyCount, stageCount, retire, reason }
function M.policy(d)
  local c = C()
  local L = ledger()
  local st = d.stage or {}
  local rallyN = #(L and L.gameResumes or {})
  local stageN = #(st.gameResumeLog or {})
  if c.shareRecoveryBudget then
    rallyN = rallyN + #(L and L.resumes or {})
    stageN = stageN + ((type(st.repair) == 'table' and st.repair.resumes) or 0)
  end
  local out = { rallyCount = rallyN + 1, stageCount = stageN + 1, maxPerRally = c.maxPerRally, maxPerStage = c.maxPerStage }
  out.penaltyS = (rallyN == 0) and (c.firstPenaltyS or 0) or (c.laterPenaltyS or 0)
  local why
  if c.maxPerStage and stageN + 1 > c.maxPerStage then why = string.format('more than %d resume(s) on this stage', c.maxPerStage)
  elseif c.maxPerRally and rallyN + 1 > c.maxPerRally then why = string.format('more than %d resumes in the rally', c.maxPerRally)
  elseif c.noResumeNearFinishM and type(d.pos) == 'table' and S() then
    local wps = S().stage.waypoints
    local ass = wps[#wps]
    local dFin = geo.dist(d.pos.lat, d.pos.lon, ass.lat, ass.lon)
    if dFin < c.noResumeNearFinishM then why = string.format('saved within %d m of the ASS (%d m)', c.noResumeNearFinishM, math.floor(dFin)) end
  end
  if why then out.refused, out.reason, out.retire = true, why, c.retireOverLimit ~= false; out.penaltyS = 0 end
  return out
end

function M.stageStarted()
  local s = S()
  -- a save not resumed: the driver starts the stage again from scratch (logged, and the result is flagged)
  if R.offer then M.discard('started the stage again', true) end
  R.offer, R.askDiscard, R.hold, R.busy = nil, false, nil, nil
  R.savesWritten, R.saveFails, R.lastSaveAt, R.lastSaveClock, R.lastSaveEpoch, R.lastCar = 0, 0, nil, nil, nil, nil
  if s then
    s.gameResumeLog = {}
    local disc = stageDiscards(s.stage.id)
    if #disc > 0 then s.flags.restartedAfterGameCrash = #disc end
  end
  R.beatAcc = 0
  R.sig = nil
  M.clearFiles(base())
  M.requestSave('start')
  M.push()
end
-- the stage ended (ASS or retired): no resume any more
function M.stageFinished()
  M.clearFiles(base())
  R.pendingSave, R.hold, R.busy = nil, nil, nil
  M.push()
end
-- the running stage is dropped (abort, unload, another stage loaded): its save goes
function M.abandon(reason)
  local s = S()
  if s and s.phase == 'running' then
    M.clearFiles(base())
    log_('I', 'game-crash save cleared: ' .. tostring(reason))
  end
  R.pendingSave, R.hold, R.busy = nil, nil, nil
end

function M.discard(why, quiet)
  if not R.offer then return false end
  local d = R.offer.doc
  local L = ledger()
  if L then
    L.gameResumeDiscards = L.gameResumeDiscards or {}
    L.gameResumeDiscards[#L.gameResumeDiscards + 1] = { at = isoUtc(M.io.time()), stageId = d.stageId, savedAt = d.savedAt,
      savedClock = d.stage.clock, reason = why or 'discarded by the driver', summary = d.summary }
    if H.repair.saveLedger then H.repair.saveLedger() end
  end
  M.clearFiles(R.offer.found.base)
  R.offer, R.askDiscard, R.keyT = nil, false, nil
  if not quiet then
    R.msg, R.msgAt = 'Saved stage discarded. Drive to the DSS to start it again (the restart is logged).', R.t
    notify('rally.raid Earth: ' .. R.msg, 6)
  end
  M.push()
  return true
end

------------------------------------------------------------------------------------------------------------------
-- resuming
local function fail(why)
  R.busy = nil
  R.msg, R.msgAt = 'Resume failed: ' .. why .. ' The save is kept: try again, or DISCARD.', R.t
  notify('rally.raid Earth: ' .. R.msg, 8)
  log_('W', 'game-crash resume failed: ' .. why)
  if H.repair then M.game.send('if ' .. H.repair.VEH_EXT .. ' then ' .. H.repair.VEH_EXT .. '.cancel() end') end
  M.push()
end

local function flagEntry(b, after)
  local d, now = b.doc, M.io.time()
  local beat = R.offer and R.offer.beat or b.beat
  local saved = summarize(d.stage, d.pos, d.car, d.vehicle)
  local p = M.game.pose() or {}
  local n = nav()
  local s = S()
  local cur = jsonSafe(H.captureStage())
  local resumedPos = { lat = n.lat or p.lat, lon = n.lon or p.lon, heading = n.heading or p.heading }
  local resumed = summarize(cur, resumedPos, { damage = after and after.damage or nil }, M.game.vehicleInfo())
  local e = { kind = 'gameCrashResume', review = C().flagForReview ~= false,
    resumedAt = isoUtc(now), resumedEpoch = now, savedAt = d.savedAt, savedEpoch = d.savedEpoch, saveReason = d.reason, saveSeq = d.seq,
    saveUsed = b.found.used, savesSkipped = b.found.skipped, cleanExit = (d.reason == 'quit') or nil,
    wallGapS = now - (tonumber(d.savedEpoch) or now),
    rallyCount = b.policy.rallyCount, stageCount = b.policy.stageCount, penaltyS = b.policy.penaltyS,
    saved = saved, resumed = resumed, diff = compare(saved, resumed),
    damageRestored = d.car ~= nil, carDataAgeS = d.carAgeS, carSkipped = after and after.skipped or nil,
    engineFlagsNotRestored = after and after.engineFlagsNotRestored or nil, stats = after and after.stats or nil,
    far = b.far or false, respawned = b.respawned or nil, rules = { penaltyS = b.policy.penaltyS, official = C().useOfficialRules or false } }
  if beat and tonumber(beat.clock) and tonumber(d.stage.clock) and beat.clock >= d.stage.clock then
    e.lastAlive = { at = beat.at, epoch = beat.epoch, clock = beat.clock }
    e.stageTimeLostS = round(beat.clock - d.stage.clock, 1)     -- stage time driven after the save, then lost (estimate)
    e.crashWithinS = C().heartbeatEveryS                         -- the game stopped within this after lastAlive
    e.wallGapSinceAliveS = now - beat.epoch
  end
  -- the review line an organizer reads first
  e.summary = string.format('game-crash resume %d: saved %s at %s stage time (%s), resumed %s later%s; %s',
    e.rallyCount, d.savedAt or '?', hms(d.stage.clock), tostring(d.reason), ago(e.wallGapS),
    e.stageTimeLostS and string.format(', about %s of driving after the save lost', hms(e.stageTimeLostS)) or '',
    e.penaltyS > 0 and ('+' .. math.floor(e.penaltyS / 60) .. ' min') or 'no penalty')
  return e
end

-- the car is back with its damage: restore the stage, apply the rules, flag it, hold the clock
local function commit(after)
  local b = R.busy
  local d = b.doc
  if not H.restoreStage(d.stage) then fail('the stage state could not be restored.'); return end
  local s = S()
  s.gameResumeLog = type(s.gameResumeLog) == 'table' and s.gameResumeLog or {}
  local e = flagEntry(b, after)
  s.gameResumeLog[#s.gameResumeLog + 1] = e
  s.flags.gameCrashResume = #s.gameResumeLog
  if e.review then s.flags.reviewRequired = true end
  if e.penaltyS > 0 and H.addPenalty then
    H.addPenalty('gameCrashResume', e.penaltyS, string.format('game-crash resume %d (+%d min)', e.rallyCount, math.floor(e.penaltyS / 60)))
  end
  local L = ledger()
  if L then
    L.gameResumes = L.gameResumes or {}
    L.gameResumes[#L.gameResumes + 1] = { at = e.resumedAt, stageId = d.stageId, savedAt = d.savedAt, savedClock = d.stage.clock,
      wallGapS = e.wallGapS, stageTimeLostS = e.stageTimeLostS, penaltyS = e.penaltyS, summary = e.summary }
    if H.repair.saveLedger then H.repair.saveLedger() end
  end
  R.lastFlag = e
  if b.found and b.found.base and b.found.base ~= base() then M.clearFiles(b.found.base) end   -- (saved under another rally id)
  log_('I', 'crash save resumed at ' .. hms(s.clock) .. ' stage time')
  R.offer, R.busy = nil, nil
  R.hold = { since = R.t, clock = s.clock }
  R.seq = math.max(R.seq, tonumber(d.seq) or 0)
  R.lastCar = d.car
  if H.recovery and H.recovery.stageResumed then H.recovery.stageResumed() end
  if H.repair then H.repair.updateBlocking(); H.repair.push() end
  if H.hook then H.hook('onRallyRaidGameResume', e) end
  R.msg, R.msgAt = string.format('Resumed at %s stage time. Flagged for organizer review (%s since the save). The clock starts when you drive off.',
    hms(s.clock), ago(e.wallGapS)), R.t
  notify('rally.raid Earth: ' .. R.msg, 8)
  -- saved straight away, so a second crash resumes from here
  R.sig = nil
  M.requestSave('resumed')
  M.push()
end

-- the rules refuse it and retire the stage: the saved state becomes the result
local function retireFromSave(o, d)
  if not H.restoreStage(d.stage) then return false end
  local s = S()
  s.gameResumeLog = type(s.gameResumeLog) == 'table' and s.gameResumeLog or {}
  local now = M.io.time()
  local e = { kind = 'gameCrashResumeRetired', review = true, resumedAt = isoUtc(now), savedAt = d.savedAt, saveReason = d.reason,
    wallGapS = now - (tonumber(d.savedEpoch) or now), reason = o.reason, saved = summarize(d.stage, d.pos, d.car, d.vehicle) }
  s.gameResumeLog[#s.gameResumeLog + 1] = e
  s.flags.reviewRequired = true
  R.offer = nil
  if H.retireStage then H.retireStage('game crash: ' .. o.reason) end
  R.msg, R.msgAt = 'Stage retired after the game crash: ' .. o.reason .. '.', R.t
  notify('rally.raid Earth: ' .. R.msg, 8)
  M.push()
  return true
end

function M.resume()
  local s, n = S(), nav()
  local function no(why) R.msg, R.msgAt = 'No resume: ' .. why .. '.', R.t; notify('rally.raid Earth: ' .. R.msg, 6); M.push(); return false, why end
  if not R.offer then return no('no saved stage for this stage') end
  if R.busy then return no('a resume is already running') end
  if not s then return no('load the stage first') end
  if s.phase == 'running' or s.phase == 'finished' then return no('the stage is ' .. s.phase .. ' (load it again)') end
  if not (n.ok and n.lat) then return no('waiting for BeamNG.Earth (no position yet)') end
  local d = R.offer.doc
  local pol = M.policy(d)
  if pol.refused then
    if pol.retire then retireFromSave(pol, d); return false, pol.reason end
    return no(pol.reason)
  end
  R.req = R.req + 1
  R.busy = { reqId = R.req, phase = 'start', startedT = R.t, phaseT = R.t, doc = d, found = R.offer.found, beat = R.offer.beat,
    policy = pol, target = { lat = d.pos.lat, lon = d.pos.lon, alt = d.pos.alt, heading = d.pos.heading or 0 } }
  R.msg, R.askDiscard = nil, false
  notify('rally.raid Earth: resuming the saved stage: putting the car back where it was ...', 5)
  local cur = M.game.vehicleInfo() or {}
  if d.vehicle and d.vehicle.model and cur.model and d.vehicle.model ~= cur.model then
    R.busy.phase, R.busy.respawned = 'spawn', { from = cur.model, to = d.vehicle.model }
    local ok, why = M.game.replaceVehicle(d.vehicle.model, d.vehicle.config)
    if not ok then fail('the saved car (' .. d.vehicle.model .. ') could not be spawned (' .. tostring(why) .. ').') return false end
  else
    M.go()
  end
  M.push()
  return true
end

function M.go()
  local b = R.busy
  b.phaseT = R.t
  local n = nav()
  local fromM = (n.lat and geo.dist(n.lat, n.lon, b.target.lat, b.target.lon)) or math.huge
  b.far = fromM > (cfgAll.carRecovery.localMoveMaxM or 1500) or not M.game.canPlaceLocally(b.target)
  if b.far then
    b.phase = 'teleport'
    local ok, why = M.game.teleport(b.target.lat, b.target.lon, 'Resume saved stage')
    if not ok then fail('the teleport was refused (' .. tostring(why) .. ').'); return false end
  else
    b.phase = 'arm'
    vehCall('gameArm', b.doc.car or {}, b.reqId)
  end
  return true
end

local function place()
  local b = R.busy
  b.phase, b.phaseT = 'place', R.t
  b.resetSeen = false
  local ok, why, resets = M.game.place(b.target)
  if not ok then fail('the car could not be set down (' .. tostring(why) .. ').'); return end
  if not resets and not b.resetSeen then b.needReset = true end
end

function M.teleported()
  local b = R.busy
  if b and b.phase == 'teleport' then
    b.phase, b.phaseT = 'arm', R.t
    vehCall('gameArm', b.doc.car or {}, b.reqId)
    M.push()
    return true
  end
  return false
end

function M.reply(d)
  if type(d) ~= 'table' then return end
  if d.kind == 'gameCar' then
    local p = R.pendingSave
    if d.ok then
      R.lastCar = { beams = d.beams, nodes = d.nodes, deflated = d.deflated, fuel = d.fuel, engineFlags = d.engineFlags,
        upright = d.upright, damage = d.damage, nBeams = d.nBeams, nNodes = d.nNodes, epoch = M.io.time() }
    end
    if p and p.reqId == d.reqId then
      R.pendingSave = nil
      writeSave(p, R.lastCar, d.ok)
    end
  elseif d.kind == 'gameReady' then
    local b = R.busy
    if b and b.reqId == d.reqId and b.phase == 'arm' then
      if not d.ok then fail('the car did not answer (' .. tostring(d.why) .. ').') return end
      b.skipped = d.skipped
      place()
    end
  elseif d.kind == 'gameDone' then
    local b = R.busy
    if b and b.reqId == d.reqId then
      if not d.ok then fail('the damage could not be put back (' .. tostring(d.why) .. ').') return end
      local after = { damage = nil, skipped = b.skipped, stats = d.stats, engineFlagsNotRestored = d.engineFlagsNotRestored }
      if type(d.after) == 'table' then after.damage = M.damageSummary(d.after) end
      b.after = after
      b.phase, b.phaseT = 'settle', R.t
    end
  end
  M.push()
end
-- the same summary as the vehicle half's (worst corner per group)
function M.damageSummary(measured)
  local out = {}
  for g, byC in pairs(measured or {}) do
    local worst = 0
    for _, e in pairs(byC) do worst = math.max(worst, tonumber(e.damage) or 0) end
    out[g] = math.floor(worst * 1000 + 0.5) / 1000
  end
  return out
end

-- the clock: held after a resume until the car moves (or GO)
function M.release(how)
  if not R.hold then return false end
  local e = R.lastFlag
  if e then e.clockReleasedBy = how; e.heldRealS = round(R.t - R.hold.since, 1) end
  R.hold = nil
  notify('rally.raid Earth: stage clock running again.', 3)
  M.push()
  return true
end

------------------------------------------------------------------------------------------------------------------
-- frame update (core.onUpdate) and the hooks core passes on
function M.clockPaused() return R.busy ~= nil or R.hold ~= nil end
function M.holdNav() return R.busy ~= nil end
function M.busy() return R.busy ~= nil end
function M.holding() return R.hold ~= nil end

function M.onVehicleResetted(vehId)
  if not R.busy then return nil end
  R.busy.resetSeen = true
  return 'ours'
end

function M.update(dtReal)
  dtReal = dtReal or 0
  R.t = R.t + dtReal
  local s = S()
  local b = R.busy
  if b then
    local age = R.t - b.phaseT
    local rc = cfgAll.carRecovery
    if b.phase == 'spawn' then
      local cur = M.game.vehicleInfo() or {}
      if cur.model == b.doc.vehicle.model then M.go()
      elseif age > C().spawnTimeoutS then fail('the saved car (' .. b.doc.vehicle.model .. ') did not appear.') end
    elseif b.phase == 'teleport' and age > rc.teleportTimeoutS then fail('the teleport took too long.')
    elseif b.phase == 'arm' and age > rc.answerTimeoutS then fail('the car did not answer.')
    elseif b.phase == 'place' then
      if b.needReset and not b.resetSeen and age >= rc.resetFallbackS then
        b.needReset = false
        if not M.game.resetInPlace() then fail('the car could not be reset.') end
      elseif age > rc.answerTimeoutS then fail('the car did not answer.') end
    elseif b.phase == 'settle' and age >= rc.settleS then commit(b.after) end
    return
  end
  if R.msg and R.msgAt and R.t - R.msgAt > 15 then R.msg, R.msgAt = nil, nil; M.push() end
  if R.keyT and R.t - R.keyT > C().confirmS then R.keyT = nil end
  if not (s and s.phase == 'running') then return end
  if R.hold then
    local n = nav()
    if (n.speed or 0) * 3.6 > C().releaseKmh then M.release('drove off') end
  end
  if R.pendingSave and R.t - R.pendingSave.t > C().carAnswerS then
    local p = R.pendingSave
    R.pendingSave = nil
    writeSave(p, R.lastCar, false)
  end
  if not C().enabled then return end
  R.beatAcc = R.beatAcc + dtReal
  if R.beatAcc >= C().heartbeatEveryS and R.savesWritten > 0 then R.beatAcc = 0; writeBeat() end
  if R.pendingSave then return end
  if C().saveOnEvents and R.sig and signature(s) ~= R.sig then M.requestSave('event')
  elseif R.nextSaveClock == nil or s.clock >= R.nextSaveClock then M.requestSave(R.nextSaveClock == nil and 'start' or 'timer') end
end

-- the game is closing / the level is left mid-stage: one last save (the car's damage as it last sent it)
function M.onExit(why)
  local s = S()
  if s and s.phase == 'running' and not R.busy then M.saveNow(why or 'quit') end
end

------------------------------------------------------------------------------------------------------------------
-- UI state ('RallyRaidGameResume') and commands
function M.state()
  local s = S()
  local st = { key = keys.get('rallyRaid_gameResume'), keyArmed = (R.offer and R.keyT and R.t - R.keyT <= C().confirmS) and true or nil, enabled = C().enabled and true or false, msg = R.msg,
    busy = R.busy and { phase = R.busy.phase } or nil, hold = R.hold and true or nil, askDiscard = R.askDiscard or nil,
    offer = R.offer and R.offer.o or nil }
  if not R.offer and not (s and s.phase == 'running') and R.pending and #R.pending > 0 then
    st.pending = {}
    for i = 1, math.min(3, #R.pending) do local p = R.pending[i]
      st.pending[i] = { stageId = p.stageId, stageName = p.stageName, stagePath = p.stagePath, ago = ago(p.agoS), elapsed = hms(p.clock),
        loaded = (s and s.stage.id == p.stageId) or nil } end
  end
  if s and s.phase == 'running' then
    st.saves = R.savesWritten
    st.lastSaveAgeS = R.lastSaveClock and round(s.clock - R.lastSaveClock, 0) or nil
    st.saveFails = R.saveFails > 0 and R.saveFails or nil
  end
  local log = s and s.gameResumeLog
  if type(log) == 'table' and #log > 0 then
    local e = log[#log]
    st.flagged = { count = #log, summary = e.summary, wallGapS = e.wallGapS, stageTimeLostS = e.stageTimeLostS,
      resumedAt = e.resumedAt, savedAt = e.savedAt, penaltyS = e.penaltyS, positionM = e.diff and e.diff.positionM,
      damageMaxDiff = e.diff and e.diff.damageMaxDiff }
  end
  return st
end
function M.push() if H.ui then H.ui('RallyRaidGameResume', M.state()) end end

-- the RESUME button in the GPS app (and the rallyRaid_gameResume action, no key by default): GO while the clock is held; with a save offered: show it, a second press resumes; else the status
function M.key()
  if R.hold then return M.release('confirmed') end
  if R.offer then
    if R.keyT and R.t - R.keyT <= C().confirmS then R.keyT = nil; return M.resume() end
    R.keyT = R.t
    notify('rally.raid Earth: ' .. R.offer.o.text .. '. Press CONFIRM RESUME' .. keys.hint('rallyRaid_gameResume', ' (or %s)') .. ' again to resume.', 8)
    M.push()
    return false
  end
  local s = S()
  if s and s.phase == 'running' then
    notify(string.format('rally.raid Earth: game-crash save: %d written%s.', R.savesWritten,
      R.lastSaveClock and (', the last ' .. ago(s.clock - R.lastSaveClock) .. ' of stage time ago') or ''), 4)
  else notify('rally.raid Earth: no saved stage to resume here.', 4) end
  return false
end

function M.cmd(sub, arg)
  if sub == 'Key' then M.key()
  elseif sub == 'Resume' then M.resume()
  elseif sub == 'Discard' then
    if not R.offer then return end
    if R.askDiscard or arg == 'sure' then M.discard('discarded by the driver') else R.askDiscard = true; M.push() end
  elseif sub == 'DiscardCancel' then R.askDiscard = false; M.push()
  elseif sub == 'Go' then M.release('confirmed')
  elseif sub == 'Dismiss' then R.msg, R.msgAt = nil, nil; M.push()
  elseif sub == 'State' then M.push()
  else log_('W', 'unknown game resume command ' .. tostring(sub)) end
end

-- what goes into the stage result
function M.resultFields(s)
  local log = type(s.gameResumeLog) == 'table' and s.gameResumeLog or {}
  local review = {}
  for _, e in ipairs(log) do review[#review + 1] = e.summary or (e.kind .. ': ' .. tostring(e.reason)) end
  local disc = stageDiscards(s.stage.id)
  for _, dd in ipairs(disc) do review[#review + 1] = string.format('stage restarted from scratch after a game crash (save from %s at %s stage time discarded: %s)', tostring(dd.savedAt), hms(dd.savedClock), tostring(dd.reason)) end
  return { resumes = log, count = #log, flagged = (#log > 0 or #disc > 0), review = review, discardedBefore = disc,
    savesWritten = R.savesWritten, saveFails = R.saveFails, lastSaveAt = R.lastSaveAt, rules = copy(C()) }
end

function M.init(hooks) H = hooks or {} end
function M._R() return R end
function M._reset() R = fresh() end

return M
