-- Offline test of the repair system: rallyRaid/repair.lua (GE) + rallyRaid/vehRepair.lua (vehicle) with a fake
-- BeamNG, a fake four-wheeled car (nodes, beams, wheels, tyres, fuel, engine damage) and the sample stage.
-- Run with tests/run_tests.py (LuaJIT through lupa). Nothing here runs in the game: docs/REPAIR.md lists what only
-- the game can check (the real reset, real part names, deform groups).
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

-- 1) classification and layout ------------------------------------------------------------------------------------
local C = { groups = cfg.groups, groupOrder = cfg.groupOrder, beamDamagedRatio = cfg.beamDamagedRatio, engineFlags = cfg.engineFlags }
local cases = { tire_F_31x10 = 'wheel', wheel_R_steel = 'wheel', hubcap_F = 'wheel', steering_wheel_sport = 'body',
  pickup_suspension_F = 'suspension', pickup_hub_F = 'suspension', pickup_leafspring_R = 'suspension', radiator_v8 = 'radiator',
  pickup_frame = 'frame', pickup_engine_v8 = 'engine', pickup_hood = 'body', armrest_leather = 'body', pickup_steering_rack = 'steering',
  pickup_transfercase = 'drivetrain', pickup_fueltank = 'fueltank', headlight_L = 'lights', wheelhouse_F = 'body', pickup_spare_wheel = 'body',
  pickup_enginemount = 'body', [''] = 'body' }
for name, want in pairs(cases) do check(vehRepair.classify(name, C) == want, 'classify ' .. name .. ' -> ' .. want .. ' (got ' .. vehRepair.classify(name, C) .. ')') end
local lay = vehRepair.layout(vdata, C)
check(#lay.wheels == 4 and lay.wheels[1].name == 'FL', 'four wheels found, sorted')
local tF = nodeByPart['tire_F_31x10']
check(lay.nodes[tF[1]].corner == 'FL' and lay.nodes[tF[4]].corner == 'FR', 'one front tyre part split into FL / FR by the nearest wheel')
check(lay.nodes[nodeByPart['pickup_leafspring_R'][3]].corner == 'RR', 'rear right spring at RR')
check(lay.nodes[nodeByPart['radiator_v8'][1]].corner == nil, 'radiator has no corner')
local fixFL = vehRepair.selector({ parts = { { group = 'wheel', corner = 'FL' } } })
check(fixFL({ group = 'wheel', corner = 'FL' }) and not fixFL({ group = 'wheel', corner = 'FR' }) and not fixFL({ group = 'suspension', corner = 'FL' }), 'selector: just the FL wheel')
local fixAll = vehRepair.selector({ allExcept = { 'engine' } })
check(fixAll({ group = 'frame' }) and fixAll({ group = 'wheel', corner = 'RR' }) and not fixAll({ group = 'engine' }), 'selector: everything but the engine')
local fixRad = vehRepair.selector({ parts = { { group = 'radiator' } } })
check(fixRad({ group = 'radiator' }) and not fixRad({ group = 'body' }), 'selector: a group without corner')

-- 2) options and bivouac minutes (pure) -------------------------------------------------------------------------
local survey = { ok = true, corners = { 'FL', 'FR', 'RL', 'RR' }, deflated = { 'FR' }, engineFlags = {},
  groups = { suspension = { FL = { damage = 0.5 } }, radiator = { ['*'] = { damage = 0.2 } }, body = { ['*'] = { damage = 1.0 } },
    engine = { ['*'] = { damage = 0.9 } }, frame = { ['*'] = { damage = 0.01 } } } }
local m, items = repair.wholeCarMinutes(survey)
-- service 10 + suspension FL 20*(0.3+0.7*0.5)=13 + radiator 30*(0.3+0.14)=13.2 + body 15*1=15 + wheel FR (flat) 2 ; frame under threshold, engine excluded
check(m == math.ceil(10 + 13 + 13.2 + 15 + 2), 'whole-car minutes from damage: ' .. m)
local hasEngine = false; for _, it in ipairs(items) do if it.what:find('engine') then hasEngine = true end end
check(not hasEngine, 'engine not part of the whole-car repair')
check(repair.wholeCarMinutes({ groups = {} }) == cfg.bivouac.serviceMin, 'an undamaged car still costs the service minutes')

-- 3) a stage: mid-stage repairs ------------------------------------------------------------------------------
local function step(dt) core.onUpdate(dt, dt) end
local geo = require('rallyRaid/geo')
local function driveTo(lat, lon, kmh)
  local vms = kmh / 3.6
  for _ = 1, 100000 do
    local d = geo.dist(car.lat, car.lon, lat, lon)
    if d < 0.5 then break end
    local b = geo.bearing(car.lat, car.lon, lat, lon)
    local move = math.min(d, vms * 0.1)
    car.lat = car.lat + move * math.cos(math.rad(b)) / 111195
    car.lon = car.lon + move * math.sin(math.rad(b)) / (111195 * math.cos(math.rad(car.lat)))
    car.speed, car.heading = vms, b
    car.ve, car.vn = vms * math.sin(math.rad(b)), vms * math.cos(math.rad(b))
    step(0.1)
  end
end
local function stop() car.speed, car.ve, car.vn = 0, 0, 0; step(0.1); step(0.1) end
local function followRoute(stage, kmh)
  for _, leg in ipairs(stage.route.legs) do for i = 2, #leg.points do driveTo(leg.points[i][1], leg.points[i][2], kmh) if core._debug().phase == 'finished' then return end end end
end
local function driveOut(stage)   -- along the first leg until the clock runs (out of the 200 m DSS circle)
  for _, pt in ipairs(stage.route.legs[1].points) do driveTo(pt[1], pt[2], 50); if core._debug().phase == 'running' and geo.dist(pt[1], pt[2], stage.waypoints[1].lat, stage.waypoints[1].lon) > 400 then return end end
end
local path
for _, st in ipairs(core.listStages()) do if st.file == 'moab-sand-flats-ss1.json' then path = st.path end end
check(core.loadStage(path) == true, 'sample stage loads')
local S = core._debug()
local dss = S.stage.waypoints[1]
car.lat, car.lon = dss.lat, dss.lon
step(0.1); stop()
check(repair.mode() == 'none', 'armed, no bivouac yet: no repairs')
core.cmd('repairMenu')
check(ui.RallyRaidRepair and ui.RallyRaidRepair.open == true and ui.RallyRaidRepair.mode == 'none', 'menu opens, says no repairs here')
check(#notes > 0 and notes[#notes]:find('rally.raid Earth GPS'), 'no GPS app seen yet: tells the player to add the GPS app (REPAIR is in it)')
core.cmd('repairClose'); core.cmd('repairAppHere')
check(not blockedNow(), 'keys free before the start (no bivouac open)')
-- drive out of the DSS: the stage starts
local leg1 = S.stage.route.legs[1]
driveOut(S.stage)
check(S.phase == 'running', 'stage running')
check(blockedNow(), 'free reset keys blocked when the stage starts')
local blockedNames = {}; for _, c in ipairs(filterCalls) do if c[2] ~= 'CLEAR' then blockedNames[c[2]] = true end end
check(blockedNames.reset_physics and blockedNames.recover_vehicle and blockedNames.reload_vehicle and blockedNames.loadHome and blockedNames.slower_motion, 'R, Insert, Ctrl+R, Home and the competitive template blocked')
check(repair.mode() == 'stage', 'mode stage')

-- damage the car
local function breakPart(part, n) for i = 1, n do phys.broken[beamByPart[part][i]] = true end end
local function dentPart(part, ratio) for _, b in ipairs(beamByPart[part]) do phys.rest[b] = origLen(vdata.beams[b]) * (1 - ratio) end end
dentPart('tire_F_31x10', 0.2)              -- both front tyres (one part)
breakPart('radiator_v8', 1)
dentPart('pickup_frame', 0.1)
breakPart('pickup_hood', 1)
wheelState[0].isTireDeflated = true        -- FL flat
wheelState[1].isTireDeflated = true        -- FR flat
tank.remainingVolume = 23.5
engFlags.engineLockedUp = true
engFlags.headGasketDamaged = true
for _, n in ipairs(nodeByPart['pickup_frame']) do phys.pos[n].z = phys.pos[n].z - 0.05 end
local framePos = phys.pos[nodeByPart['pickup_frame'][1]].z

core.cmd('repairMenu'); pump()
local st = ui.RallyRaidRepair
check(st.open and st.mode == 'stage' and st.survey and st.survey.ok, 'menu open with a survey from the car')
local byId = {}; for _, o in ipairs(st.options) do byId[o.id] = o end
check(byId['wheel:FL'] and byId['wheel:RR'] and byId['suspension:FL'] and byId.radiator and not byId.whole, 'stage options: wheels, suspension per corner, radiator')
check(byId['wheel:FL'].minutes == 2 and byId['suspension:RL'].minutes == 18 and byId.radiator.minutes == 12, 'stage minutes 2 / 18 / 12')
check(byId['wheel:FL'].flat and byId['wheel:FR'].flat and not byId['wheel:RL'].flat, 'flat tyres shown')
check(byId.radiator.damage > 0 and byId['wheel:FL'].damage > 0.5 and byId['wheel:RL'].damage == 0, 'damage bars from the survey')

-- moving: refused
car.speed = 10
step(0.1)
local ok, why = repair.confirm('wheel:FL,radiator')
check(not ok and why == 'stop the car first', 'refused while moving')
stop()
local penBefore = S.penaltyTotal
ok = repair.confirm('wheel:FL,radiator'); pump()
check(ok and resets == 1, 'repair confirmed, car reset once')
check(S.penaltyTotal - penBefore == 14 * 60, 'wheel 2 + radiator 12 = 14 min penalty, got ' .. (S.penaltyTotal - penBefore))
local lastPen = S.penalties[#S.penalties]
check(lastPen.kind == 'repair' and lastPen.detail:find('Change wheel FL') and lastPen.detail:find('Radiator'), 'penalty logged as repair with what was done')
check(S.repair.spares == 1 and #S.repair.log == 1, 'one spare used, one log entry')
local e = S.repair.log[1]
check(e.penaltyS == 840 and e.lat and e.lon and e.km and e.stats and e.stats.rebroken >= 1, 'log entry: penalty, lat / lon, km, stats')
-- what the car looks like now
local tFL, tFR = beamByPart['tire_F_31x10'][1], beamByPart['tire_F_31x10'][5]
check(near(phys.rest[tFL], origLen(vdata.beams[tFL])), 'FL tyre beam repaired')
check(near(phys.rest[tFR], origLen(vdata.beams[tFR]) * 0.8), 'FR tyre beam still dented')
check(not phys.broken[beamByPart['radiator_v8'][1]], 'radiator beam mended')
check(phys.broken[beamByPart['pickup_hood'][1]], 'hood beam broken again (not repaired)')
check(near(phys.rest[beamByPart['pickup_frame'][1]], origLen(vdata.beams[beamByPart['pickup_frame'][1]]) * 0.9), 'frame dent put back')
check(near(phys.pos[nodeByPart['pickup_frame'][1]].z, framePos), 'frame node position put back')
check(not wheelState[0].isTireDeflated and wheelState[1].isTireDeflated, 'FL tyre inflated (changed), FR still flat')
check(near(tank.remainingVolume, 23.5), 'fuel given back after the reset (' .. tank.remainingVolume .. ')')
check(lockups == 1 and engFlags.engineLockedUp, 'locked engine locked again')
local nr = e.engineFlagsNotRestored or {}
check(#nr == 1 and nr[1] == 'headGasketDamaged', 'engine damage that cannot be put back is logged: ' .. table.concat(nr, ','))
check(phys.commits >= 1, 'commitLoad called')
check(S.flags.unauthorizedReset == nil and #repair.ledger().resumes == 0, 'our own reset is not counted as a resume')

-- spares: one left; two wheels refused, one ok, then none
pump()
ok, why = repair.confirm('wheel:FR,wheel:RL')
check(not ok and why:find('1 spare'), 'two wheels with one spare left refused: ' .. tostring(why))
ok = repair.confirm('wheel:FR'); pump()
check(ok and S.repair.spares == 2, 'second spare used')
pump()
local opts = repair.options('stage', nil)
check(not opts[1].enabled and opts[1].why == 'no spare wheel left', 'no spares left: wheel options disabled')
ok, why = repair.confirm('wheel:RL')
check(not ok, 'third wheel change refused')
ok = repair.confirm('suspension:FL'); pump()
check(ok and S.repair.timeS == (14 + 2 + 18) * 60, 'suspension 18 min, repair time adds up: ' .. S.repair.timeS)
check(repair.confirm('nonsense') == false, 'unknown id refused')

-- a busy repair the car never answers: times out, nothing charged
ANSWER = false
local pen0 = S.penaltyTotal
ok = repair.confirm('radiator')
check(ok and repair._R().busy, 'repair waiting for the car')
check(repair.confirm('radiator') == false, 'second repair refused while one runs')
for _ = 1, 100 do step(0.1) end
check(repair._R().busy == nil and S.penaltyTotal == pen0, 'timed out: no penalty')
ANSWER = true

-- 4) resets the app did not make ----------------------------------------------------------------------------
driveTo(leg1.points[#leg1.points][1], leg1.points[#leg1.points][2], 40)
stop()
local pen1 = S.penaltyTotal
check(core.onVehicleResetted(VEH_ID) == 'counted', 'a reset we did not make is counted')
check(S.penaltyTotal - pen1 == 15 * 60, 'first resume of the rally: 15 min')
check(S.flags.unauthorizedReset == 1 and #repair.ledger().resumes == 1 and repair.ledger().resumes[1].kind == 'unauthorizedReset', 'logged in the stage and the rally ledger')
check(files[repair.LEDGER_FILE] and #files[repair.LEDGER_FILE].resumes == 1, 'ledger saved')
check(core.onVehicleResetted(999) == 'other', 'another vehicle resetting is ignored')
-- the car moving right after the reset (Insert rewinds it) is not also a teleport flag: the reset is the record
local jlat = car.lat
car.lat = car.lat + 200 / 111195
step(0.1)
check(not S.flags.positionJump, 'rewind after a counted reset not flagged as a teleport too')
car.lat = jlat; step(0.1)
-- the second one on the same stage retires it
check(core.onVehicleResetted(VEH_ID) == 'retired', 'second reset on the stage: retired')
check(S.phase == 'finished' and S.flags.retired and S.result and S.result.retired, 'stage ended as retired')
local res = S.result
check(#res.repairs == 3 and res.repairTime == (14 + 2 + 18) * 60 and res.sparesUsed == 2, 'result: repairs, repair time, spares')
check(#res.resets == 2 and res.resets[2].outcome == 'retired' and res.resumes.rally == 2 and res.resumes.stage == 2, 'result: resets and resume counts')
check(res.repairRules and res.repairRules.stage.wheelChangeMin == 2 and res.repairRules.bivouac.budgetMin == 180, 'result carries the repair rules')
check(res.rally and res.rally.id == repair.ledger().id, 'result carries the rally id')
local repPen = 0; for _, p in ipairs(res.penalties) do if p.kind == 'repair' then repPen = repPen + p.seconds end end
check(repPen == res.repairTime, 'repair penalties match repair time')
check(repair.mode() == 'bivouac' and repair.ledger().bivouac.open, 'a retired stage still opens the bivouac (the only place to fix the car)')
check(blockedNow(), 'keys stay blocked in the bivouac')
core.cmd('unload')
check(not blockedNow(), 'no stage loaded: keys free (free roam)')
check(core.onVehicleResetted(VEH_ID) == 'bivouac' and #repair.ledger().bivouac.resets == 1, 'a reset with the bivouac open is still logged')
repair.ledger().bivouac.resets = {}
check(core.loadStage(path) == true, 'stage loaded again')

-- 5) a full run, then the bivouac ---------------------------------------------------------------------------
core.cmd('abort'); S = core._debug()
car.lat, car.lon = dss.lat, dss.lon; step(0.1); stop()
resetCar()
followRoute(S.stage, 60)
check(S.phase == 'finished' and not S.result.retired, 'full run finished')
check(S.result.resumes.stage == 0 and S.result.resumes.rally == 2, 'new run: stage resumes 0, rally still 2')
local L = repair.ledger()
check(L.bivouac and L.bivouac.open and L.bivouac.budgetMin == 180, 'bivouac open after the finish')
check(repair.mode() == 'bivouac' and blockedNow(), 'bivouac mode, keys still blocked')
dentPart('pickup_suspension_F', 0.3); breakPart('radiator_v8', 2); engFlags.headGasketDamaged = true; tank.remainingVolume = 31
core.cmd('repairMenu'); pump()
st = ui.RallyRaidRepair
byId = {}; for _, o in ipairs(st.options) do byId[o.id] = o end
check(byId.whole and byId.engine and not byId['wheel:FL'], 'bivouac options: whole car, engine change')
check(byId.engine.minutes == 90 and byId.engine.penaltyS == 7200 and #byId.engine.engineFlags == 1, 'engine change 90 min + 2 h, shows the damage')
local wholeMin = byId.whole.minutes
check(wholeMin > cfg.bivouac.serviceMin, 'whole-car minutes include the damage: ' .. wholeMin)
car.speed = 5; step(0.1)
check(repair.confirm('whole') == false, 'bivouac repair refused while moving')
stop()
ok = repair.confirm('whole'); pump()
check(ok and L.bivouac.usedMin == wholeMin, 'whole-car repair uses bivouac time')
check(not phys.broken[beamByPart['radiator_v8'][1]] and near(phys.rest[beamByPart['pickup_suspension_F'][1]], origLen(vdata.beams[beamByPart['pickup_suspension_F'][1]])), 'whole-car repair fixed radiator and suspension')
check(near(tank.remainingVolume, 31), 'fuel kept through the whole-car repair: ' .. tank.remainingVolume)
local we = L.bivouac.log[1]
check(we and we.engineFlagsNotRestored and we.engineFlagsNotRestored[1] == 'headGasketDamaged', 'whole-car repair logs the engine damage it could not keep')
ok = repair.confirm('engine'); pump()
check(ok and L.bivouac.usedMin == wholeMin + 90 and L.bivouac.engineChanges == 1, 'engine change: +90 min bivouac, counted')
check(S.penaltyTotal == S.result.penaltyTime, 'bivouac work does not touch the finished stage')
-- a reset during the bivouac is logged, not charged
check(core.onVehicleResetted(VEH_ID) == 'bivouac' and #L.bivouac.resets == 1, 'reset in the bivouac logged')
-- teleport to the DSS is ours
TELEPORT_RESETS = true
core.cmd('teleport')
TELEPORT_RESETS = false
check(#L.bivouac.resets == 1, 'TP TO DSS reset not logged as a bivouac reset')
-- push the clock over budget by 50 min, then start the next stage
L.bivouac.usedMin = 230
core.cmd('abort'); S = core._debug()
car.lat, car.lon = dss.lat, dss.lon; step(0.1); stop()
driveOut(S.stage)
check(S.phase == 'running', 'next stage running')
local kinds = {}; for _, p in ipairs(S.penalties) do kinds[p.kind] = (kinds[p.kind] or 0) + p.seconds end
check(kinds.bivouacOverrun == 50 * 60, 'bivouac 50 min over: 50 min penalty')
check(kinds.engineChange == 7200, 'engine change: 2 h penalty on the next stage')
check(S.repair.bivouac and S.repair.bivouac.overMin == 50 and not S.repair.bivouac.retired, 'bivouac record on the stage, not retired')
check(S.flags.bivouacResets == 1, 'bivouac reset flagged on the next stage')
check(repair.ledger().bivouac == nil and #repair.ledger().bivouacs == 2, 'bivouacs closed and archived')
check(repair.mode() == 'stage', 'back to stage mode')
-- third resume of the rally: 30 min; then finish this run by aborting
local pen2 = S.penaltyTotal
check(core.onVehicleResetted(VEH_ID) == 'counted' and S.penaltyTotal - pen2 == 30 * 60, 'later resume: 30 min')
local r4 = repair.countResume('carRecovery', {})
check(r4.retire and r4.reason:find('second'), 'crash-resume API: second on the stage retires')

-- 6) the resume budget across stages, near the finish, and retirement from the rally -----------------------------
repair.newRally()
check(#repair.ledger().resumes == 0 and repair.ledger().bivouac == nil, 'new rally: counters back to 0')
local fakeS = { repair = { resumes = 0, resumesLog = {} }, stage = { id = 'x' }, clock = 0 }
local realS = core._debug
local function withStage(n) fakeS.repair.resumes = n end
-- simulate three stages with one resume each, then a fourth
local rr = {}
for i = 1, 4 do
  repair.init({ S = function() return fakeS end, nav = function() return {} end, notify = function() end })
  withStage(0)
  rr[i] = repair.countResume('carRecovery', { distToFinishM = 5000 })
end
check(rr[1].penaltyS == 900 and rr[2].penaltyS == 1800 and rr[3].penaltyS == 1800, '15, 30, 30 min')
check(rr[4].retire and rr[4].reason:find('more than 3'), 'fourth resume of the rally: retired')
repair.newRally(); withStage(0)
local rn = repair.countResume('carRecovery', { distToFinishM = 600 })
check(rn.retire and rn.reason:find('1000 m'), 'no resume within 1 km of the ASS')
-- back to core's hooks
package.loaded['rallyRaid/core'] = nil
repair._reset()

-- 7) bivouac retirement (more than 60 min over) and IPR detection ----------------------------------------------
core = require('rallyRaid/core'); rallyRaid_core = core
repair.game.vehId = function() return VEH_ID end
repair.game.send = function(cmd) ge2veh[#ge2veh + 1] = cmd return true end
repair.game.resetInPlace = function() RESET_NOW(); return true end
repair.game.iprLoaded = function() return IPR_LOADED == true end
files[repair.LEDGER_FILE] = nil
repair.loadLedger()
repair.ledger().bivouac = { open = true, afterStage = 'x', usedMin = 241, budgetMin = 180, engineChanges = 0, log = {}, resets = {} }
check(core.loadStage(path) == true, 'stage loads again')
S = core._debug()
IPR_LOADED = true
car.lat, car.lon = dss.lat, dss.lon; step(0.1); stop()
driveOut(S.stage)
check(S.phase == 'running' and S.flags.rallyRetired and repair.ledger().retired, '61 min over: retired from the rally')
check(S.flags.ipr == true, 'IPR loaded: flagged')
local rres = core.results()
check(rres.official == false and rres.bivouac.retired and rres.rally.retired, 'result unofficial, says retired')
IPR_LOADED = false

-- 8) 18 Nov in-game fixes (the vehicle half straight, then its answers through the GE half's log) --------------
-- "replacing wheels didn't work ... the tires immediately punctured again ... fixing the suspension broke the steering"
local logs = {}
log = function(l, tag, m) logs[#logs + 1] = tostring(l) .. ' ' .. tostring(m) end
local function logHas(pat) for _, l in ipairs(logs) do if l:find(pat) then return l end end end
-- a steering hydro (rack to the FL knuckle), a tyre pressure beam, the tyre on its hub, a frame beam ending on the hub
local hyd = bcid; addBeam(nodeByPart['pickup_engine_v8'][1], sF[2], 'pickup_steering_rack', { beamType = 2 })
local tyreP = bcid; addBeam(tF[1], tF[2], 'tire_F_31x10', { beamType = 3 })
local onHub = bcid; addBeam(tF[3], sF[1], 'tire_F_31x10')
local frameHub = bcid; addBeam(nodeByPart['pickup_frame'][1], sF[1], 'pickup_frame')
v = { data = { nodes = vdata.nodes, beams = vdata.beams, wheels = vdata.wheels } }      -- a new car: layout again
local lay8 = vehRepair.layout(v.data, C)
check(lay8.beams[hyd].normal == false and lay8.beams[tyreP].normal == false and lay8.beams[frameHub].normal == true, 'hydro and tyre pressure beams are not plain beams')
local setLen, setPos = {}, {}
local realSetLen, realSetPos = obj.setBeamLength, obj.setNodePosition
obj.setBeamLength = function(o, c, l) setLen[c] = true; return realSetLen(o, c, l) end
obj.setNodePosition = function(o, c, p) setPos[c] = true; return realSetPos(o, c, p) end
local function run8(spec, reqId, afterApply)
  setLen, setPos, veh2ge, ge2veh = {}, {}, {}, {}
  vehRepair.cancel()
  local P = vehRepair.prepare(C, spec, reqId)
  resetCar(); vehRepair.onReset()                                  -- the reset in place
  for _ = 1, 3 do vehRepair.updateGFX() end                        -- the damage goes back on
  if afterApply then afterApply() end
  for _ = 1, 61 do vehRepair.updateGFX() end                       -- the second look, 1 s later
  local got = {}
  for _, c in ipairs(veh2ge) do
    local d; local f = assert(load(c:gsub('^if rallyRaid_core then rallyRaid_core%.repairReply%(', 'return ('):gsub(' end$', '')))
    d = f(); got[d.kind] = d
    repair.reply(d)                                               -- logged by the GE half
  end
  veh2ge = {}
  return P, got
end
local function damage8()
  resetCar()
  for i = 1, 2 do phys.broken[beamByPart['tire_F_31x10'][i]] = true end          -- the FL tyre torn
  wheelState[0].isTireDeflated = true
  wheelState[1].isTireDeflated = true                                             -- FR flat too (not changed)
  phys.rest[tyreP] = origLen(vdata.beams[tyreP]) * 0.5
  phys.rest[hyd] = origLen(vdata.beams[hyd]) * 0.8                                 -- the rack mid-turn
  dentPart('pickup_frame', 0.1)                                                     -- frameHub too
  dentPart('pickup_suspension_F', 0.15)
  phys.broken[beamByPart['pickup_hood'][1]] = true
  for _, n in ipairs(nodeByPart['pickup_frame']) do phys.pos[n].z = phys.pos[n].z - 0.05 end
  phys.pos[sF[1]].z = phys.pos[sF[1]].z - 0.1; phys.pos[tF[3]].z = phys.pos[tF[3]].z - 0.1
end
-- a) change wheel FL
damage8()
local P8, got = run8({ parts = { { group = 'wheel', corner = 'FL' } } }, 901)
local pristinePos = function(n) local q = vdata.nodes[n].pos; return near(phys.pos[n].z, q.z) and near(phys.pos[n].x, q.x + 100) end
check(not phys.broken[beamByPart['tire_F_31x10'][1]] and not phys.broken[beamByPart['tire_F_31x10'][2]] and not phys.broken[onHub], 'wheel FL: the new tyre is whole (no torn beam put back)')
check(not wheelState[0].isTireDeflated and wheelState[1].isTireDeflated, 'wheel FL: FL inflated, FR (not changed) still flat')
local movedNew = false; for _, n in ipairs({ tF[1], tF[2], tF[3], sF[1], sF[2] }) do if setPos[n] then movedNew = true end end
check(not movedNew and pristinePos(sF[1]) and pristinePos(tF[3]), 'wheel FL: no node of the new tyre or of its hub moved back to the old place')
check(not setLen[tyreP] and near(phys.rest[tyreP], origLen(vdata.beams[tyreP])), 'wheel FL: tyre pressure beam left new')
check(not setLen[frameHub] and near(phys.rest[frameHub], origLen(vdata.beams[frameHub])), 'wheel FL: a dent pulling on the new hub is left out')
check(near(phys.rest[beamByPart['pickup_frame'][1]], origLen(vdata.beams[beamByPart['pickup_frame'][1]]) * 0.9), 'wheel FL: the frame dent kept')
check(phys.broken[beamByPart['pickup_hood'][1]] and not setLen[beamByPart['pickup_hood'][1]], 'wheel FL: a broken beam stays broken, its length not set')
check(P8.prep.skippedTouchesRepair >= 2 and P8.prep.brokenKept >= 1, 'prepare stats: ' .. repair._kv(P8.prep))
check(got.ready and got.done and got.check and #got.check.flatAgain == 0 and got.check.brokenInRepaired == 0, 'replies: ready, done, and 1 s later no flat again')
check(logHas('%[rally%.raid Earth%] repair 901, 1 s later: flat tyres FR, a changed tyre flat again: none'), 'logged: the 1 s look')
-- b) a tyre that goes flat again right after the change: said, and logged as a warning
damage8()
local _, got2 = run8({ parts = { { group = 'wheel', corner = 'FL' } } }, 902, function() wheelState[0].isTireDeflated = true end)
check(got2.check and got2.check.flatAgain[1] == 'FL', 'flat again: the check finds it')
check(logHas('^W %[rally%.raid Earth%] repair 902, 1 s later.*flat again: FL') and notes[#notes]:find('went flat again'), 'flat again: W line and a note on screen')
-- c) suspension FL: the steering keeps working
damage8()
run8({ parts = { { group = 'suspension', corner = 'FL' } } }, 903)
check(not setLen[hyd] and near(phys.rest[hyd], origLen(vdata.beams[hyd])), 'suspension FL: the steering hydro is never set to its old length')
check(not setPos[sF[1]] and not setPos[sF[2]], 'suspension FL: the knuckle / hub nodes left new')
check(near(phys.rest[beamByPart['pickup_suspension_F'][3]], origLen(vdata.beams[beamByPart['pickup_suspension_F'][3]]) * 0.85), 'suspension FL: the FR suspension dent kept')
-- d) the car report and its log line
local rep = vehRepair.report(C, 'test', 0)
check(rep and rep.broken >= 1 and rep.deformed >= 1 and type(rep.damage) == 'table', 'car report: broken / deformed counts, damage per group')
repair.reply(rep)
check(logHas('car report %(test%): broken beams %d+, deformed beams %d+, flat tyres'), 'car report logged')
obj.setBeamLength, obj.setNodePosition = realSetLen, realSetPos
log = function() end

print(string.format('%d passed, %d failed', passes, fails))
return fails
