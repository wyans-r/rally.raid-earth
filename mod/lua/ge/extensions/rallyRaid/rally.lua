-- rally.raid Earth: RALLY MODE (EXPERIMENTAL, B10). Runs a multi-day rally file (docs/RALLY_FORMAT.md) day by day:
--   start bivouac -> liaison out (DRIVE against the allowance, or TELEPORT = the whole allowance used) -> the special
--   stage (the normal rally computer in core.lua) -> liaison in (drive or teleport) -> bivouac (repair.lua; unused
--   liaison allowance is added to its budget, a marathon refuge gets the short budget) -> next day.
-- Rest days add service time; a transfer is a liaison only (a sea crossing is teleport only).
-- Rally total = the stage totals (stage time + stage penalties) + liaison late penalties.
-- Progress is saved in /rallyraid/rally/rally_<id>.json, so a rally can be continued after a restart.
-- UI: guihook 'RallyRaidRally' (the RALLY panel in the rally.raid Earth GPS app: MENU > RALLY). Commands: rallyRaid_core.cmd('rally<Sub>', arg) with
-- List, Load (path), Start, Drive, Teleport, CheckIn, LoadStage, TpDss, NextDay, Restart, Close, AppHere.
-- No default keys (only 9 default keys are allowed): buttons in the app only.
-- Every tunable value: repairConfig.lua M.rally.
local cfgAll = require('rallyRaid/repairConfig')
local geo = require('rallyRaid/geo')

local M = {}
M.DIR = '/rallyraid/rallies/'
M.PROGRESS_DIR = '/rallyraid/rally/'
M.FORMAT = 'rallyraid-rally'
M.SCHEMA = 1
M.EXPERIMENTAL = true

local H = {}      -- hooks from core: api(), notify(t, s), ui(name, data), loadStage(path) -> ok, teleportToStart() -> ok,
                  -- S() (the loaded stage state), nav() ({lat, lon, ok}), repair (module), log(level, msg)
local R = { rally = nil, path = nil, P = nil, liaison = nil, msg = nil, list = nil, t = 0, pushAcc = 0 }

local function cfg() return cfgAll.rally or {} end
local function now() return os.date('!%Y-%m-%dT%H:%M:%SZ') end
local function notify(t, s) if H.notify then H.notify('rally.raid Earth: ' .. t, s or 5) end end
local function log_(l, m) if H.log then H.log(l, 'rally: ' .. m) end end
local function arr(x) if type(x) ~= 'table' then return {} end if #x > 0 or next(x) == nil then return x end
  local ks = {} for k in pairs(x) do if tonumber(k) then ks[#ks + 1] = tonumber(k) end end table.sort(ks)
  local out = {} for _, k in ipairs(ks) do out[#out + 1] = x[k] or x[tostring(k)] end return out end
local function readJson(path)
  local read = rawget(_G, 'jsonReadFile'); if not read then return nil, 'jsonReadFile missing' end
  local ok, d = pcall(read, path); if not ok or type(d) ~= 'table' then return nil, tostring(d) end
  return d
end
local function writeJson(path, d) local w = rawget(_G, 'jsonWriteFile'); if w then pcall(w, path, d, true) end end
local function dirOf(p) return (tostring(p):match('^(.*/)') or '/') end

-- allowance in minutes (the rally file carries it; this is the same rule for a file without it)
function M.allowanceMin(km)
  local c = cfg(); km = tonumber(km) or 0
  if km <= 0 then return 0 end
  local r = c.liaisonRoundMin or 5
  return math.ceil((km / (c.liaisonKmh or 60) * 60 + (c.liaisonExtraMin or 30)) / r) * r
end

------------------------------------------------------------------------------------------------------------------
-- rally files
function M.normalize(r)
  local e = {}
  if type(r) ~= 'table' then return nil, { 'not a JSON object' } end
  if r.format ~= M.FORMAT then e[#e + 1] = 'format is not ' .. M.FORMAT end
  if (tonumber(r.schemaVersion) or 0) > M.SCHEMA then e[#e + 1] = 'schemaVersion ' .. tostring(r.schemaVersion) .. ' is newer than this mod understands' end
  r.days, r.bivouacs = arr(r.days), arr(r.bivouacs)
  if #r.days == 0 then e[#e + 1] = 'no days' end
  r.biv = {}
  for _, b in ipairs(r.bivouacs) do r.biv[b.id] = b end
  for i, d in ipairs(r.days) do
    if not (r.biv[d.from] and r.biv[d.to]) then e[#e + 1] = 'day ' .. i .. ': unknown bivouac' end
    if (d.type == 'stage' or d.type == 'marathon') and not (type(d.stage) == 'table' and d.stage.file) then e[#e + 1] = 'day ' .. i .. ': no stage file' end
    for _, k in ipairs({ 'liaisonOut', 'liaisonIn' }) do
      local l = d[k]
      if type(l) == 'table' and l.allowanceMin == nil then l.allowanceMin = M.allowanceMin(l.km) end
    end
  end
  if #e > 0 then return nil, e end
  return r
end
function M.list()
  local out = {}
  if not (FS and FS.findFiles) then return out end
  local ok, files = pcall(function() return FS:findFiles(M.DIR, '*.rally.json', 0, true, false) end)
  if not ok or not files then return out end
  for _, p in ipairs(files) do
    local d = readJson(p)
    if d and d.format == M.FORMAT then out[#out + 1] = { path = p, id = d.id, name = d.name, days = #arr(d.days), startDate = d.startDate, disclaimer = d.disclaimer } end
  end
  table.sort(out, function (a, b) return tostring(a.startDate or a.name) < tostring(b.startDate or b.name) end)
  return out
end
local function progressPath(id) return M.PROGRESS_DIR .. 'rally_' .. tostring(id):gsub('[^%w%-_]', '_') .. '.json' end
local function newProgress(r)
  local P = { format = 'rallyraid-rally-progress', schemaVersion = 1, rallyId = r.id, rallyName = r.name, startedAt = now(), day = 1, phase = 'start',
    days = {}, totalS = 0, stageS = 0, penaltyS = 0, liaisonPenaltyS = 0, rules = cfg() }
  for i = 1, #r.days do P.days[i] = {} end
  return P
end
function M.save() if R.rally and R.P then writeJson(progressPath(R.rally.id), R.P) end end

function M.load(path)
  local d, err = readJson(path)
  if not d then R.msg = 'cannot read ' .. tostring(path) .. ': ' .. tostring(err); M.push(); return false end
  local r, errs = M.normalize(d)
  if not r then R.msg = 'not a rally file: ' .. table.concat(errs, '; '); notify(R.msg, 8); M.push(); return false end
  R.rally, R.path = r, path
  local P = readJson(progressPath(r.id))
  if P and P.format == 'rallyraid-rally-progress' and P.rallyId == r.id then P.days = arr(P.days); for i = 1, #r.days do P.days[i] = P.days[i] or {} end R.P = P
  else R.P = newProgress(r) end
  R.liaison = nil; R.msg = nil
  notify(r.name .. ' loaded (EXPERIMENTAL). ' .. (r.disclaimer or ''), 8)
  M.save(); M.push()
  return true
end
function M.restart()
  if not R.rally then return end
  R.P = newProgress(R.rally); R.liaison = nil
  if H.repair and H.repair.newRally then H.repair.newRally() end   -- a fresh resume / reset budget and no open bivouac
  M.save(); M.push()
end

------------------------------------------------------------------------------------------------------------------
-- the day machine
local function day() return R.rally and R.rally.days[R.P.day] end
local function dp() return R.P.days[R.P.day] end
local function stagePath(d) return dirOf(R.path) .. d.stage.file end
local function recompute()
  local st, pen, lz = 0, 0, 0
  for _, x in ipairs(R.P.days) do
    if x.stage then st = st + (x.stage.stageTime or 0); pen = pen + (x.stage.penaltyTime or 0) end
    for _, k in ipairs({ 'liaisonOut', 'liaisonIn' }) do if x[k] then lz = lz + (x[k].penaltyS or 0) end end
  end
  R.P.stageS, R.P.penaltyS, R.P.liaisonPenaltyS, R.P.totalS = st, pen, lz, st + pen + lz
end
local function bivouacAdd(min, reason, kind)
  local c = cfg()
  if not (c.leftoverToBivouac ~= false or kind ~= 'leftover') then return end
  min = math.min(min or 0, kind == 'leftover' and (c.maxLeftoverMin or 240) or 1e9)
  if min <= 0 or not (H.repair and H.repair.rallyBivouac) then return 0 end
  local d = day()
  local refuge = d and R.rally.biv[d.to] and R.rally.biv[d.to].kind == 'marathon'
  local b = H.repair.rallyBivouac({ addMin = min, reason = reason, kind = kind, marathon = refuge })
  if b then return min end
  -- no bivouac open yet (liaison out leftover before the ASS): kept for when it opens
  local x = dp(); x.pendingBivouacMin = (x.pendingBivouacMin or 0) + min
  return 0
end

-- start a liaison: which = 'out' | 'in'; mode = 'drive' | 'teleport'
local function liaisonTarget(d, which)
  if which == 'out' and d.stage then
    local s = d.stage.dss or {}
    return { lat = tonumber(s.lat), lon = tonumber(s.lon), name = 'DSS ' .. (d.stage.name or d.code or ''), radius = cfg().arriveRadiusM or 300 }
  end
  local b = R.rally.biv[d.to]
  return { lat = tonumber(b.lat), lon = tonumber(b.lon), name = b.name, radius = cfg().bivouacRadiusM or 1500 }
end
local function finishLiaison(how)
  local L = R.liaison; if not L then return end
  local d, x, c = day(), dp(), cfg()
  local allowS = L.allowanceMin * 60
  local usedS = L.mode == 'teleport' and (c.teleportUsesAllowance ~= false and allowS or 0) or L.elapsedS
  local lateMin = math.max(0, math.ceil((usedS - allowS) / 60 - 1e-9))
  local leftover = math.max(0, math.floor((allowS - usedS) / 60))
  local rec = { mode = L.mode, km = L.km, allowanceMin = L.allowanceMin, elapsedS = math.floor(usedS + 0.5), lateMin = lateMin,
    penaltyS = lateMin * (c.latePenaltyPerMinS or 60), leftoverMin = leftover, how = how, at = now() }
  x[L.which == 'out' and 'liaisonOut' or 'liaisonIn'] = rec
  R.liaison = nil
  if lateMin > 0 then notify(string.format('liaison %d min late: +%d min penalty.', lateMin, rec.penaltyS / 60), 6)
  elseif L.mode == 'drive' then notify(string.format('liaison done with %d min to spare%s.', leftover, (c.leftoverToBivouac ~= false and leftover > 0) and ' (added to the bivouac)' or ''), 6) end
  if leftover > 0 then
    -- way out to a stage: last night's bivouac is still open until the stage starts, so this waits for tonight's (at the ASS)
    if L.which == 'out' and d.stage then x.pendingBivouacMin = (x.pendingBivouacMin or 0) + leftover; rec.toBivouacMin = 0
    else rec.toBivouacMin = bivouacAdd(leftover, 'unused liaison allowance (' .. (d.code or '') .. ' ' .. L.which .. ')', 'leftover') end
  end
  recompute()
  if L.which == 'out' then
    R.P.phase = d.stage and 'stage' or 'bivouac'
    if not d.stage then x.done = true end
  else
    R.P.phase = 'bivouac'; x.done = true
  end
  M.save(); M.push()
end
function M.startLiaison(mode)
  local d = day(); if not d then return false end
  local which = (R.P.phase == 'start') and 'out' or (R.P.phase == 'liaisonInChoice' and 'in' or nil)
  if not which then R.msg = 'no liaison to start now'; M.push(); return false end
  local l = which == 'out' and d.liaisonOut or d.liaisonIn
  if not l then R.P.phase = which == 'out' and (d.stage and 'stage' or 'bivouac') or 'bivouac'; M.push(); return true end
  if mode == 'drive' and l.drive == false then R.msg = 'this liaison cannot be driven (' .. (l.ferry and 'sea crossing' or 'teleport only') .. ')'; M.push(); return false end
  local tgt = liaisonTarget(d, which)
  R.liaison = { which = which, mode = mode, km = l.km, allowanceMin = l.allowanceMin or M.allowanceMin(l.km), elapsedS = 0, target = tgt, startedAt = now() }
  local a = H.api and H.api()
  if which == 'out' and d.stage then
    local ok = H.loadStage and H.loadStage(stagePath(d))
    if not ok then R.liaison = nil; R.msg = 'the stage file did not load: ' .. tostring(d.stage.file); M.push(); return false end
    dp().stageLoaded = true
  end
  if mode == 'teleport' then
    if which == 'out' and d.stage then if H.teleportToStart then H.teleportToStart() end
    elseif a and a.teleport and tgt.lat then a.teleport(tgt.lat, tgt.lon, 'rally.raid Earth: ' .. tgt.name) end
    finishLiaison('teleport')
  else
    -- drive: from the start point (the bivouac, or the ASS for the way in); teleport there first if the car is far
    local from = which == 'out' and R.rally.biv[d.from] or (d.stage and d.stage.ass) or R.rally.biv[d.from]
    local n = H.nav and H.nav() or {}
    if from and a and a.teleport and n.lat and geo.dist(n.lat, n.lon, from.lat, from.lon) > (cfg().driveStartMaxKm or 5) * 1000 then
      if H.repair and H.repair.expectReset then H.repair.expectReset('teleport') end
      a.teleport(from.lat, from.lon, 'rally.raid Earth: liaison start')
    end
    R.P.phase = which == 'out' and 'liaisonOut' or 'liaisonIn'
    notify(string.format('liaison %s: %d km, allowance %d min. Drive to %s.', which, l.km or 0, R.liaison.allowanceMin, tgt.name), 7)
  end
  M.save(); M.push()
  return true
end

-- core hooks
function M.stageStarted()
  if R.liaison and R.liaison.which == 'out' then finishLiaison('stage clock started') end
  if R.rally and day() and day().stage then R.P.phase = 'stage'; M.save() end
end
function M.stageFinished(res)
  if not (R.rally and day() and day().stage) then return end
  local s = H.S and H.S()
  if not (s and s.stage and s.stage.id == day().stage.id) then return end
  local x, d = dp(), day()
  x.stage = { stageTime = res and res.stageTime or 0, penaltyTime = res and res.penaltyTime or 0, totalTime = res and res.totalTime or 0, retired = res and res.retired or nil, at = now() }
  recompute()
  -- the bivouac opened at the ASS (repair.lua): refuge budget, and the liaison-out leftover kept until now
  local refuge = R.rally.biv[d.to] and R.rally.biv[d.to].kind == 'marathon'
  if H.repair and H.repair.rallyBivouac then
    H.repair.rallyBivouac({ marathon = refuge, addMin = x.pendingBivouacMin or 0, reason = 'unused liaison allowance (' .. (d.code or '') .. ' out)', kind = 'leftover' })
    x.pendingBivouacMin = nil
  end
  R.P.phase = d.liaisonIn and 'liaisonInChoice' or 'bivouac'
  M.save(); M.push()
end
function M.nextDay()
  if not R.rally then return end
  local d = day()
  if R.P.phase ~= 'bivouac' and R.P.phase ~= 'rest' and not (d and d.type == 'rest') then R.msg = 'finish this day first'; M.push(); return end
  if d then dp().done = true end
  if R.P.day >= #R.rally.days then R.P.phase = 'finished'; R.P.finishedAt = now(); M.writeResult(); M.save(); M.push(); return end
  R.P.day = R.P.day + 1
  local nd = day()
  if nd.type == 'rest' then
    R.P.phase = 'rest'
    local add = cfg().restDayBonusMin or 0
    if add > 0 and H.repair and H.repair.rallyBivouac then
      if H.repair.rallyBivouac({ addMin = add, reason = 'rest day ' .. (nd.date or ''), kind = 'rest' }) then dp().restBonusMin = add end
    end
  else R.P.phase = 'start' end
  M.save(); M.push()
end
function M.writeResult()
  local P = R.P
  writeJson('/rallyraid/results/rally_' .. tostring(R.rally.id):gsub('[^%w%-_]', '_') .. '_' .. os.date('%Y%m%d_%H%M%S') .. '.json',
    { format = 'rallyraid-rally-result', schemaVersion = 1, rallyId = R.rally.id, rallyName = R.rally.name, disclaimer = R.rally.disclaimer,
      experimental = true, finishedAt = P.finishedAt, totalS = P.totalS, stageS = P.stageS, penaltyS = P.penaltyS, liaisonPenaltyS = P.liaisonPenaltyS, days = P.days, rules = cfg() })
end

------------------------------------------------------------------------------------------------------------------
function M.update(dtReal, dtSim)
  R.t = R.t + (dtReal or 0)
  local L = R.liaison
  if L and L.mode == 'drive' then
    L.elapsedS = L.elapsedS + (dtSim or dtReal or 0)
    local n = H.nav and H.nav() or {}
    if n.lat and L.target.lat then
      L.distM = geo.dist(n.lat, n.lon, L.target.lat, L.target.lon)
      L.bearing = geo.bearing(n.lat, n.lon, L.target.lat, L.target.lon)
      if L.distM <= L.target.radius then finishLiaison('arrived') end
    end
  end
  R.pushAcc = R.pushAcc + (dtReal or 0)
  if R.pushAcc >= (R.liaison and 0.5 or 2) then R.pushAcc = 0; M.push() end
end

function M.state()
  local st = { experimental = true, loaded = R.rally ~= nil, msg = R.msg, list = R.list }
  if R.rally then
    local r = R.rally
    st.rally = { id = r.id, name = r.name, disclaimer = r.disclaimer, season = r.season, totals = r.totals, path = R.path,
      days = {}, bivouacs = r.bivouacs }
    for i, d in ipairs(r.days) do
      st.rally.days[i] = { n = d.n, date = d.date, type = d.type, code = d.code, title = d.title, from = r.biv[d.from] and r.biv[d.from].name, to = r.biv[d.to] and r.biv[d.to].name,
        marathon = d.marathon, refuge = r.biv[d.to] and r.biv[d.to].kind == 'marathon', ssKm = d.stage and (d.stage.km or d.stage.targetKm) or 0,
        liaisonOut = d.liaisonOut, liaisonIn = d.liaisonIn, progress = R.P.days[i] }
    end
    st.progress = { day = R.P.day, phase = R.P.phase, totalS = R.P.totalS, stageS = R.P.stageS, penaltyS = R.P.penaltyS, liaisonPenaltyS = R.P.liaisonPenaltyS, finishedAt = R.P.finishedAt }
    if R.liaison then local L = R.liaison
      st.liaison = { which = L.which, mode = L.mode, km = L.km, allowanceMin = L.allowanceMin, elapsedS = math.floor(L.elapsedS), leftS = math.floor(L.allowanceMin * 60 - L.elapsedS),
        distKm = L.distM and math.floor(L.distM / 100) / 10, bearing = L.bearing and math.floor(L.bearing + 0.5), target = L.target.name } end
    local b = H.repair and H.repair.state and H.repair.state().bivouac
    if b then st.bivouac = { open = b.open, leftMin = b.leftMin, budgetMin = b.budgetMin, usedMin = b.usedMin } end
  end
  return st
end
function M.push() if H.ui then H.ui('RallyRaidRally', M.state()) end end

function M.cmd(sub, arg)
  R.msg = nil
  if sub == 'List' or sub == 'AppHere' then R.list = M.list(); M.push()
  elseif sub == 'Load' then M.load(arg)
  elseif sub == 'Drive' then M.startLiaison('drive')
  elseif sub == 'Teleport' then M.startLiaison('teleport')
  elseif sub == 'CheckIn' then
    local L = R.liaison
    if L and L.mode == 'drive' and L.distM and L.distM <= L.target.radius * 2 then finishLiaison('check-in') else R.msg = 'not at ' .. (L and L.target.name or 'the target') .. ' yet'; M.push() end
  elseif sub == 'LoadStage' then local d = day(); if d and d.stage and H.loadStage then H.loadStage(stagePath(d)); dp().stageLoaded = true; M.push() end
  elseif sub == 'TpDss' then if H.teleportToStart then H.teleportToStart() end
  elseif sub == 'NextDay' then M.nextDay()
  elseif sub == 'Restart' then M.restart()
  elseif sub == 'Close' then R.rally, R.P, R.liaison, R.path = nil, nil, nil, nil; M.push()
  else log_('W', 'unknown rally command ' .. tostring(sub)) end
end

function M.init(hooks) H = hooks or {} end
function M._R() return R end
function M._reset() R = { rally = nil, path = nil, P = nil, liaison = nil, msg = nil, list = nil, t = 0, pushAcc = 0 } end
return M
