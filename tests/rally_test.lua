-- Offline test of RALLY MODE (rallyRaid/rally.lua, EXPERIMENTAL B10) with core.lua and repair.lua: a 4-day test rally on
-- the sample stage (start, transfer by sea, marathon refuge, rest day). The fake game below is the one from repair_test.lua.
-- Run: tests/run_tests.py rally_test.lua. Not tested here: the real game (see docs/RALLY_FORMAT.md, untested in game).
local MOD = MOD_ROOT .. '/lua/ge/extensions/'
package.path = MOD .. '?.lua;' .. MOD_ROOT .. '/lua/vehicle/extensions/?.lua;' .. package.path

local fails, passes = 0, 0
local function check(cond, msg) if cond then passes = passes + 1 else fails = fails + 1; print('FAIL: ' .. msg) end end
local function near(a, b, eps) return a and b and math.abs(a - b) <= (eps or 1e-6) end

-- a Lua-literal serializer (BeamNG's serialize())
local function ser(v)
  local t = type(v)
  if t == 'table' then
    local parts = {}
    for k, x in pairs(v) do
      local key = type(k) == 'number' and ('[' .. k .. ']') or ('[' .. string.format('%q', tostring(k)) .. ']')
      parts[#parts + 1] = key .. '=' .. ser(x)
    end
    return '{' .. table.concat(parts, ',') .. '}'
  elseif t == 'string' then return string.format('%q', v)
  elseif t == 'number' or t == 'boolean' then return tostring(v) end
  return 'nil'
end
serialize = ser

-- fake game environment (GE) ---------------------------------------------------------------------------------
local car = { lat = 0, lon = 0, speed = 0, ve = 0, vn = 0, heading = 0 }
local ui, events, files, notes = {}, {}, {}, {}
guihooks = { trigger = function(n, d) ui[n] = d end }
extensions = { hook = function(n, info) events[#events + 1] = { n = n, info = info } end, load = function() end,
  isExtensionLoaded = function(n) return n == 'partRepairMenu' and IPR_LOADED or false end }
log = function() end
ui_message = function(t) notes[#notes + 1] = t end
jsonReadFile = function(p) if files[p] then return files[p] end return READ_JSON(p) end
jsonWriteFile = function(p, d) files[p] = d; return true end
FS = { findFiles = function(self, dir) return LIST_FILES(dir) end }
beamngEarth_api = {
  version = function() return 1, 8 end, ready = function() return true end, rebasing = function() return false end,
  pose = function() return { lat = car.lat, lon = car.lon, speed = car.speed, ve = car.ve, vn = car.vn, heading = car.heading, camera = false } end,
  notify = function(t) notes[#notes + 1] = t; return true end,
  teleport = function(lat, lon) car.lat, car.lon = lat, lon; if TELEPORT_RESETS then RESET_NOW() end return true end,
}
local filterCalls = {}
core_input_actionFilter = {
  addAction = function(f, a, on) filterCalls[#filterCalls + 1] = { f, a, on } end,
  clear = function(f) filterCalls[#filterCalls + 1] = { f, 'CLEAR' } end,
  getActionTemplates = function() return { competitive = { 'dropPlayerAtCamera', 'slower_motion' } } end,
}
local function blockedNow()
  local on = false
  for _, c in ipairs(filterCalls) do if c[2] == 'CLEAR' then on = false elseif c[2] == 'reset_physics' then on = true end end
  return on
end

-- fake car (vehicle VM globals: v, obj, wheels, beamstate, energyStorage, damageTracker, powertrain) -------------
local VEH_ID = 4242
local parts = {
  -- part name, list of node positions (jbeam coordinates: x right, y back, so the front wheels have y < 0)
  { 'tire_F_31x10', { { -0.85, -1.3, 0.3 }, { -0.75, -1.3, 0.5 }, { -0.85, -1.2, 0.4 }, { 0.85, -1.3, 0.3 }, { 0.75, -1.3, 0.5 }, { 0.85, -1.2, 0.4 } } },
  { 'wheel_R_steel', { { -0.85, 1.4, 0.3 }, { -0.75, 1.4, 0.5 }, { 0.85, 1.4, 0.3 }, { 0.75, 1.4, 0.5 } } },
  { 'pickup_suspension_F', { { -0.6, -1.3, 0.4 }, { -0.5, -1.25, 0.5 }, { 0.6, -1.3, 0.4 }, { 0.5, -1.25, 0.5 } } },
  { 'pickup_leafspring_R', { { -0.6, 1.4, 0.4 }, { -0.5, 1.35, 0.5 }, { 0.6, 1.4, 0.4 }, { 0.5, 1.35, 0.5 } } },
  { 'radiator_v8', { { -0.3, -1.9, 0.6 }, { 0.3, -1.9, 0.6 }, { 0, -1.9, 0.9 } } },
  { 'pickup_engine_v8', { { -0.2, -1.2, 0.7 }, { 0.2, -1.2, 0.7 }, { 0, -1.0, 0.9 } } },
  { 'pickup_frame', { { -0.4, -1.8, 0.4 }, { 0.4, -1.8, 0.4 }, { -0.4, 1.8, 0.4 }, { 0.4, 1.8, 0.4 } } },
  { 'pickup_hood', { { -0.5, -1.7, 1.0 }, { 0.5, -1.7, 1.0 }, { 0, -1.2, 1.1 } } },
  { 'steering_wheel_sport', { { -0.4, -0.3, 1.0 }, { -0.35, -0.3, 1.05 } } },
}
local vdata = { nodes = {}, beams = {}, wheels = {} }
local nodeByPart, beamByPart = {}, {}
local cid = 0
for _, p in ipairs(parts) do
  nodeByPart[p[1]] = {}
  for _, pos in ipairs(p[2]) do
    vdata.nodes[cid] = { cid = cid, pos = { x = pos[1], y = pos[2], z = pos[3] }, partOrigin = p[1] }
    nodeByPart[p[1]][#nodeByPart[p[1]] + 1] = cid
    cid = cid + 1
  end
end
local bcid = 0
local function addBeam(a, b, part, extra)
  local bm = { cid = bcid, id1 = a, id2 = b, partOrigin = part }
  for k, x in pairs(extra or {}) do bm[k] = x end
  vdata.beams[bcid] = bm
  beamByPart[part] = beamByPart[part] or {}
  beamByPart[part][#beamByPart[part] + 1] = bcid
  bcid = bcid + 1
end
for _, p in ipairs(parts) do
  local ns = nodeByPart[p[1]]
  for i = 2, #ns do addBeam(ns[i - 1], ns[i], p[1], p[1] == 'radiator_v8' and { deformGroup = 'radiator_damage' } or nil) end
end
addBeam(nodeByPart['pickup_frame'][1], nodeByPart['pickup_hood'][1], 'pickup_hood')     -- a beam across two parts
-- wheels: hub nodes are the first two nodes of each corner of the suspension parts
local sF, sR = nodeByPart['pickup_suspension_F'], nodeByPart['pickup_leafspring_R']
vdata.wheels[0] = { name = 'FL', node1 = sF[1], node2 = sF[2] }
vdata.wheels[1] = { name = 'FR', node1 = sF[3], node2 = sF[4] }
vdata.wheels[2] = { name = 'RL', node1 = sR[1], node2 = sR[2] }
vdata.wheels[3] = { name = 'RR', node1 = sR[3], node2 = sR[4] }
v = { data = vdata }

local function origLen(b)
  local a, c = vdata.nodes[b.id1].pos, vdata.nodes[b.id2].pos
  return math.sqrt((a.x - c.x) ^ 2 + (a.y - c.y) ^ 2 + (a.z - c.z) ^ 2)
end
local phys = { rest = {}, broken = {}, pos = {}, commits = 0 }
local function pristine()
  for k, b in pairs(vdata.beams) do phys.rest[k] = origLen(b); phys.broken[k] = false end
  for k, n in pairs(vdata.nodes) do phys.pos[k] = { x = n.pos.x + 100, y = n.pos.y + 200, z = n.pos.z } end
end
pristine()
local veh2ge = {}
obj = {
  beamIsBroken = function(_, c) return phys.broken[c] end,
  getBeamRestLength = function(_, c) return phys.rest[c] end,
  setBeamLength = function(_, c, l) phys.rest[c] = l end,
  breakBeam = function(_, c) phys.broken[c] = true end,
  getNodePosition = function(_, c) local p = phys.pos[c]; return { x = p.x, y = p.y, z = p.z } end,
  setNodePosition = function(_, c, p) phys.pos[c] = { x = p.x, y = p.y, z = p.z } end,
  commitLoad = function() phys.commits = phys.commits + 1 end,
  queueGameEngineLua = function(_, cmd) veh2ge[#veh2ge + 1] = cmd end,
}
local wheelState = { [0] = { name = 'FL' }, [1] = { name = 'FR' }, [2] = { name = 'RL' }, [3] = { name = 'RR' } }
wheels = { wheels = wheelState }
local deflateCalls = {}
beamstate = { deflateTire = function(k) deflateCalls[#deflateCalls + 1] = k; wheelState[k].isTireDeflated = true end }
local tank = { remainingVolume = 60, setRemainingVolume = function(self, x) self.remainingVolume = x end }
energyStorage = { getStorages = function() return { mainTank = tank } end }
local engFlags = {}
damageTracker = { getDamage = function(g, n) return g == 'engine' and engFlags[n] or false end }
local lockups = 0
powertrain = { getDevicesByCategory = function(c) return { mainEngine = { lockUp = function() lockups = lockups + 1; engFlags.engineLockedUp = true end } } end }
local deformReplays = {}
onBeamDeformed = function(c, r) deformReplays[#deformReplays + 1] = c end

local function resetCar()
  pristine()
  for _, w in pairs(wheelState) do w.isTireDeflated = nil end
  tank.remainingVolume = 60
  engFlags = {}
end

-- the message plumbing: GE -> vehicle (queueLuaCommand) and vehicle -> GE (queueGameEngineLua) -----------------
local vehRepair = require('rallyRaid/vehRepair')
local core = require('rallyRaid/core')
local repair = require('rallyRaid/repair')
local cfg = require('rallyRaid/repairConfig')
rallyRaid_core = core
rallyRaid_vehRepair = vehRepair
local ge2veh = {}
local ANSWER = true          -- false: the car never answers (timeout test)
local resets = 0
repair.game.vehId = function() return VEH_ID end
repair.game.send = function(cmd) if ANSWER then ge2veh[#ge2veh + 1] = cmd end return true end
function RESET_NOW()
  resets = resets + 1
  resetCar()
  vehRepair.onReset()
  core.onVehicleResetted(VEH_ID)
end
repair.game.resetInPlace = function() RESET_NOW(); return true end
repair.game.iprLoaded = function() return IPR_LOADED == true end
local function pump()
  for _ = 1, 50 do
    local any = false
    while #ge2veh > 0 do any = true; local c = table.remove(ge2veh, 1); assert(load(c))() end
    while #veh2ge > 0 do any = true; local c = table.remove(veh2ge, 1); assert(load(c))() end
    vehRepair.updateGFX(); vehRepair.updateGFX()
    if not any and not vehRepair._pending() then break end
  end
end

local rally = require('rallyRaid/rally')
local geo = require('rallyRaid/geo')
local function step(dt) core.onUpdate(dt, dt) end
local function driveTo(lat, lon, kmh, maxS)
  local vms, t = kmh / 3.6, 0
  for _ = 1, 400000 do
    local d = geo.dist(car.lat, car.lon, lat, lon)
    if d < 0.5 or (maxS and t >= maxS) then break end
    local b = geo.bearing(car.lat, car.lon, lat, lon)
    local move = math.min(d, vms * 0.5)
    car.lat = car.lat + move * math.cos(math.rad(b)) / 111195
    car.lon = car.lon + move * math.sin(math.rad(b)) / (111195 * math.cos(math.rad(car.lat)))
    car.speed, car.heading = vms, b
    car.ve, car.vn = vms * math.sin(math.rad(b)), vms * math.cos(math.rad(b))
    step(0.5); t = t + 0.5
  end
end
local function followRoute(stage, kmh)
  for _, leg in ipairs(stage.route.legs) do for i = 2, #leg.points do driveTo(leg.points[i][1], leg.points[i][2], kmh) if core._debug().phase == 'finished' then return end end end
end
local function stop() car.speed, car.ve, car.vn = 0, 0, 0; step(0.1); step(0.1) end

-- 1) allowance rule (published km at 60 km/h + 30 min, rounded up to 5 min)
check(rally.allowanceMin(590) == 620 and rally.allowanceMin(50) == 80 and rally.allowanceMin(140) == 170 and rally.allowanceMin(0) == 0 and rally.allowanceMin(1) == 35, 'allowance rule')
check(cfg.rally and cfg.rally.liaisonKmh == 60 and cfg.rally.liaisonExtraMin == 30 and cfg.rally.liaisonRoundMin == 5 and cfg.rally.teleportUsesAllowance == true, 'tunables in repairConfig.lua')

-- 2) a test rally next to the sample stage
local stagePath = '/rallyraid/stages/moab-sand-flats-ss1.json'
local sample = READ_JSON(stagePath)
local W = sample.waypoints
local dss, ass = W[1], W[#W]
local function off(p, dkm) return { lat = p.lat + dkm / 111.2, lon = p.lon } end
local campA, camp2 = off(dss, -10), off(ass, 8)
local RPATH = '/rallyraid/stages/test.rally.json'
files[RPATH] = { format = 'rallyraid-rally', schemaVersion = 1, id = 'test-rally', name = 'Test Rally', disclaimer = 'Inspired by the 2027 Test route. Unofficial, not affiliated.',
  bivouacs = {
    { id = 'a', name = 'Camp A', lat = campA.lat, lon = campA.lon, kind = 'bivouac' },
    { id = 'b', name = 'Camp B', lat = camp2.lat, lon = camp2.lon, kind = 'bivouac' },
    { id = 'r', name = 'Refuge', lat = camp2.lat, lon = camp2.lon, kind = 'marathon' } },
  days = {
    { n = 1, date = '2027-01-09', type = 'stage', code = 'SS1', title = 'SS1', from = 'a', to = 'b',
      liaisonOut = { km = 15, allowanceMin = 45, drive = true }, liaisonIn = { km = 10, allowanceMin = 40, drive = true },
      stage = { id = sample.id, file = 'moab-sand-flats-ss1.json', targetKm = 10, km = sample.lengthKm, dss = { lat = dss.lat, lon = dss.lon }, ass = { lat = ass.lat, lon = ass.lon } } },
    { n = 2, date = '2027-01-10', type = 'transfer', code = 'T', title = 'Transfer', from = 'b', to = 'b', liaisonOut = { km = 590, allowanceMin = 620, drive = false, ferry = true } },
    { n = 3, date = '2027-01-11', type = 'marathon', marathon = true, code = 'SS2', title = 'SS2', from = 'b', to = 'r',
      liaisonOut = { km = 20 }, liaisonIn = { km = 10, allowanceMin = 40, drive = true },
      stage = { id = sample.id, file = 'moab-sand-flats-ss1.json', targetKm = 10, km = sample.lengthKm, dss = { lat = dss.lat, lon = dss.lon }, ass = { lat = ass.lat, lon = ass.lon } } },
    { n = 4, date = '2027-01-12', type = 'rest', code = 'REST', title = 'Rest', from = 'r', to = 'r' } } }
car.lat, car.lon = campA.lat, campA.lon
core.cmd('rallyList')
check(ui.RallyRaidRally and ui.RallyRaidRally.experimental == true, 'rally state pushed, tagged experimental')
core.cmd('rallyLoad', '/rallyraid/stages/nope.rally.json')
check(not rally.state().loaded and ui.RallyRaidRally.msg, 'a missing file: message, nothing loaded')
core.cmd('rallyLoad', RPATH)
local st = rally.state()
check(st.loaded and st.rally.name == 'Test Rally' and #st.rally.days == 4 and st.progress.day == 1 and st.progress.phase == 'start', 'rally loaded, day 1 start')
check(st.rally.disclaimer:find('Unofficial, not affiliated'), 'disclaimer in the state (shown in the app)')
check(st.rally.days[3].liaisonOut.allowanceMin == 50, 'a file without allowanceMin gets the rule (20 km -> 50 min)')
check(files['/rallyraid/rally/rally_test-rally.json'] ~= nil, 'progress saved')

-- 3) day 1: DRIVE the liaison out; the car is 111 km away, so it is moved to the start bivouac first
car.lat, car.lon = dss.lat + 1, dss.lon; step(0.1); stop()
core.cmd('rallyDrive')
st = rally.state()
check(st.progress.phase == 'liaisonOut' and st.liaison and st.liaison.mode == 'drive' and st.liaison.allowanceMin == 45, 'drive liaison out running')
check(geo.dist(car.lat, car.lon, campA.lat, campA.lon) < 5, 'car far away: moved to the start bivouac first')
check(core._debug() and core._debug().stage and core._debug().stage.id == sample.id, 'the way out loaded the stage')
core.cmd('rallyNextDay'); check(rally.state().progress.day == 1, 'next day refused mid-day')
-- drive 10 km at 60 km/h = 10 min: arrives with 35 min to spare (kept until the evening bivouac)
driveTo(dss.lat, dss.lon, 60)
stop()
st = rally.state()
local p1 = st.rally.days[1].progress
check(st.progress.phase == 'stage' and p1.liaisonOut and p1.liaisonOut.how == 'arrived', 'arrived at the DSS: liaison done')
check(p1.liaisonOut.lateMin == 0 and p1.liaisonOut.leftoverMin >= 33 and p1.liaisonOut.leftoverMin <= 36, 'about 35 min to spare (' .. tostring(p1.liaisonOut.leftoverMin) .. ')')
local leftOut = p1.liaisonOut.leftoverMin
check(p1.pendingBivouacMin == leftOut, 'out leftover kept for tonight, not last night')
-- the stage
followRoute(core._debug().stage, 60)
local S = core._debug()
check(S.phase == 'finished', 'stage finished')
st = rally.state()
p1 = st.rally.days[1].progress
check(p1.stage and p1.stage.stageTime > 0, 'stage time recorded')
check(st.progress.phase == 'liaisonInChoice', 'liaison in: choice')
local Lg = repair.ledger()
check(Lg.bivouac and Lg.bivouac.open and Lg.bivouac.budgetMin == cfg.bivouac.budgetMin + leftOut, 'bivouac at the ASS got the out leftover (' .. tostring(Lg.bivouac and Lg.bivouac.budgetMin) .. ')')
check(p1.pendingBivouacMin == nil, 'pending leftover cleared')
-- liaison in: drive but arrive late (6.5 km to the 1.5 km bivouac circle at 8 km/h = 49 min, allowance 40)
core.cmd('rallyDrive')
driveTo(camp2.lat, camp2.lon, 8)
stop()
st = rally.state(); p1 = st.rally.days[1].progress
check(p1.liaisonIn and p1.liaisonIn.lateMin >= 8 and p1.liaisonIn.penaltyS == p1.liaisonIn.lateMin * cfg.rally.latePenaltyPerMinS and p1.liaisonIn.leftoverMin == 0, 'late liaison in: penalty ' .. tostring(p1.liaisonIn and p1.liaisonIn.lateMin) .. ' min')
check(st.progress.phase == 'bivouac' and p1.done, 'day 1 done, at the bivouac')
check(math.abs(st.progress.totalS - (p1.stage.stageTime + p1.stage.penaltyTime + p1.liaisonIn.penaltyS)) < 1e-6, 'cumulative = stage + stage penalties + liaison penalties')

-- 4) day 2: transfer with a sea crossing: drive refused, teleport uses the whole allowance
core.cmd('rallyNextDay')
check(rally.state().progress.day == 2 and rally.state().progress.phase == 'start', 'day 2')
core.cmd('rallyDrive')
check(rally.state().progress.phase == 'start' and rally.state().msg:find('sea crossing'), 'a ferry transfer cannot be driven')
local tot = rally.state().progress.totalS
core.cmd('rallyTeleport')
st = rally.state(); local p2 = st.rally.days[2].progress
check(p2.liaisonOut and p2.liaisonOut.mode == 'teleport' and p2.liaisonOut.elapsedS == 620 * 60 and p2.liaisonOut.leftoverMin == 0 and p2.liaisonOut.lateMin == 0, 'teleport = full allowance, no leftover, no penalty')
check(st.progress.phase == 'bivouac' and st.progress.totalS == tot, 'transfer done, total unchanged')

-- 5) day 3: marathon to the refuge, teleport both ways
core.cmd('rallyNextDay')
core.cmd('rallyTeleport')
st = rally.state()
check(st.progress.phase == 'stage' and geo.dist(car.lat, car.lon, dss.lat, dss.lon) < 50, 'teleport out: at the DSS, stage phase')
core.cmd('abort'); S = core._debug()
car.lat, car.lon = dss.lat, dss.lon; step(0.1); stop()
followRoute(S.stage, 60)
check(core._debug().phase == 'finished', 'marathon stage finished')
Lg = repair.ledger()
check(Lg.bivouac and Lg.bivouac.open and Lg.bivouac.marathon and Lg.bivouac.budgetMin == cfg.rally.marathon.budgetMin, 'refuge: marathon budget ' .. tostring(Lg.bivouac and Lg.bivouac.budgetMin))
core.cmd('rallyDrive')
driveTo(camp2.lat, camp2.lon, 60); stop()
st = rally.state(); local p3 = st.rally.days[3].progress
check(p3.liaisonIn and p3.liaisonIn.leftoverMin > 0 and repair.ledger().bivouac.budgetMin == cfg.rally.marathon.budgetMin, 'refuge: leftover not added (addLeftover false)')
check(st.rally.days[3].refuge == true and st.rally.days[3].marathon == true, 'day flagged marathon / refuge for the app')
core.cmd('repairMenu'); pump()
local byId = {}; for _, o in ipairs(ui.RallyRaidRepair.options or {}) do byId[o.id] = o end
check(byId.engine and byId.engine.enabled == false and byId.engine.why:find('marathon'), 'no engine change at a marathon refuge')
core.cmd('repairClose')

-- 6) day 4: rest day bonus, then the finish and the result file
core.cmd('rallyNextDay')
st = rally.state()
check(st.progress.phase == 'rest' and st.rally.days[4].progress.restBonusMin == cfg.rally.restDayBonusMin, 'rest day: bivouac bonus')
core.cmd('rallyNextDay')
st = rally.state()
check(st.progress.phase == 'finished' and st.progress.finishedAt, 'rally finished')
local resFile; for k, v in pairs(files) do if k:find('^/rallyraid/results/rally_test%-rally_') then resFile = v end end
check(resFile and resFile.format == 'rallyraid-rally-result' and resFile.experimental == true and resFile.totalS == st.progress.totalS, 'result file written')

-- 7) resume after a restart: progress comes back from disk; restart starts over
rally._reset()
core.cmd('rallyLoad', RPATH)
check(rally.state().progress.phase == 'finished', 'progress restored from the save')
core.cmd('rallyRestart')
check(rally.state().progress.day == 1 and rally.state().progress.phase == 'start' and rally.state().progress.totalS == 0, 'restart: day 1 again')
core.cmd('rallyClose')
check(not rally.state().loaded, 'closed')

-- 8) the real event file, if compiled: loads, all stage files resolve
local ev = '/rallyraid/rallies/atlantic-to-atlas-2027.rally.json'
local okEv, evd = pcall(READ_JSON, ev)
if okEv and evd then
  check(rally.load(ev) == true, 'Atlantic to Atlas loads')
  local n = 0
  for _, d in ipairs(rally._R().rally.days) do if d.stage then local ok2, s = pcall(READ_JSON, '/rallyraid/rallies/' .. d.stage.file); if ok2 and s and s.format == 'rallyraid-stage' then n = n + 1 end end end
  check(n == 13, 'all 13 stage files of the event resolve (' .. n .. ')')
else print('(event file not compiled yet: skipped)') end

print(string.format('rally_test: %d passed, %d failed', passes, fails))
return fails
