-- rally.raid Earth: the rally repair system (GE half). Required by core.lua; the vehicle half is
-- lua/vehicle/extensions/rallyRaid/vehRepair.lua. Every tunable number is in rallyRaid/repairConfig.lua.
-- Players' guide: docs/REPAIR.md. Written from scratch for this mod (no code from other mods).
--
--   * mid-stage repairs (car stopped): wheel change (spares per stage), light suspension per corner, radiator; the
--     time goes onto the stage as a 'repair' penalty
--   * the bivouac (after an ASS until the next stage's clock starts): whole-car repair and engine change, paid from
--     a 3 h budget; overrun and engine-change penalties go onto the next stage; too far over = retired
--   * official runs: BeamNG's free reset / recover keys are blocked, and any reset this app did not make counts like a
--     RECOVER CAR (M.countResume, the shared resume / reset budget: rallyRaid/resume.lua) or retires the stage
--   * the rally ledger (/rallyraid/rally/current.json) keeps what spans stages: resumes used, the open bivouac
--   * everything is logged and copied into the stage result (M.resultFields)
local cfg = require('rallyRaid/repairConfig')
local geo = require('rallyRaid/geo')
local keys = require('rallyRaid/keys')

local M = {}
M.cfg = cfg
M.LEDGER_FILE = '/rallyraid/rally/current.json'
M.VEH_EXT = 'rallyRaid_vehRepair'

local H = {}            -- hooks from core: S(), nav(), addPenalty(kind, s, detail), notify(text, s), ui(name, data),
                        -- hook(name, info), retireStage(reason), log(level, msg), stageKm()
local L                 -- the rally ledger
local R = { open = false, survey = nil, req = 0, busy = nil, expect = nil, msg = nil, appSeen = false, t = 0,
  blocked = false, lastKind = nil }

local function now() return os.date('!%Y-%m-%dT%H:%M:%SZ') end
local function S() return H.S and H.S() end
local function nav() return (H.nav and H.nav()) or {} end
local function notify(t, s) if H.notify then H.notify(t, s) end end
local function log_(l, m) if H.log then H.log(l, m) end end
local function round1(x) return math.floor(x * 10 + 0.5) / 10 end
local function copy(t) if type(t) ~= 'table' then return t end local c = {} for k, v in pairs(t) do c[k] = copy(v) end return c end
local function arr(x) if type(x) ~= 'table' then return {} end if #x > 0 or next(x) == nil then return x end
  local keys = {} for k in pairs(x) do if tonumber(k) then keys[#keys + 1] = tonumber(k) end end table.sort(keys)
  local out = {} for _, k in ipairs(keys) do out[#out + 1] = x[k] or x[tostring(k)] end return out end

------------------------------------------------------------------------------------------------------------------
-- the rally ledger
local function newLedger()
  return { format = 'rallyraid-rally', schemaVersion = 1, id = os.date('%Y%m%d-%H%M%S'), startedAt = now(),
    resumes = {}, stages = {}, bivouac = nil, bivouacs = {}, resetsOutsideStage = {}, retired = nil,
    gameResumes = {}, gameResumeDiscards = {} }
end
local function mkdirFor(path)
  local dir = path:match('^(.*)/[^/]*$')
  if not (dir and FS and FS.directoryCreate) then return end
  if FS.directoryExists then local ok, e = pcall(function() return FS:directoryExists(dir) end); if ok and e then return end end
  pcall(function() FS:directoryCreate(dir, true) end)
end
function M.saveLedger()
  local write = rawget(_G, 'jsonWriteFile')
  if not (write and L) then return false end
  mkdirFor(M.LEDGER_FILE)
  local ok, res = pcall(write, M.LEDGER_FILE, L, true)
  if not ok or res == false then log_('W', 'rally ledger NOT written to ' .. M.LEDGER_FILE .. ': ' .. tostring(res)) return false end
  return true
end
function M.loadLedger()
  local read = rawget(_G, 'jsonReadFile')
  local d
  if read then local ok, x = pcall(read, M.LEDGER_FILE); if ok and type(x) == 'table' and x.format == 'rallyraid-rally' then d = x end end
  L = d or newLedger()
  if d then log_('I', 'rally ledger: rally ' .. tostring(L.id) .. ' (from ' .. M.LEDGER_FILE .. ')')
  else
    -- 17 Nov: a new ledger was only written when something changed in it, so after a game kill the next launch made a
    -- NEW rally id, and the crash save (its file name has the rally id) was never looked up: no RESUME. Write it now.
    log_('I', 'rally ledger: new rally ' .. tostring(L.id) .. (M.saveLedger() and (' (written to ' .. M.LEDGER_FILE .. ')') or ''))
  end
  L.resumes, L.stages, L.bivouacs, L.resetsOutsideStage = arr(L.resumes), L.stages or {}, arr(L.bivouacs), arr(L.resetsOutsideStage)
  L.gameResumes, L.gameResumeDiscards = arr(L.gameResumes), arr(L.gameResumeDiscards)   -- game-crash resumes (gameResume.lua)
  return L
end
function M.ledger() if not L then M.loadLedger() end return L end
function M.newRally()
  L = newLedger(); M.saveLedger()
  notify('rally.raid Earth: new rally started: 0 of ' .. cfg.resume.maxPerRally .. ' resumes used, no bivouac open.', 5)
  M.updateBlocking(); M.push()
end

------------------------------------------------------------------------------------------------------------------
-- game access (replaced in tests)
local function playerVeh()
  local be_ = rawget(_G, 'be')
  return be_ and be_:getPlayerVehicle(0)
end
M.game = {
  vehId = function() local v = playerVeh(); if not v then return nil end local ok, id = pcall(function() return v:getID() end); return ok and id or nil end,
  -- run Lua in the player car's VM (answers come back through rallyRaid_core.repairReply)
  send = function(cmd) local v = playerVeh(); if not v then return false end return pcall(function() v:queueLuaCommand(cmd) end) end,
  -- reset the car to new where it stands (what BeamNG's own R key does); vehRepair then re-applies the damage
  resetInPlace = function()
    local v = playerVeh(); if not v then return false end
    local mode = rawget(_G, 'RESET_PHYSICS')
    local ok, how, err = false, nil, nil
    if mode ~= nil then ok, err = pcall(function() v:requestReset(mode) end); how = 'GE veh:requestReset(RESET_PHYSICS)' end
    if not ok then   -- no GE constant: ask the car to reset itself (vehicle Lua knows RESET_PHYSICS)
      ok, err = pcall(function() v:queueLuaCommand('if obj.requestReset and RESET_PHYSICS then obj:requestReset(RESET_PHYSICS) end') end)
      how = 'vehicle obj:requestReset(RESET_PHYSICS)'
    end
    return ok, how, (not ok) and tostring(err) or nil
  end,
  filter = function() return rawget(_G, 'core_input_actionFilter') end,
  iprLoaded = function()
    local ex = rawget(_G, 'extensions')
    if ex and ex.isExtensionLoaded then local ok, r = pcall(ex.isExtensionLoaded, 'partRepairMenu'); if ok and r then return true end end
    return rawget(_G, 'partRepairMenu') ~= nil
  end,
}

-- what the vehicle half needs from the config (sent with every call: one source of truth)
local function vehCfg()
  return { groups = cfg.groups, groupOrder = cfg.groupOrder, beamDamagedRatio = cfg.beamDamagedRatio, engineFlags = cfg.engineFlags }
end
M.vehCfg = vehCfg                 -- RECOVER CAR (rallyRaid/resume.lua) and the game-crash resume send the same table
local function ser(t) local s = rawget(_G, 'serialize'); return s and s(t) or 'nil' end
local function vehCall(fn, ...)
  local args = { ser(vehCfg()) }
  for _, a in ipairs({ ... }) do args[#args + 1] = type(a) == 'table' and ser(a) or tostring(a) end
  return M.game.send('extensions.load("' .. M.VEH_EXT .. '"); if ' .. M.VEH_EXT .. ' then ' .. M.VEH_EXT .. '.' .. fn .. '(' .. table.concat(args, ', ') .. ') end')
end

------------------------------------------------------------------------------------------------------------------
-- key blocking: official stage running, or a bivouac open with a stage loaded
function M.wantBlocked()
  local s = S()
  if not s then return false end
  if s.phase == 'running' then return true end
  return (L and L.bivouac and L.bivouac.open and not L.retired) and true or false
end
function M.updateBlocking()
  if not L then M.loadLedger() end
  local want = M.wantBlocked()
  if want == R.blocked then return end
  R.blocked = want
  local f = M.game.filter()
  if not f then return end
  local name = cfg.block.filterName
  if not want then pcall(f.clear, name) return end
  if cfg.block.useCompetitiveTemplate and f.getActionTemplates then
    local ok, t = pcall(f.getActionTemplates)
    for _, a in ipairs(ok and t and t.competitive or {}) do pcall(f.addAction, name, a, true) end
  end
  for _, a in ipairs(cfg.block.actions) do pcall(f.addAction, name, a, true) end
end
function M.isBlocked() return R.blocked end

------------------------------------------------------------------------------------------------------------------
-- mode: 'stage' (running), 'bivouac' (open, not running) or 'none'
function M.mode()
  local s = S()
  if s and s.phase == 'running' then return 'stage' end
  if L and L.bivouac and L.bivouac.open then return 'bivouac' end
  return 'none'
end

local function stopped() local n = nav(); return ((n.speed or 0) * 3.6) <= cfg.stage.maxStoppedKmh end
local function sparesLeft() local s = S(); local used = s and s.repair and s.repair.spares or 0; return cfg.stage.sparesPerStage - used end
local function gdmg(survey, g, c)
  local t = survey and survey.groups and survey.groups[g]
  if not t then return 0 end
  local e = t[c or '*']
  return e and tonumber(e.damage) or 0
end
local function isFlat(survey, c) for _, d in ipairs(arr(survey and survey.deflated)) do if d == c then return true end end return false end
local function corners(survey)
  local c = arr(survey and survey.corners)
  if #c == 0 then c = { 'FL', 'FR', 'RL', 'RR' } end
  return c
end

-- the whole-car repair's bivouac minutes from the survey (everything but the engine), with the itemised list
function M.wholeCarMinutes(survey)
  local B = cfg.bivouac
  local total, items = B.serviceMin, { { what = 'service', minutes = B.serviceMin } }
  local function add(what, base, d)
    if d > B.damageThreshold and base then
      local m = base * (B.scaleMin + (1 - B.scaleMin) * math.min(1, d))
      items[#items + 1] = { what = what, minutes = round1(m), damage = round1(d * 100) / 100 }
      total = total + m
    end
  end
  for g, byC in pairs(survey and survey.groups or {}) do
    if g ~= 'engine' then
      local def = cfg.groups[g]
      if def and def.perCorner then
        for c, e in pairs(byC) do add(g .. ' ' .. c, B.groupMin[g], math.max(tonumber(e.damage) or 0, (g == 'wheel' and isFlat(survey, c)) and 1 or 0)) end
      else
        local worst = 0
        for _, e in pairs(byC) do worst = math.max(worst, tonumber(e.damage) or 0) end
        add(g, B.groupMin[g] or B.groupMin.body, worst)
      end
    end
  end
  if survey and survey.groups and not survey.groups.wheel then
    for _, c in ipairs(arr(survey.deflated)) do add('wheel ' .. c, B.groupMin.wheel, 1) end
  end
  table.sort(items, function(a, b) return a.minutes > b.minutes end)
  return math.ceil(total), items
end

-- the repair menu's choices for the current mode
function M.options(mode, survey)
  local out = {}
  mode = mode or M.mode()
  if mode == 'stage' then
    local left = sparesLeft()
    for _, c in ipairs(corners(survey)) do
      local d, flat = gdmg(survey, 'wheel', c), isFlat(survey, c)
      out[#out + 1] = { id = 'wheel:' .. c, group = 'wheel', corner = c, kind = 'wheel', label = 'Change wheel ' .. c,
        minutes = cfg.stage.wheelChangeMin, damage = d, flat = flat, spare = true, enabled = left > 0,
        why = left <= 0 and 'no spare wheel left' or nil }
    end
    for _, c in ipairs(corners(survey)) do
      out[#out + 1] = { id = 'suspension:' .. c, group = 'suspension', corner = c, kind = 'suspension',
        label = 'Suspension ' .. c .. ' (light)', minutes = cfg.stage.suspensionMin, damage = gdmg(survey, 'suspension', c), enabled = true }
    end
    out[#out + 1] = { id = 'radiator', group = 'radiator', kind = 'radiator', label = 'Radiator', minutes = cfg.stage.radiatorMin,
      damage = gdmg(survey, 'radiator'), enabled = true }
  elseif mode == 'bivouac' then
    local m, items = M.wholeCarMinutes(survey)
    out[#out + 1] = { id = 'whole', kind = 'whole', label = 'Whole-car repair (all but the engine)', minutes = m, items = items,
      enabled = not (L and L.retired) }
    local flags = arr(survey and survey.engineFlags)
    local refuge = L and L.bivouac and L.bivouac.marathon and cfg.rally and cfg.rally.marathon and cfg.rally.marathon.engineChange == false
    out[#out + 1] = { id = 'engine', kind = 'engine', label = 'Engine change', minutes = cfg.bivouac.engineChangeMin,
      penaltyS = cfg.bivouac.engineChangePenaltyS, engineFlags = flags, damage = #flags > 0 and 1 or gdmg(survey, 'engine'),
      enabled = not (L and L.retired) and not refuge, why = refuge and 'no engine change at a marathon refuge' or nil }
  end
  return out
end

------------------------------------------------------------------------------------------------------------------
-- UI state
function M.state()
  if not L then M.loadLedger() end
  local s, mode = S(), M.mode()
  local st = { open = R.open, mode = mode, busy = R.busy and R.busy.what or nil, msg = R.msg, stopped = stopped(),
    survey = R.survey and { ok = R.survey.ok, corners = R.survey.corners, deflated = R.survey.deflated, engineFlags = R.survey.engineFlags } or nil,
    options = M.options(mode, R.survey), rallyId = L.id, retired = L.retired,
    resumes = { rally = #L.resumes, max = cfg.resume.maxPerRally, stage = s and s.repair and s.repair.resumes or 0, maxStage = cfg.resume.maxPerStage },
    spares = { used = s and s.repair and s.repair.spares or 0, max = cfg.stage.sparesPerStage }, blocked = R.blocked }
  if L.bivouac then
    local b = L.bivouac
    st.bivouac = { open = b.open, afterStage = b.afterStage, usedMin = b.usedMin, budgetMin = b.budgetMin,
      leftMin = b.budgetMin - b.usedMin, overMin = math.max(0, b.usedMin - b.budgetMin),
      retireOverMin = cfg.bivouac.retireAfterMinOver, engineChanges = b.engineChanges }
  end
  if s and s.repair then
    local last = s.repair.log[#s.repair.log]
    st.repairTimeS = s.repair.timeS
    st.last = last and { label = last.label, minutes = last.minutes } or nil
  end
  return st
end
function M.push() if H.ui then H.ui('RallyRaidRepair', M.state()) end end

------------------------------------------------------------------------------------------------------------------
-- the menu
function M.requestSurvey()
  R.req = R.req + 1
  R.surveyReq = R.req
  vehCall('survey', R.req)
end
function M.openMenu()
  R.open, R.msg = true, nil
  if M.mode() == 'none' then
    R.msg = (L and L.retired) and 'Retired from the rally.' or 'No repairs here: run a stage (mid-stage repairs) or finish one (bivouac).'
  else M.requestSurvey() end
  local on = H.appOn and H.appOn('gps')           -- 18 Nov: the repair menu is the GPS app's REPAIR panel
  if on == nil then on = R.appSeen end
  if not on then notify(H.appHint and H.appHint('gps') or 'rally.raid Earth: add the "rally.raid Earth GPS" app (UI Apps) to see the repair menu.', 8) end
  log_('I', 'repair menu opened (' .. M.mode() .. ', GPS app ' .. (on and 'on screen' or 'NOT on screen') .. ')')
  M.push()
end
function M.closeMenu() R.open = false; M.push() end
function M.toggleMenu() if R.open then M.closeMenu() else M.openMenu() end end

-- the console lines for the in-game tests (18 Nov): what was asked, which call, the car before / after
local function kv(t)
  if type(t) ~= 'table' then return tostring(t) end
  local ks = {}
  for k in pairs(t) do ks[#ks + 1] = k end
  table.sort(ks, function(a, b) return tostring(a) < tostring(b) end)
  local o = {}
  for _, k in ipairs(ks) do local x = t[k]; o[#o + 1] = tostring(k) .. '=' .. (type(x) == 'table' and ('{' .. kv(x) .. '}') or tostring(x)) end
  return table.concat(o, ' ')
end
local function list(t) local o = {}; for _, x in ipairs(type(t) == 'table' and t or {}) do o[#o + 1] = tostring(x) end; return #o > 0 and table.concat(o, ',') or 'none' end
M._kv = kv
function M.damageSummaryOf(measured)
  local out = {}
  for g, byC in pairs(type(measured) == 'table' and measured or {}) do
    local w = 0
    for _, e in pairs(byC) do w = math.max(w, tonumber(e.damage) or 0) end
    out[g] = math.floor(w * 1000 + 0.5) / 1000
  end
  return out
end
-- ask the car for a damage report (broken / deformed beams, flat tyres, damage per group): logged when it answers
function M.carReport(tag, reqId) return vehCall('report', "'" .. tostring(tag):gsub("'", '') .. "'", reqId or 0) end
local function logReport(d)
  if not d.ok then log_('W', 'car report (' .. tostring(d.tag) .. '): no answer (' .. tostring(d.why) .. ')') return end
  log_('I', string.format('car report (%s): broken beams %s, deformed beams %s, flat tyres %s, upright %.2f, engine flags %s, damage {%s}',
    tostring(d.tag), tostring(d.broken), tostring(d.deformed), list(d.deflated), tonumber(d.upZ) or 0, list(d.engineFlags), kv(d.damage)))
end

-- answers from the vehicle half
function M.reply(d)
  if type(d) ~= 'table' then return end
  if d.kind == 'carReport' then logReport(d)
  elseif d.kind == 'check' then
    log_(#(d.flatAgain or {}) > 0 and 'W' or 'I', string.format('repair %s, 1 s later: flat tyres %s, a changed tyre flat again: %s, broken beams in the repaired parts: %s',
      tostring(d.reqId), list(d.deflated), list(d.flatAgain), tostring(d.brokenInRepaired)))
    if #(d.flatAgain or {}) > 0 then notify('rally.raid Earth: the new tyre (' .. list(d.flatAgain) .. ') went flat again right after the change. Please send the console log (~).', 8) end
  elseif d.kind == 'survey' then
    if d.reqId == R.surveyReq then R.survey = d end
  elseif d.kind == 'ready' then
    if R.busy and R.busy.reqId == d.reqId then
      if not d.ok then R.msg = 'Repair failed: ' .. tostring(d.why); log_('E', 'repair ' .. d.reqId .. ' failed in the car: ' .. tostring(d.why)); R.busy = nil
      else
        R.busy.phase = 'reset'
        R.expect = { reqId = d.reqId, untilT = R.t + cfg.resume.expectResetS, vehId = M.game.vehId() }
        log_('I', string.format('repair %s ready: wheels changed %s, flat tyres before %s; kept for after the reset: %s; damage before {%s}',
          tostring(d.reqId), list(d.wheelsChanged), list(d.deflatedBefore), kv(d.prep), kv(d.damageBefore)))
        local ok, how, err = M.game.resetInPlace()
        log_(ok and 'I' or 'E', 'repair ' .. d.reqId .. ': reset in place with ' .. tostring(how or '?') .. (ok and '' or (' FAILED: ' .. tostring(err))))
        if not ok then R.msg = 'Repair failed: the car could not be reset.'; R.busy, R.expect = nil, nil; M.game.send('if ' .. M.VEH_EXT .. ' then ' .. M.VEH_EXT .. '.cancel() end') end
      end
    end
  elseif d.kind == 'done' then
    if R.busy and R.busy.reqId == d.reqId then
      local b = R.busy
      R.busy = nil
      if d.ok then
        log_('I', string.format('repair %s done (%s): put back %s; flat tyres now %s; engine flags not restored %s; damage after {%s}',
          tostring(d.reqId), tostring(b.what), kv(d.stats), list(d.deflatedAfter), list(d.engineFlagsNotRestored), kv(M.damageSummaryOf(d.after))))
        M.commit(b, d)
        M.carReport('after repair ' .. d.reqId, d.reqId)
      else R.msg = 'Repair failed: ' .. tostring(d.why); log_('E', 'repair ' .. d.reqId .. ' failed after the reset: ' .. tostring(d.why)) end
      M.requestSurvey()
    end
  end
  M.push()
end

-- confirm a selection: ids is a comma list ('wheel:FL,radiator') or a table of ids
function M.confirm(ids)
  if type(ids) == 'string' then local t = {}; for id in ids:gmatch('[^,%s]+') do t[#t + 1] = id end; ids = t end
  ids = ids or {}
  local mode = M.mode()
  local function refuse(why) R.msg = why; notify('rally.raid Earth: ' .. why, 4); M.push(); return false, why end
  if R.busy then return refuse('a repair is already running') end
  if H.resumeBusy and H.resumeBusy() then return refuse('a car recovery or resume is running') end
  if mode == 'none' then return refuse('no repairs here (not in a stage or a bivouac)') end
  if L and L.retired and mode == 'bivouac' then return refuse('retired from the rally') end
  if not stopped() then return refuse('stop the car first') end
  if #ids == 0 then return refuse('nothing selected') end
  local byId = {}
  for _, o in ipairs(M.options(mode, R.survey)) do byId[o.id] = o end
  local chosen, minutes, wheels, labels, parts = {}, 0, 0, {}, {}
  for _, id in ipairs(ids) do
    local o = byId[id]
    if not o then return refuse('unknown repair ' .. tostring(id)) end
    if not o.enabled then return refuse(o.label .. ': ' .. tostring(o.why or 'not allowed')) end
    chosen[#chosen + 1] = o
    minutes = minutes + o.minutes
    labels[#labels + 1] = o.label
    if o.spare then wheels = wheels + 1 end
    if o.group then parts[#parts + 1] = { group = o.group, corner = o.corner } end
  end
  if wheels > sparesLeft() then return refuse('only ' .. sparesLeft() .. ' spare wheel(s) left on this stage') end
  local spec
  if mode == 'stage' then spec = { parts = parts }
  else
    local whole, engine = false, false
    for _, o in ipairs(chosen) do if o.kind == 'whole' then whole = true elseif o.kind == 'engine' then engine = true end end
    if whole then spec = { allExcept = engine and {} or { 'engine' }, engine = engine }
    else spec = { parts = { { group = 'engine' } }, engine = true } end
  end
  R.req = R.req + 1
  R.busy = { reqId = R.req, mode = mode, chosen = chosen, minutes = minutes, wheels = wheels, spec = spec,
    what = table.concat(labels, ' + '), phase = 'prepare', startedT = R.t, lat = nav().lat, lon = nav().lon }
  R.msg = nil
  log_('I', string.format('repair %d requested (%s mode): %s = %d min, %d spare wheel(s); spec {%s}', R.req, mode, R.busy.what, minutes, wheels, kv(spec)))
  M.carReport('before repair ' .. R.req, R.req)
  vehCall('prepare', spec, R.req)
  M.push()
  return true
end

-- a repair finished in the car: log it and charge it
function M.commit(b, d)
  local s = S()
  local n = nav()
  local entry = { t = s and s.clock or nil, at = now(), phase = b.mode, label = b.what, items = {}, minutes = b.minutes,
    lat = b.lat or n.lat, lon = b.lon or n.lon, km = H.km and H.km() or nil,
    spec = b.spec, stats = d.stats, damageBefore = d.before, damageAfter = d.after,
    engineFlagsBefore = d.engineFlagsBefore, engineFlagsNotRestored = d.engineFlagsNotRestored }
  for _, o in ipairs(b.chosen) do entry.items[#entry.items + 1] = { id = o.id, minutes = o.minutes, damage = o.damage, flat = o.flat } end
  if b.mode == 'stage' and s then
    entry.penaltyS = b.minutes * 60
    entry.sparesUsed = b.wheels
    s.repair.spares = s.repair.spares + b.wheels
    s.repair.timeS = s.repair.timeS + entry.penaltyS
    s.repair.log[#s.repair.log + 1] = entry
    if H.addPenalty then H.addPenalty('repair', entry.penaltyS, b.what .. ' (' .. b.minutes .. ' min)') end
    notify(string.format('rally.raid Earth: %s done, +%d min.%s', b.what, b.minutes,
      b.wheels > 0 and (' Spares left: ' .. sparesLeft() .. '.') or ''), 4)
  elseif b.mode == 'bivouac' and L.bivouac then
    local bv = L.bivouac
    bv.usedMin = bv.usedMin + b.minutes
    for _, o in ipairs(b.chosen) do if o.kind == 'engine' then bv.engineChanges = bv.engineChanges + 1 end end
    entry.bivouacUsedMin = bv.usedMin
    bv.log[#bv.log + 1] = entry
    M.saveLedger()
    local over = bv.usedMin - bv.budgetMin
    notify(string.format('rally.raid Earth: %s done (%d min). Bivouac time used %d of %d min%s.', b.what, b.minutes, bv.usedMin, bv.budgetMin,
      over > 0 and string.format(': %d min over (+%d min penalty%s)', over, over, over > cfg.bivouac.retireAfterMinOver and ', RETIRED when you leave' or '') or ''), 6)
  end
  if H.hook then H.hook('onRallyRaidRepair', entry) end
  R.lastEntry = entry
end

------------------------------------------------------------------------------------------------------------------
-- the resume / reset budget, shared by resets the app did not make and RECOVER CAR (kind = 'unauthorizedReset' |
-- 'carRecovery'; a game-crash resume only when repairConfig gameCrashResume.shareRecoveryBudget is on)
-- returns { allowed, penaltyS, retire, reason, entry }
function M.countResume(kind, info)
  if not L then M.loadLedger() end
  info = info or {}
  local s = S()
  local rc = cfg.resume
  local stageN = s and s.repair and s.repair.resumes or 0
  local rallyN = #L.resumes
  local entry = { kind = kind, at = now(), t = s and s.clock or nil, stageId = s and s.stage.id or nil, lat = info.lat, lon = info.lon,
    km = info.km, distToFinishM = info.distToFinishM, stageCount = stageN + 1, rallyCount = rallyN + 1 }
  local reason
  if stageN + 1 > rc.maxPerStage then reason = 'second resume on this stage'
  elseif rallyN + 1 > rc.maxPerRally then reason = 'more than ' .. rc.maxPerRally .. ' resumes in the rally'
  elseif info.distToFinishM and info.distToFinishM < rc.noResumeNearFinishM then reason = 'within ' .. rc.noResumeNearFinishM .. ' m of the ASS' end
  entry.penaltyS = (not reason) and (rallyN == 0 and rc.firstPenaltyS or rc.laterPenaltyS) or 0
  entry.outcome = reason and 'retired' or 'penalty'
  entry.reason = reason
  L.resumes[#L.resumes + 1] = entry
  if s and s.repair then s.repair.resumes = stageN + 1; s.repair.resumesLog[#s.repair.resumesLog + 1] = entry end
  M.saveLedger()
  return { allowed = not reason, penaltyS = entry.penaltyS, retire = reason ~= nil, reason = reason, entry = entry }
end

------------------------------------------------------------------------------------------------------------------
-- resets
function M.expectReset(what) R.expect = { what = what or 'app', untilT = R.t + cfg.resume.expectResetS, vehId = M.game.vehId() } end

function M.onVehicleResetted(vehId)
  if not L then M.loadLedger() end
  local pid = M.game.vehId()
  if vehId ~= nil and pid ~= nil and vehId ~= pid then return 'other' end
  if R.expect and R.t <= R.expect.untilT then R.expect = nil; return 'ours' end
  R.expect = nil
  local s, n = S(), nav()
  if s and s.phase == 'running' then
    local ass = s.stage.waypoints[#s.stage.waypoints]
    local dFin = (n.lat and ass) and geo.dist(n.lat, n.lon, ass.lat, ass.lon) or nil
    local r = M.countResume('unauthorizedReset', { lat = n.lat, lon = n.lon, km = H.km and H.km() or nil, distToFinishM = dFin and math.floor(dFin) or nil })
    s.repair.resets[#s.repair.resets + 1] = r.entry
    s.flags.unauthorizedReset = (s.flags.unauthorizedReset or 0) + 1
    if r.retire then
      notify('rally.raid Earth: reset not made by the repair menu (' .. r.reason .. '): STAGE RETIRED.', 8)
      if H.retireStage then H.retireStage('unauthorized reset: ' .. r.reason) end
    else
      if H.addPenalty then H.addPenalty('resume', r.penaltyS, 'reset not made by the repair menu (counts as recovery / reset ' .. r.entry.rallyCount .. '/' .. cfg.resume.maxPerRally .. ')') end
      notify(string.format('rally.raid Earth: reset not made by the repair menu: counts as recovery / reset %d of %d, +%d min.', r.entry.rallyCount, cfg.resume.maxPerRally, r.penaltyS / 60), 8)
    end
    M.push()
    return r.retire and 'retired' or 'counted'
  end
  if L.bivouac and L.bivouac.open then
    local e = { at = now(), lat = n.lat, lon = n.lon, stageLoaded = s and s.stage.id or nil }
    L.bivouac.resets[#L.bivouac.resets + 1] = e
    M.saveLedger()
    notify('rally.raid Earth: reset during the bivouac: logged in the next stage result.', 5)
    return 'bivouac'
  end
  return 'free'
end

------------------------------------------------------------------------------------------------------------------
-- stage life cycle (called by core)
function M.stageStarted()
  if not L then M.loadLedger() end
  local s = S()
  if not s then return end
  s.repair = { spares = 0, timeS = 0, log = {}, resets = {}, resumes = 0, resumesLog = {} }
  if M.game.iprLoaded() then
    s.flags.ipr = true
    notify('rally.raid Earth: the Individual Part Repair mod is loaded: this run is marked unofficial.', 8)
  end
  -- leaving the bivouac: overrun and engine-change penalties go onto this stage
  local b = L.bivouac
  if b and b.open then
    b.open = false
    b.closedAt = now()
    b.nextStage = s.stage.id
    b.overMin = math.max(0, b.usedMin - b.budgetMin)
    b.overrunPenaltyS = b.overMin * cfg.bivouac.penaltyPerMinLate
    b.engineChangePenaltyS = b.engineChanges * cfg.bivouac.engineChangePenaltyS
    b.retired = b.overMin > cfg.bivouac.retireAfterMinOver
    if H.addPenalty then
      if b.overrunPenaltyS > 0 then H.addPenalty('bivouacOverrun', b.overrunPenaltyS, string.format('bivouac %d min over the %d min budget', b.overMin, b.budgetMin)) end
      if b.engineChangePenaltyS > 0 then H.addPenalty('engineChange', b.engineChangePenaltyS, b.engineChanges .. ' engine change(s) at the bivouac') end
    end
    if b.retired and not L.retired then
      L.retired = { reason = string.format('bivouac %d min over budget (limit %d)', b.overMin, cfg.bivouac.retireAfterMinOver), at = now(), stage = s.stage.id }
      notify('rally.raid Earth: RETIRED from the rally: ' .. L.retired.reason .. '. This stage runs unofficial.', 10)
    end
    if #b.resets > 0 then s.flags.bivouacResets = #b.resets end
    L.bivouacs[#L.bivouacs + 1] = b
    L.bivouac = nil
    s.repair.bivouac = b
  end
  if L.retired then s.flags.rallyRetired = true end
  L.stages[#L.stages + 1] = { id = s.stage.id, startedAt = now() }
  M.saveLedger()
  M.updateBlocking(); M.push()
end

function M.stageFinished(res)
  if not L then M.loadLedger() end
  local s = S()
  -- the bivouac opens after every stage, retired or not (the car can only be fixed there), unless the rally is over
  if s and not L.retired then
    L.bivouac = { open = true, afterStage = s.stage.id, openedAt = now(), usedMin = 0, budgetMin = cfg.bivouac.budgetMin,
      engineChanges = 0, log = {}, resets = {} }
    notify(string.format('rally.raid Earth: bivouac open: %d h of service time (MENU > REPAIR in the GPS app%s). It closes when the next stage starts.', cfg.bivouac.budgetMin / 60, keys.hint('rallyRaid_repairMenu', ', or %s')), 7)
  end
  local last = L.stages[#L.stages]
  if last and s and last.id == s.stage.id then last.finishedAt = now(); last.retired = res and res.retired or nil; last.totalTime = res and res.totalTime end
  M.saveLedger()
  M.updateBlocking(); M.push()
end

function M.stageChanged() M.updateBlocking(); M.push() end

-- RALLY MODE (rallyRaid/rally.lua): the open bivouac's budget. opts: addMin (unused liaison allowance, rest day),
-- marathon (true: the refuge budget replaces the normal one, engine change refused), reason (logged).
-- Returns the bivouac table or nil when none is open.
function M.rallyBivouac(opts)
  if not L then M.loadLedger() end
  local b = L.bivouac
  if not (b and b.open) then return nil end
  opts = opts or {}
  b.rally = b.rally or { adds = {} }
  if opts.marathon and not b.marathon then
    b.marathon = true
    b.budgetMin = (cfg.rally and cfg.rally.marathon and cfg.rally.marathon.budgetMin) or b.budgetMin
    b.rally.adds[#b.rally.adds + 1] = { min = 0, reason = 'marathon refuge: budget ' .. b.budgetMin .. ' min', at = now() }
  end
  local add = tonumber(opts.addMin) or 0
  if add > 0 and not (b.marathon and cfg.rally and cfg.rally.marathon and cfg.rally.marathon.addLeftover == false and opts.kind == 'leftover') then
    b.budgetMin = b.budgetMin + add
    b.rally.adds[#b.rally.adds + 1] = { min = add, reason = opts.reason or 'rally', at = now() }
  end
  M.saveLedger(); M.push()
  return b
end

-- what goes into the stage result
function M.resultFields(s)
  if not L then M.loadLedger() end
  local r = s.repair or { log = {}, resets = {}, resumesLog = {}, spares = 0, timeS = 0 }
  return {
    repairs = r.log, repairTime = r.timeS, sparesUsed = r.spares,
    resets = r.resets,
    resumes = { stage = r.resumes or 0, rally = #L.resumes, maxPerRally = cfg.resume.maxPerRally, maxPerStage = cfg.resume.maxPerStage, log = r.resumesLog },
    bivouac = r.bivouac,
    rally = { id = L.id, retired = L.retired },
    repairRules = { version = cfg.version, stage = copy(cfg.stage), bivouac = { budgetMin = cfg.bivouac.budgetMin,
      penaltyPerMinLate = cfg.bivouac.penaltyPerMinLate, retireAfterMinOver = cfg.bivouac.retireAfterMinOver,
      engineChangeMin = cfg.bivouac.engineChangeMin, engineChangePenaltyS = cfg.bivouac.engineChangePenaltyS }, resume = copy(cfg.resume) },
  }
end

------------------------------------------------------------------------------------------------------------------
function M.update(dt)
  R.t = R.t + (dt or 0)
  -- keep the app current (speed decides whether REPAIR is allowed): twice a second with the menu open, else every 2 s
  R.pushAcc = (R.pushAcc or 0) + (dt or 0)
  if R.pushAcc >= (R.open and 0.5 or 2) then R.pushAcc = 0; M.push() end
  if R.expect and R.t > R.expect.untilT then R.expect = nil end
  if R.busy and R.t - R.busy.startedT > cfg.resume.expectResetS + 3 then
    R.msg = 'Repair failed: the car did not answer (no time was charged).'
    log_('W', 'repair timed out: ' .. tostring(R.busy.what))
    M.game.send('if ' .. M.VEH_EXT .. ' then ' .. M.VEH_EXT .. '.cancel() end')
    R.busy = nil
    M.push()
  end
end

-- commands from the UI / keys (core.cmd('repair<Sub>', arg))
function M.cmd(sub, arg)
  if sub == 'Menu' then M.toggleMenu()
  elseif sub == 'Open' then M.openMenu()
  elseif sub == 'Close' then M.closeMenu()
  elseif sub == 'Survey' then M.requestSurvey(); M.push()
  elseif sub == 'Confirm' then M.confirm(arg)
  elseif sub == 'AppHere' then R.appSeen = true; M.push()
  elseif sub == 'NewRally' then M.newRally()
  else log_('W', 'unknown repair command ' .. tostring(sub)) end
end

function M.init(hooks) H = hooks or {}; M.loadLedger() end
function M._R() return R end
function M._reset() L = nil; R = { open = false, survey = nil, req = 0, busy = nil, expect = nil, msg = nil, appSeen = false, t = 0, blocked = false } end

return M
