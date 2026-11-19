-- Offline test of RECOVER CAR (B11, the one reset allowed in a stage): rallyRaid/resume.lua (GE) + the resume half of
-- rallyRaid/vehRepair.lua, then (section 11 on) the GAME-CRASH resume: rallyRaid/gameResume.lua saves on disk, a kill,
-- a fresh start of every module, the resume and its review flag, corrupt-save fallback. With
-- the same fake BeamNG and fake four-wheeled car as tests/repair_test.lua (copied below) and the sample stage.
-- Run with tests/run_tests.py (LuaJIT through lupa). docs/REPAIR.md "Crash resume" lists what only the game can check
-- (the real set-down with spawn.safeTeleport, the car's frame vectors, the ground ray).
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
local car = { lat = 0, lon = 0, speed = 0, ve = 0, vn = 0, heading = 0, alt = 1250 }
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

local resume = require('rallyRaid/resume')
local ccfg = cfg.carRecovery
-- since 18 Nov the recovery limits are off by default (unlimited, anywhere: Wyans); this scenario runs with the old
-- limits set (an event can still set them) and checks the default where it matters (sections 4 and 6)
local rcfg = cfg.resume
check(rcfg.maxPerRally == nil and rcfg.maxPerStage == nil and rcfg.noResumeNearFinishM == nil, 'default: no recovery limits')
rcfg.maxPerRally, rcfg.maxPerStage, rcfg.noResumeNearFinishM = 3, 1, 1000
-- the car's frame for the vehicle half: forward along the heading, up = z
obj.getDirectionVector = function() local h = math.rad(car.heading or 0); return { x = math.sin(h), y = math.cos(h), z = 0 } end
obj.getDirectionVectorUp = function()   -- car.upZ: tipped over sideways (its up vector's z)
  local z = car.upZ or 1
  local s_, h = math.sqrt(1 - z * z), math.rad(car.heading or 0)
  return { x = s_ * math.cos(h), y = -s_ * math.sin(h), z = z }
end
local basePose = beamngEarth_api.pose
beamngEarth_api.pose = function() local p = basePose(); p.alt = car.alt; return p end
-- the set-down: the fake car goes there and (like spawn.safeTeleport with resetVehicle) is reset
local PLACE_RESETS, FAR, places, teleports = true, false, {}, {}
local realPlace, realCanPlace = resume.game.place, resume.game.canPlaceLocally
resume.game.place = function(t, reset)
  places[#places + 1] = { lat = t.lat, lon = t.lon, heading = t.heading, alt = t.alt, reset = reset }
  car.lat, car.lon, car.heading, car.speed, car.ve, car.vn = t.lat, t.lon, t.heading, 0, 0, 0
  local r = PLACE_RESETS and reset ~= false
  if r then RESET_NOW() end
  return true, nil, r, 'fake'
end
resume.game.canPlaceLocally = function() return not FAR end
-- (BeamNG.Earth sets the car down after its teleport with a reset of its own: that one must not count as ours)
resume.game.teleport = function(lat, lon, name) teleports[#teleports + 1] = { lat = lat, lon = lon, name = name }; car.lat, car.lon = lat, lon; RESET_NOW(); return true end

local function step(dt) core.onUpdate(dt, dt); pump() end
local geo = require('rallyRaid/geo')

-- the game-crash saves go to real files in a temp folder (the game's user folder stand-in); the clock is ours
local gameResume = require('rallyRaid/gameResume')
local NOW = 1800000000
local NO_RENAME, WRITE_FAIL = false, nil
local function real(p) return TMP_DIR .. p end
local function dirOf(p) return p:match('^(.*)/[^/]*$') or '.' end
local function testIO(gr)
  gr.io.write = function(p, t)
    if WRITE_FAIL and WRITE_FAIL(p) then return false end
    MKDIR(dirOf(real(p)))
    local f = io.open(real(p), 'wb'); if not f then return false end
    f:write(t); f:close(); return true
  end
  gr.io.read = function(p) local f = io.open(real(p), 'rb'); if not f then return nil end local t = f:read('*a'); f:close(); return t end
  gr.io.exists = function(p) local f = io.open(real(p), 'rb'); if f then f:close(); return true end return false end
  gr.io.rename = function(a, b) if NO_RENAME then return false end os.remove(real(b)); return os.rename(real(a), real(b)) and true or false end
  gr.io.remove = function(p) os.remove(real(p)) end
  gr.io.mkdir = function(d) MKDIR(real(d)) end
  gr.io.encode = JSON_ENCODE
  gr.io.decode = function(x) local ok, r = pcall(DECODE_JSON, x); if ok then return r end end
  gr.io.time = function() return NOW end
end
local CAR_MODEL, replaced = 'pickup', {}
local function testGame(gr)
  gr.game.vehicleInfo = function() return { model = CAR_MODEL, config = 'vehicles/' .. CAR_MODEL .. '/rally.pc', vehId = VEH_ID } end
  gr.game.replaceVehicle = function(model, config) replaced[#replaced + 1] = { model = model, config = config }; CAR_MODEL = model; return true end
end
testIO(gameResume); testGame(gameResume)
local STOP_AT   -- stage clock at which driveTo stops early
local function driveTo(lat, lon, kmh)
  local vms = kmh / 3.6
  for _ = 1, 100000 do
    local d = geo.dist(car.lat, car.lon, lat, lon)
    if d < 0.5 then break end
    if STOP_AT and core._debug() and core._debug().phase == 'running' and core._debug().clock >= STOP_AT then return 'stopped' end
    local b = geo.bearing(car.lat, car.lon, lat, lon)
    local move = math.min(d, vms * 0.1)
    car.lat = car.lat + move * math.cos(math.rad(b)) / 111195
    car.lon = car.lon + move * math.sin(math.rad(b)) / (111195 * math.cos(math.rad(car.lat)))
    car.speed, car.heading = vms, b
    car.ve, car.vn = vms * math.sin(math.rad(b)), vms * math.cos(math.rad(b))
    step(0.1)
    if core._debug().phase == 'finished' then return end
  end
end
local function stop() car.speed, car.ve, car.vn = 0, 0, 0; step(0.1); step(0.1) end
local function wait(s) for _ = 1, math.floor(s / 0.1 + 0.5) do step(0.1) end end
local function breakPart(part, n) for i = 1, n do phys.broken[beamByPart[part][i]] = true end end
local function dentPart(part, ratio) for _, b in ipairs(beamByPart[part]) do phys.rest[b] = origLen(vdata.beams[b]) * (1 - ratio) end end
local function brokenIn(part) local n = 0; for _, b in ipairs(beamByPart[part]) do if phys.broken[b] then n = n + 1 end end return n end
local function penaltiesOf(S, kind) local n, t = 0, 0; for _, p in ipairs(S.penalties) do if p.kind == kind then n = n + 1; t = t + p.seconds end end return n, t end
local function lastNote() return notes[#notes] or '' end

-- 1) the route line (pure) -----------------------------------------------------------------------------------------
local path
for _, st in ipairs(core.listStages()) do if st.file == 'moab-sand-flats-ss1.json' then path = st.path end end
check(core.loadStage(path) == true, 'sample stage loads')
local S = core._debug()
local stage = S.stage
local rt = resume.buildRoute(stage)
check(rt.source == 'route' and #rt.pts > 20 and rt.length > 10000, 'route from the stage legs: ' .. #rt.pts .. ' points, ' .. math.floor(rt.length) .. ' m')
local mono = true
for i = 2, #rt.wpD do if rt.wpD[i] < rt.wpD[i - 1] then mono = false end end
check(mono and rt.wpD[1] < 5 and math.abs(rt.wpD[#rt.wpD] - rt.length) < 5, 'every waypoint has its place on the route, in order, DSS at 0 and ASS at the end')
local kmOk = true
for i, w in ipairs(stage.waypoints) do if math.abs(resume.kmAt(rt, rt.wpD[i]) - w.km) > 1e-6 then kmOk = false end end
check(kmOk, 'kmAt gives each waypoint its roadbook km')
check(resume.kmAt(rt, (rt.wpD[2] + rt.wpD[3]) / 2) > stage.waypoints[2].km and resume.kmAt(rt, (rt.wpD[2] + rt.wpD[3]) / 2) < stage.waypoints[3].km, 'kmAt between two waypoints lies between their km')
local mid = resume.pointAt(rt, 5000)
local n0 = resume.nearest(rt, mid.lat, mid.lon)
check(n0 and math.abs(n0.d - 5000) < 1 and n0.off < 0.5, 'a point on the route is found again at its d')
-- 40 m to the side
local sideLat, sideLon = mid.lat + 40 * math.cos(math.rad(mid.heading + 90)) / 110540, mid.lon + 40 * math.sin(math.rad(mid.heading + 90)) / (111320 * math.cos(math.rad(mid.lat)))
local n1 = resume.nearest(rt, sideLat, sideLon, 4000, 6000)
check(n1 and math.abs(n1.off - 40) < 3 and math.abs(n1.d - 5000) < 40, string.format('40 m off the route: nearest place %.0f m away at d %.0f', n1.off, n1.d))
local nw = resume.nearest(rt, mid.lat, mid.lon, 6000, 7000)
check(nw and nw.d >= 6000 - 1e-6 and nw.d <= 7000 + 1e-6, 'the search keeps to its window (a route that passes the same place twice)')
local legH = geo.bearing(rt.pts[1].lat, rt.pts[1].lon, rt.pts[2].lat, rt.pts[2].lon)
check(math.abs(geo.angleDiff(resume.headingAt(rt, 0), legH)) < 15, 'heading along the route at the start')
local wpOnly = resume.buildRoute({ waypoints = stage.waypoints })
check(wpOnly.source == 'waypoints' and #wpOnly.pts == #stage.waypoints, 'a stage without route geometry: straight legs between the waypoints')

-- 2) the car's frame (vehicle half, pure) --------------------------------------------------------------------------
local Ba = vehRepair.basis({ getDirectionVector = function() return { x = 0, y = 1, z = 0 } end, getDirectionVectorUp = function() return { x = 0, y = 0, z = 1 } end })
local Bb = vehRepair.basis({ getDirectionVector = function() return { x = 1, y = 0, z = 0 } end, getDirectionVectorUp = function() return { x = 0, y = 0, z = 1 } end })
local q = vehRepair.toFrame(Ba, { 0.5, 2, 0.3 })
local w2 = vehRepair.fromFrame(Bb, q)
check(near(w2[1], 2) and near(w2[2], -0.5) and near(w2[3], 0.3), 'a node kept in the car frame turns with the car (north -> east)')
local w3 = vehRepair.fromFrame(Ba, vehRepair.toFrame(Ba, { 1.2, -0.7, 0.9 }))
check(near(w3[1], 1.2) and near(w3[2], -0.7) and near(w3[3], 0.9), 'car frame round trip')
local Bn = vehRepair.basis({})
check(near(Bn.f[2], 1) and near(Bn.u[3], 1) and near(Bn.r[1], 1), 'no direction vectors: world axes')

-- 3) a stage: resume states every 30 s, a crash, a resume ---------------------------------------------------------
local dss = stage.waypoints[1]
car.lat, car.lon = dss.lat, dss.lon
step(0.1); stop()
core.cmd('repairAppHere')
resume.ask()
check(ui.RallyRaidRecover and ui.RallyRaidRecover.ask and ui.RallyRaidRecover.ask.allowed == false and ui.RallyRaidRecover.ask.reason:find('only while a stage clock'), 'before the start: no resume, says why')
core.cmd('resumeCancel')
-- drive out along the route; the stage starts
local route = {}
for _, leg in ipairs(stage.route.legs) do for i = 2, #leg.points do route[#route + 1] = leg.points[i] end end
local ri = 0
local function driveOn(untilClock, kmh)
  STOP_AT = untilClock
  while ri < #route do
    ri = ri + 1
    local r = driveTo(route[ri][1], route[ri][2], kmh or 60)
    if r == 'stopped' then ri = ri - 1; break end   -- this point not reached yet
    if S.phase == 'finished' then break end
  end
  STOP_AT = nil
end
driveOn(1, 50)
check(S.phase == 'running', 'stage running')
check(#resume._R().snaps == 0, 'no resume state in the first 2 s')
driveOn(3, 60)
local R = resume._R()
check(#R.snaps == 1 and R.snaps[1].reason == 'start' and R.snaps[1].good == true, 'first resume state just after the start, good')
check(vehRepair._saved()[R.snaps[1].id] ~= nil, 'the car keeps its damage under the same id')
check(R.snaps[1].routeD and R.snaps[1].routeD < 400 and R.snaps[1].offRouteM < 5, 'it knows its place on the route')
check(R.snaps[1].progress and R.snaps[1].progress.target == 2 and R.snaps[1].progress.lastOk == 1, 'and the stage progress (DSS passed, next waypoint 2)')
-- a dent before the next resume state: it is part of the car from now on
dentPart('radiator_v8', 0.1)
tank.remainingVolume = 41
driveOn(40, 60)
check(#R.snaps == 2 and R.snaps[2].reason == 'timer' and math.abs(R.snaps[2].clock - R.snaps[1].clock - ccfg.snapshotEveryS) < 0.3, 'next resume state 30 s of stage clock later')
local snap2 = vehRepair._saved()[R.snaps[2].id]
check(snap2 and snap2.nBeams >= 2 and snap2.fuel.mainTank == 41, 'it holds the dented radiator beams and 41 l of fuel')
check(snap2.nBeams < 10, 'only the damaged beams are kept (' .. snap2.nBeams .. ')')
-- the crash, a few seconds after that snapshot... no: wait for it to be old enough first
driveOn(R.snaps[2].clock + 8, 60)
local beforeCrashClock = S.clock
local crashLat, crashLon = car.lat, car.lon
-- off the road, 40 m to the right, on its roof, the frame broken, a flat tyre, less fuel
local hd = car.heading
driveTo(car.lat + 40 * math.cos(math.rad(hd + 90)) / 110540, car.lon + 40 * math.sin(math.rad(hd + 90)) / (111320 * math.cos(math.rad(car.lat))), 30)
car.heading = (hd + 140) % 360
breakPart('pickup_frame', 2); breakPart('pickup_hood', 1); wheelState[0].isTireDeflated = true; tank.remainingVolume = 30
car.speed, car.ve, car.vn = 0, 0, 0
step(0.1); step(0.1)
local clockAtAsk = S.clock
core.cmd('resumeKey')
local st = ui.RallyRaidRecover
check(st.ask and st.ask.allowed == true, 'recoverKey (RECOVER) mid-stage: resume offered ' .. tostring(st.ask and st.ask.reason))
check(st.ask.penaltyS == 15 * 60 and st.ask.used == 0 and st.ask.max == 3 and st.ask.leftAfter == 2 and st.ask.stageUsed == 0 and st.ask.stageMax == 1, 'shows +15 min, 0 of 3 used, 2 left after it, 0 of 1 on this stage')
check(lastNote():find('RECOVER CAR%?') and lastNote():find('%+15 min') and lastNote():find('2 of 3 recoveries left'), 'and says it on screen: ' .. lastNote())
check(st.ask.snapshot and st.ask.snapshot.id == R.snaps[2].id and st.ask.snapshot.ageS >= ccfg.minSnapshotAgeS, 'uses the latest good resume state (' .. tostring(st.ask.snapshot and st.ask.snapshot.ageS) .. ' s old)')
check(math.abs(st.ask.target.backM - ccfg.backOffM) < 0.5 and st.ask.crash.offRouteM > 35 and st.ask.crash.offRouteM < 45, 'target: 30 m back along the route from the nearest place to the crash (40 m off)')
local crashD = st.ask.crash.d
check(S.clock - clockAtAsk < 0.15, 'asking does not stop the clock by itself')
-- confirm with the key again
local resetsBeforeRecovery = resets
core.cmd('resumeKey')
check(resume.busy(), 'second press confirms: resume running')
local clockAtStart = S.clock
for _ = 1, 30 do step(0.1); if not resume.busy() then break end end   -- through the set-down and the 2 s settle
check(not resume.busy(), 'resume finished')
check(math.abs(S.clock - clockAtStart) < 1e-9, 'the stage clock did not run during the resume')
local np, ns = penaltiesOf(S, 'carRecovery')
check(np == 1 and ns == 15 * 60, 'penalty +15 min added as time (carRecovery)')
check(#repair.ledger().resumes == 1 and S.repair.resumes == 1, 'counted once in the rally and on the stage (repair.countResume)')
check(#places == 1, 'the car was set down once')
local tgt = st.ask.target
check(geo.dist(car.lat, car.lon, tgt.lat, tgt.lon) < 0.5 and math.abs(geo.angleDiff(car.heading, tgt.heading)) < 1e-6, 'set down at the target, facing along the route')
local nr = resume.nearest(rt, car.lat, car.lon, crashD - 200, crashD + 200)
check(nr.off < 1 and nr.d < crashD and crashD - nr.d > 25, string.format('on the route, %.0f m behind the crash', crashD - nr.d))
check(math.abs(geo.angleDiff(car.heading, resume.headingAt(rt, nr.d))) < 5, 'facing the way the route goes')
-- 18 Nov (in game: "Recover fully repaired the vehicle"): near the car there is no reset at all; every bit of the
-- crash damage stays, nothing older comes back
check(places[1].reset == false and resets == resetsBeforeRecovery, 'near: set down WITHOUT a reset (spawn.safeTeleport resetVehicle = false)')
check(brokenIn('pickup_frame') == 2 and brokenIn('pickup_hood') == 1, 'crash damage (frame, hood) kept: not repaired')
local radDent = true
for _, b in ipairs(beamByPart['radiator_v8']) do if not near(phys.rest[b], origLen(vdata.beams[b]) * 0.9, 1e-9) then radDent = false end end
check(radDent, 'the radiator dent kept')
check(wheelState[0].isTireDeflated == true, 'the tyre that went flat in the crash is still flat')
check(tank.remainingVolume == 30, 'fuel as it was (30 l), not a full tank')
check(math.abs(core._debug() and select(2, core._debug()).trip / 1000 - tgt.km) < 0.01, 'trip set to the roadbook km where the car is now (' .. tgt.km .. ')')
check(not S.flags.positionJump and not S.flags.teleported and not S.flags.unauthorizedReset, 'not flagged: no position jump, no teleport, no unauthorized reset')
check(#S.repair.resets == 0, 'the set-down reset is not logged as a reset the app did not make')
local le = S.repair.resumesLog[1]
check(le and le.kind == 'carRecovery' and le.penaltyS == 900 and le.outcome == 'penalty' and le.rallyCount == 1, 'logged in the stage resumes (kind carRecovery)')
check(le.resume and le.resume.damageFrom == 'kept (no reset)' and le.resume.snapshot and le.resume.snapshot.id == st.ask.snapshot.id, 'logged: damage kept (no reset), the resume state used for the place')
check(le.resume.to.km == tgt.km and le.resume.from.offRouteM > 35 and le.resume.pausedS >= ccfg.settleS, 'where from, where to, how long the clock was stopped (' .. tostring(le.resume.pausedS) .. ' s)')
check(lastNote():find('car recovery 1 of 3 done') and lastNote():find('%+15 min'), 'tells the driver: ' .. lastNote())
check(ui.RallyRaidUpdate and ui.RallyRaidUpdate.paused == nil, 'HUD no longer shows the clock stopped')
local sawHook = false; for _, ev in ipairs(events) do if ev.n == 'onRallyRaidCarRecovery' then sawHook = true end end
check(sawHook, 'game hook onRallyRaidCarRecovery')
-- older resume states are not used again; a fresh one comes
for _, sn in ipairs(R.snaps) do if sn.clock <= clockAtStart then check(not sn.good, 'resume state from before the resume is not good any more') end end
-- 4) a second crash on the same stage: refused, the stage would be retired ------------------------------------------
driveOn(S.clock + 10, 60)
stop()
core.cmd('resumeKey')
st = ui.RallyRaidRecover
check(st.ask.allowed == false and st.ask.reason:find('second recovery / reset on this stage') and st.ask.retireInstead == true, 'second resume on the stage: refused, RETIRE offered: ' .. tostring(st.ask.reason))
core.cmd('resumeKey')   -- the key again does not confirm a refused one
check(not resume.busy() and #repair.ledger().resumes == 1, 'nothing counted for a refused resume')
check(S.carRecoveryLog and #S.carRecoveryLog >= 2, 'refusals logged')
core.cmd('resumeCancel')
-- with the default rules (no limits) the same second recovery on the stage is offered, at 30 min
rcfg.maxPerRally, rcfg.maxPerStage, rcfg.noResumeNearFinishM = nil, nil, nil
core.cmd('resumeKey')
st = ui.RallyRaidRecover
check(st.ask.allowed == true and st.ask.penaltyS == 30 * 60 and st.ask.max == nil and st.ask.leftAfter == nil and st.ask.used == 1 and st.ask.penaltySoFarS == 15 * 60,
  'no limits: a second recovery on the same stage is offered, +30 min, 1 used so far (+15 min): ' .. tostring(st.ask.reason))
check(lastNote():find('recovery 2 of the rally %(no limit; 15 min so far%)'), 'says it on screen: ' .. lastNote())
core.cmd('resumeCancel')
rcfg.maxPerRally, rcfg.maxPerStage, rcfg.noResumeNearFinishM = 3, 1, 1000
-- the speed rule (another stage would allow it): moving at 50 km/h
-- 5) drive to the finish: everything is in the result -------------------------------------------------------------
driveOn(1e9, 70)
check(S.phase == 'finished' and S.result, 'stage finished')
local res = S.result
check(res.carRecovery and #res.carRecovery.attempts >= 3 and res.carRecovery.rules.snapshotEveryS == 30, 'result: carRecovery attempts and the rules')
local kinds = {}; for _, a in ipairs(res.carRecovery.attempts) do kinds[a.kind] = (kinds[a.kind] or 0) + 1 end
check(kinds.resumed == 1 and kinds.refused >= 2, 'attempts: 1 resumed, refusals logged')
check(res.carRecovery.snapshotsTaken >= 3, 'result: how many resume states were taken (' .. res.carRecovery.snapshotsTaken .. ')')
check(res.resumes.stage == 1 and res.resumes.rally == 1 and res.resumes.log[1].kind == 'carRecovery', 'result resumes (repair v1 fields) include the car recovery')
local pr = 0; for _, p in ipairs(res.penalties) do if p.kind == 'carRecovery' then pr = pr + p.seconds end end
check(pr == 900, 'the penalty is in the result penalties')
check(res.official == true, 'still an official run')
check(res.stageTime < (res.distanceDriven * 1000) / (60 / 3.6) + 120, 'stage time has no resume time in it')

-- 6) stage 2 of the rally: the next one costs 30 min; none within 1 km of the ASS; retire on purpose ---------------
local function newRun()
  check(core.loadStage(path) == true, 'stage loads again')
  S = core._debug()
  car.lat, car.lon = dss.lat, dss.lon
  resetCar(); step(0.1); stop()
  ri = 0
  driveOn(1, 50)
  R = resume._R()
end
newRun()
check(S.phase == 'running', 'stage 2 running')
driveOn(8, 60)
car.speed = 50 / 3.6; car.ve = car.speed
core.cmd('resumeAsk')
check(ui.RallyRaidRecover.ask.allowed == false and ui.RallyRaidRecover.ask.reason:find('stop first') and not ui.RallyRaidRecover.ask.retireInstead, 'moving at 50 km/h: stop first (no retire offered)')
stop()
core.cmd('resumeAsk')
check(ui.RallyRaidRecover.ask.allowed and ui.RallyRaidRecover.ask.penaltyS == 30 * 60 and ui.RallyRaidRecover.ask.leftAfter == 1, 'stopped: offered, the second of the rally costs 30 min, 1 left after it')
core.cmd('resumeCancel')
check(ui.RallyRaidRecover.ask == nil, 'cancel closes it')
-- the car never answers (far: the damage must be captured first): nothing charged, the clock runs again
FAR = true
ANSWER = false
core.cmd('resumeAsk'); core.cmd('resumeConfirm')
check(resume.busy(), 'resume started')
local c0 = S.clock
wait(ccfg.answerTimeoutS + 1)
check(not resume.busy() and #repair.ledger().resumes == 1 and penaltiesOf(S, 'carRecovery') == 0, 'the car did not answer: failed, nothing charged')
check(ui.RallyRaidRecover.msg and ui.RallyRaidRecover.msg:find('No penalty was charged'), 'says so: ' .. tostring(ui.RallyRaidRecover.msg))
check(S.clock - c0 < 1.15, string.format('clock stopped while waiting (ran %.1f s of %.0f, after the failure)', S.clock - c0, ccfg.answerTimeoutS + 1))
step(0.1); step(0.1)
check(S.clock > c0, 'and runs again after')
ANSWER = true
FAR = false
-- drive on to within 1 km of the ASS
local ass = stage.waypoints[#stage.waypoints]
while ri < #route and geo.dist(car.lat, car.lon, ass.lat, ass.lon) > 800 do ri = ri + 1; driveTo(route[ri][1], route[ri][2], 70) end
stop()
check(S.phase == 'running' and geo.dist(car.lat, car.lon, ass.lat, ass.lon) < 1000, 'within 1 km of the ASS')
core.cmd('resumeKey')
st = ui.RallyRaidRecover
check(st.ask.allowed == false and st.ask.reason:find('within 1000 m of the ASS') and st.ask.retireInstead, 'within 1 km of the ASS: refused, retire offered: ' .. st.ask.reason)
core.cmd('resumeCancel')
rcfg.maxPerRally, rcfg.maxPerStage, rcfg.noResumeNearFinishM = nil, nil, nil
core.cmd('resumeKey')
check(ui.RallyRaidRecover.ask.allowed == true, 'no limits (the default): a recovery within 1 km of the ASS is offered too')
core.cmd('resumeCancel')
rcfg.maxPerRally, rcfg.maxPerStage, rcfg.noResumeNearFinishM = 3, 1, 1000
core.cmd('resumeKey')
core.cmd('resumeRetire')
check(S.phase == 'running' and ui.RallyRaidRecover.askRetire == true, 'RETIRE asks "sure?" first')
core.cmd('resumeRetire')
check(S.phase == 'finished' and S.result.retired and tostring(S.result.retired):find('stuck car'), 'retired by the driver: ' .. tostring(S.result.retired))
local rk = {}; for _, a in ipairs(S.result.carRecovery.attempts) do rk[a.kind] = true end
check(rk.retiredByDriver and rk.failed and rk.refused, 'result logs the failed one, the refusals and the retirement')
check(#repair.ledger().resumes == 1, 'retiring does not use a resume')

-- 7) stage 3: the far path (BeamNG.Earth teleport first), a set-down that does not reset, no resume state -----------
newRun()
driveOn(1.5, 50)
check(#R.snaps == 0, 'no resume state yet')
for k in pairs(vehRepair._saved()) do vehRepair._saved()[k] = nil end
breakPart('pickup_hood', 1)
stop()
FAR, PLACE_RESETS = true, false
resets = 0
core.cmd('resumeAsk')
check(ui.RallyRaidRecover.ask.allowed and ui.RallyRaidRecover.ask.snapshot == nil, 'no resume state yet: still allowed (the car keeps the damage it has now)')
core.cmd('resumeConfirm')
check(resume._R().busy.phase == 'capture', 'no resume state: the damage as it is now is saved first')
pump()
check(#teleports == 1 and resume._R().busy.phase == 'teleport', 'world not loaded there: BeamNG.Earth teleport first')
step(0.1)
core.onBeamNGEarthTeleported({ lat = car.lat, lon = car.lon })
check(not S.flags.teleported, 'the resume teleport does not mark the run unofficial')
for _ = 1, 40 do step(0.1) end
check(not resume.busy() and resets == 2, 'set-down without a reset: the car is reset in place once (after the teleport\'s own reset)')
check(brokenIn('pickup_hood') == 1, 'no resume state: the damage it had is kept (not a free repair)')
local le3 = S.repair.resumesLog[1]
check(le3 and le3.resume.damageFrom == 'now' and le3.resume.far == true and le3.penaltyS == 30 * 60 and le3.rallyCount == 2, 'logged: damage from now, far, +30 min (second resume of the rally)')
FAR, PLACE_RESETS = false, true

-- 8) stage 4: all 3 rally resumes used; repairs invalidate older resume states; a reset the app did not make --------
table.insert(repair.ledger().resumes, { kind = 'carRecovery', outcome = 'penalty', stageId = 'earlier' })   -- one more, from an earlier stage
newRun()
check(#repair.ledger().resumes == 3, 'three resumes used in the rally')
driveOn(40, 60)
check(#R.snaps >= 2, 'resume states taken')
stop()
dentPart('radiator_v8', 0.2)
core.cmd('repairOpen'); pump()
core.cmd('repairConfirm', 'radiator'); pump(); for _ = 1, 5 do step(0.1) end
local anyGoodOld = false
for _, sn in ipairs(R.snaps) do if sn.good and sn.clock < S.clock - 1.5 then anyGoodOld = true end end
check(not anyGoodOld, 'after a repair the older resume states are no longer used')
wait(2)
check(R.snaps[#R.snaps].good, 'a fresh one is taken just after the repair')
core.cmd('resumeKey')
check(ui.RallyRaidRecover.ask.allowed == false and ui.RallyRaidRecover.ask.reason:find('all 3 recoveries'), 'fourth in the rally: refused (' .. ui.RallyRaidRecover.ask.reason .. ')')
core.cmd('resumeCancel')
-- an unauthorized reset still goes through repair v1 (the stage is retired: no resumes left)
RESET_NOW()
check(S.phase == 'finished' and tostring(S.result.retired):find('unauthorized'), 'a reset the app did not make, no resumes left: stage retired by repair v1')

-- 9) snapshot quality: off the route, tipped over --------------------------------------------------------------------
repair.newRally()
newRun()
driveOn(3, 50)
local lastId = R.snaps[#R.snaps].id
car.upZ = 0.2
driveOn(34, 60)
check(R.snaps[#R.snaps].id > lastId and R.snaps[#R.snaps].good == false and R.snaps[#R.snaps].why == 'car not upright', 'tipped over: that resume state is not good')
car.upZ = nil
driveOn(64, 60)
local sOk = R.snaps[#R.snaps]
check(sOk.good, 'upright again: good')
-- far off the route
local h2 = car.heading
local offLat, offLon
for _, side in ipairs({ 90, -90, 45, -45, 135, -135 }) do
  for dist = 500, 1500, 100 do
    local la = car.lat + dist * math.cos(math.rad(h2 + side)) / 110540
    local lo = car.lon + dist * math.sin(math.rad(h2 + side)) / (111320 * math.cos(math.rad(car.lat)))
    if resume.nearest(rt, la, lo).off > 600 then offLat, offLon = la, lo break end
  end
  if offLat then break end
end
check(offLat ~= nil, 'found a place 600 m from the route')
driveTo(offLat, offLon, 60)
local arrivedId = R.snaps[#R.snaps].id
for _ = 1, 400 do step(0.1); if R.snaps[#R.snaps].id ~= arrivedId then break end end
for i = #R.snaps - 1, 1, -1 do if R.snaps[i].good then sOk = R.snaps[i] break end end
check(R.snaps[#R.snaps].good == false and tostring(R.snaps[#R.snaps].why):find('off the route'), 'far off the route: not good (' .. tostring(R.snaps[#R.snaps].why) .. ')')
stop()
core.cmd('resumeAsk')
st = ui.RallyRaidRecover
check(st.ask.allowed and st.ask.snapshot.id == sOk.id, 'a resume uses the last good one, not the off-route one')
check(st.ask.crash.offRouteM > 550, 'and goes back to the route from ' .. math.floor(st.ask.crash.offRouteM) .. ' m out')
core.cmd('resumeConfirm')
for _ = 1, 40 do step(0.1) end
check(not resume.busy() and S.repair.resumes == 1 and penaltiesOf(S, 'carRecovery') == 1, 'resumed from off the route (first of the new rally)')
local _, tf = penaltiesOf(S, 'carRecovery')
check(tf == 15 * 60, 'new rally: 15 min again')
check(resume.nearest(rt, car.lat, car.lon).off < 1, 'back on the route')

-- 10) the real set-down code with stand-ins for the game's functions ---------------------------------------------
do
  local V = {}
  V.__index = V
  function vec3(x, y, z) return setmetatable({ x = x, y = y, z = z }, V) end
  function V:length() return math.sqrt(self.x ^ 2 + self.y ^ 2 + self.z ^ 2) end
  function V:normalized() local l = self:length(); return vec3(self.x / l, self.y / l, self.z / l) end
  local qcall
  function quatFromDir(d, up) qcall = { d = d, up = up }; return { x = 0, y = 0, z = 0.1, w = 0.99 } end
  local rays, tele = {}, nil
  function castRayStatic(from, dir, len) rays[#rays + 1] = { from = from, dir = dir, len = len }; return from.z - 1302 end
  spawn = { safeTeleport = function(veh, pos, rot, a, b, c, d, reset) tele = { pos = pos, rot = rot, c = c, reset = reset } end }
  -- 1 m per 1e-5 deg north / east, origin at 38.6, -109.5 (a flat-earth stand-in for BeamNG.Earth's anchor)
  beamngEarth_api.toGame = function(lat, lon, h) return (lon + 109.5) * 1e5 * math.cos(math.rad(38.6)) * 1.1132, (lat - 38.6) * 1e5 * 1.1054, h or 0 end
  local fakeVeh = { getPosition = function() return { x = 0, y = 0, z = 1310 } end, setPositionRotation = function() end }
  be = { getPlayerVehicle = function() return fakeVeh end }
  local ok, why, resets_ = realPlace({ lat = 38.601, lon = -109.499, alt = 1300, heading = 90 })
  check(ok == true and resets_ == true, 'real set-down: spawn.safeTeleport used, it resets the car (' .. tostring(why) .. ')')
  check(tele and tele.reset == true and tele.c == false, 'safeTeleport called as BeamNG.Earth does (resetVehicle = true, removeTraffic = false)')
  check(tele and near(tele.pos.z, 1302 + ccfg.liftM, 1e-6), 'set down on the ground the ray found, ' .. ccfg.liftM .. ' m over it')
  check(rays[1] and rays[1].from.z == 1410 and rays[1].dir.z == -1, 'ground ray from 100 m over the higher of route and car, straight down')
  check(qcall and qcall.d.x > 0.99 and math.abs(qcall.d.y) < 0.01 and qcall.up.z == 1, 'faces east for heading 90 (direction from two converted points), upright')
  local stopped_ = 0
  fakeVeh.applyClusterVelocityScaleAdd = function(_, c, sc, x, y, z) if sc == 0 and x == 0 and y == 0 and z == 0 then stopped_ = stopped_ + 1 end end
  tele = nil
  local okK, whyK, resK, howK = realPlace({ lat = 38.601, lon = -109.499, alt = 1300, heading = 90 }, false)
  check(okK == true and resK == false and howK == 'spawn.safeTeleport', 'RECOVER (near): real set-down returns no reset (' .. tostring(whyK) .. ')')
  check(tele and tele.reset == false and tele.c == false, 'spawn.safeTeleport called with resetVehicle = false: damage kept (the game\'s own upright recovery)')
  check(stopped_ == 1, 'and the car stopped (applyClusterVelocityScaleAdd scale 0)')
  check(realCanPlace({ lat = 38.6, lon = -109.5 }) == true, 'world loaded there: set down directly')
  beamngEarth_api.toGame = function() return nil end
  check(realCanPlace({ lat = 38.6, lon = -109.5 }) == false, 'world not loaded there: BeamNG.Earth teleport first')
  spawn = nil
  beamngEarth_api.toGame = function(lat, lon, h) return 1, 2, 3 end
  local ok2, _, r2 = realPlace({ lat = 38.6, lon = -109.5, heading = 0 })
  check(ok2 == true and r2 == false, 'no spawn.safeTeleport: setPositionRotation, then the resume resets the car itself')
  vec3, quatFromDir, castRayStatic, be = nil, nil, nil, nil
end

-- 11) RECOVER CAR can be switched off (repairConfig carRecovery.enabled) ---------------------------------------------
check(cfg.carRecovery.enabled == true, 'RECOVER CAR is on by default (the one reset allowed in a stage)')
repair.newRally()
newRun()
driveOn(6, 50); stop()
cfg.carRecovery.enabled = false
core.cmd('recoverAsk')
check(ui.RallyRaidRecover.ask.allowed == false and ui.RallyRaidRecover.ask.reason:find('switched off'), 'switched off: refused, says so')
cfg.carRecovery.enabled = true
core.cmd('recoverAsk')
check(ui.RallyRaidRecover.ask.allowed == true and ui.RallyRaidRecover.ask.penaltyS == 15 * 60, 'on again: offered at the unauthorized-reset penalty (+15 min first)')
core.cmd('recoverCancel')
check(repair.isBlocked() and blockedNow(), "BeamNG's own reset keys stay blocked in the stage")
core.cmd('abort')

-- 12) GAME-CRASH RESUME: saves on disk while the stage runs --------------------------------------------------------
local gcfg = cfg.gameCrashResume
check(gcfg.firstPenaltyS == 0 and gcfg.laterPenaltyS == 0 and gcfg.maxPerRally == nil and gcfg.maxPerStage == nil and gcfg.noResumeNearFinishM == nil
  and gcfg.flagForReview == true and gcfg.useOfficialRules == false, 'defaults: no penalty, no limits, flagged for review, official rules off')
repair.newRally()
local function base() return gameResume.basePath(repair.ledger().id, stage.id) end
local function readSave(i) local t = gameResume.io.read(gameResume.paths(base())[i or 1]); return t and DECODE_JSON(t) end
newRun()
check(gameResume._R().savesWritten >= 1 and readSave() and readSave().reason == 'start', 'a save at the start')
local seq0 = readSave().seq
driveOn(20, 60)
dentPart('radiator_v8', 0.1); tank.remainingVolume = 41
driveOn(40, 60)
local sv = readSave()
check(sv and sv.reason == 'timer' and math.abs(sv.stage.clock - 30) < 1.5, 'a save 30 s of stage clock later (' .. tostring(sv and sv.stage.clock) .. ')')
check(sv.car and sv.car.nBeams >= 2 and sv.car.fuel.mainTank == 41 and sv.car.damage.radiator > 0, 'it holds the car: dented radiator, 41 l, damage per group')
check(sv.pos and near(sv.pos.lat, sv.summary.lat) and sv.pos.alt == 1250 and sv.vehicle.model == 'pickup', 'position as lat / lon / alt, the car model')
check(readSave(2) and readSave(2).seq < sv.seq, 'the save before it is kept as .1')
check(not gameResume.io.exists(base() .. '.json.tmp'), 'no temp file left behind')
-- a waypoint: saved at once
local tg = S.target
while S.target == tg and S.phase == 'running' do ri = ri + 1; driveTo(route[ri][1], route[ri][2], 60) end
step(0.1); pump()
sv = readSave()
check(sv.reason == 'event' and sv.summary.validated == tg and sv.stage.target == S.target, 'waypoint passed: saved at once (' .. sv.summary.validated .. ' validated)')
-- a roadside wheel change (a spare, a penalty), a flat tyre, then a car recovery: each saved at once
stop()
core.cmd('repairOpen'); pump()
core.cmd('repairConfirm', 'wheel:FR'); pump(); for _ = 1, 5 do step(0.1) end
sv = readSave()
check(sv.summary.sparesUsed == 1 and sv.summary.repairs == 1 and sv.summary.penaltyTotal == S.penaltyTotal, 'repair saved at once: 1 spare, its penalty')
driveOn(S.clock + 12, 60); stop()
core.cmd('recoverKey'); core.cmd('recoverKey')
for _ = 1, 40 do step(0.1); if not resume.busy() then break end end
step(0.1); step(0.1)
sv = readSave()
check(sv.summary.recoveries == 1 and penaltiesOf(S, 'carRecovery') == 1, 'car recovery (+15 min) saved at once, counted')
wheelState[1].isTireDeflated = true
driveOn(S.clock + 35, 60)
sv = readSave()
local beat = DECODE_JSON(gameResume.io.read(base() .. '.beat.json'))
check(sv.car.deflated[1] == 1 and sv.car.fuel.mainTank ~= nil, 'the flat tyre is in the save')
-- drive on past the last save (no waypoint, no timer save in between); the heartbeat knows how far the stage got
for _ = 1, 10 do
  sv = readSave()
  driveOn(S.clock + 12, 60)
  if readSave().seq == sv.seq then break end
end
beat = DECODE_JSON(gameResume.io.read(base() .. '.beat.json'))
check(readSave().seq == sv.seq and beat and beat.clock > sv.stage.clock + 5, string.format('heartbeat: %.1f s of stage clock after the save', beat.clock - sv.stage.clock))
local want = { clock = sv.stage.clock, target = S.target, pen = sv.summary.penaltyTotal, spares = sv.summary.sparesUsed, rec = sv.summary.recoveries,
  trip = sv.stage.odo.trip, lat = sv.pos.lat, lon = sv.pos.lon, heading = sv.pos.heading, validated = sv.summary.validated }
check(want.pen == S.penaltyTotal and want.rec == 1, 'nothing new since that save')
local ledgerLen = #repair.ledger().resumes

-- 13) THE KILL: no clean shutdown, a fresh game (every module new, a new car at the DSS), 10 min later ---------------
local function boot()
  for k in pairs(package.loaded) do if k:find('^rallyRaid/') then package.loaded[k] = nil end end
  vehRepair = require('rallyRaid/vehRepair')
  core = require('rallyRaid/core')
  repair = require('rallyRaid/repair')
  cfg = require('rallyRaid/repairConfig')
  resume = require('rallyRaid/resume')
  gameResume = require('rallyRaid/gameResume')
  ccfg = cfg.carRecovery
  rallyRaid_core, rallyRaid_vehRepair = core, vehRepair
  repair.game.vehId = function() return VEH_ID end
  repair.game.send = function(cmd) if ANSWER then ge2veh[#ge2veh + 1] = cmd end return true end
  repair.game.resetInPlace = function() RESET_NOW(); return true end
  repair.game.iprLoaded = function() return IPR_LOADED == true end
  resume.game.place = function(t, reset)
    places[#places + 1] = { lat = t.lat, lon = t.lon, heading = t.heading, alt = t.alt, reset = reset }
    car.lat, car.lon, car.heading, car.speed, car.ve, car.vn = t.lat, t.lon, t.heading, 0, 0, 0
    local r = PLACE_RESETS and reset ~= false
    if r then RESET_NOW() end
    return true, nil, r, 'fake'
  end
  resume.game.canPlaceLocally = function() return not FAR end
  resume.game.teleport = function(lat, lon, name) teleports[#teleports + 1] = { lat = lat, lon = lon, name = name }; car.lat, car.lon = lat, lon; RESET_NOW(); return true end
  testIO(gameResume); testGame(gameResume)
  ge2veh, veh2ge = {}, {}
  core.onExtensionLoaded()
end
local function kill(after, model)
  ge2veh, veh2ge = {}, {}
  NOW = NOW + after
  resetCar(); for _, w in pairs(wheelState) do w.isTireDeflated = nil end
  CAR_MODEL = model or CAR_MODEL
  boot()
  car.lat, car.lon, car.heading, car.speed, car.ve, car.vn = dss.lat, dss.lon, 0, 0, 0, 0
  step(0.1)
end
local saveFile = gameResume.io.read(gameResume.paths(base())[1])
kill(600, 'etk800')
check(gameResume.io.read(gameResume.paths(base())[1]) == saveFile, 'the save survived the kill')
check(#repair.ledger().resumes == ledgerLen, 'the rally ledger came back from disk too')
places, teleports, replaced = {}, {}, {}
check(core.loadStage(path) == true, 'the stage loads after the relaunch')
S = core._debug()
local gr = ui.RallyRaidGameResume
check(gr and gr.offer, 'a save was found: resume offered')
check(gr.offer and math.abs(gr.offer.elapsedS - want.clock) < 1e-6 and gr.offer.savedAgoS == 600, 'offer: the saved elapsed time, saved 10 min ago')
check(gr.offer and gr.offer.text == string.format('Resume from last save (%s elapsed, saved 10 min ago)', gameResume.hms(want.clock)), 'the offer text: ' .. tostring(gr.offer and gr.offer.text))
check(gr.offer and gr.offer.stageTimeLostS and gr.offer.stageTimeLostS >= 5, 'the heartbeat: about ' .. tostring(gr.offer and gr.offer.stageTimeLostS) .. ' s of stage time lost after the save')
check(gr.offer and gr.offer.policy.penaltyS == 0 and not gr.offer.policy.refused, 'no penalty, nothing refused')
check(lastNote():find('Resume from last save'), 'and said on screen: ' .. lastNote())
check(S.phase == 'armed', 'nothing changed until the driver picks')
-- gameResumeKey twice (RESUME, CONFIRM RESUME): resume
FAR = true
core.cmd('gameResumeKey')
check(not gameResume.busy(), 'first press shows it')
core.cmd('gameResumeKey')
check(gameResume.busy(), 'second press resumes')
check(#replaced == 1 and replaced[1].model == 'pickup' and replaced[1].config == 'vehicles/pickup/rally.pc', 'another car was out: the saved car (model + config) is spawned first')
for _ = 1, 10 do step(0.1); if gameResume._R().busy and gameResume._R().busy.phase == 'teleport' then break end end
check(#teleports == 1 and gameResume._R().busy.phase == 'teleport', 'far from the DSS: BeamNG.Earth teleport first')
core.onBeamNGEarthTeleported({ lat = car.lat, lon = car.lon })
for _ = 1, 60 do step(0.1); if not gameResume.busy() then break end end
FAR = false
check(not gameResume.busy() and S.phase == 'running', 'resumed: the stage is running again')
check(math.abs(S.clock - want.clock) < 1e-6, string.format('the clock is the saved elapsed time (%.1f)', S.clock))
check(S.target == want.target and S.penaltyTotal == want.pen and S.repair.spares == want.spares and S.repair.resumes == want.rec, 'progress, penalties, spares and recoveries restored')
local okN = 0; for i = 1, #S.state do if S.state[i] == 'ok' then okN = okN + 1 end end
check(okN == want.validated and S.times[1] == 0, 'waypoint statuses and times restored')
check(math.abs(select(2, core._debug()).trip - want.trip) < 1e-6, 'the trip odometer restored')
check(geo.dist(car.lat, car.lon, want.lat, want.lon) < 0.5 and math.abs(geo.angleDiff(car.heading, want.heading)) < 0.5, 'the car is set down where it was saved, facing the same way')
local radDent2 = true
for _, b in ipairs(beamByPart['radiator_v8']) do if not near(phys.rest[b], origLen(vdata.beams[b]) * 0.9, 1e-9) then radDent2 = false end end
check(radDent2, 'the radiator dent is back')
check(wheelState[1].isTireDeflated == true, 'the flat tyre is back')
check(tank.remainingVolume ~= 60, 'fuel as saved, not a full tank')
check(not S.flags.positionJump and not S.flags.teleported and not S.flags.unauthorizedReset and #S.repair.resets == 0, 'no position jump, teleport or unauthorized-reset flags from the resume')
-- the review flag
local e = S.gameResumeLog[1]
check(S.flags.reviewRequired and S.flags.gameCrashResume == 1 and e and e.review, 'flagged for organizer review')
check(e.resumedAt == os.date('!%Y-%m-%dT%H:%M:%SZ', NOW) and e.savedAt == sv.savedAt and e.wallGapS == 600, 'real time of the resume, of the save, 600 s gap')
check(e.stageTimeLostS and e.stageTimeLostS >= 5 and e.lastAlive and e.crashWithinS == gcfg.heartbeatEveryS, 'stage time lost after the save, estimated from the heartbeat (' .. tostring(e.stageTimeLostS) .. ' s)')
check(e.saved.clock == e.resumed.clock and e.saved.penaltyTotal == e.resumed.penaltyTotal and e.saved.validated == e.resumed.validated and e.saved.sparesUsed == e.resumed.sparesUsed, 'saved vs resumed: clock, penalties, CP progress, spares')
check(e.diff.positionM < 1 and e.diff.damageMaxDiff and e.diff.damageMaxDiff < 0.05, string.format('saved vs resumed: %.1f m apart, damage within %.3f', e.diff.positionM, e.diff.damageMaxDiff or -1))
check(e.respawned and e.respawned.from == 'etk800' and e.far == true and e.penaltyS == 0, 'logged: the car respawned, far, no penalty')
check(e.summary:find('game%-crash resume 1') and e.summary:find('no penalty'), 'one line for the organizer: ' .. e.summary)
check(#repair.ledger().gameResumes == 1 and files[repair.LEDGER_FILE].gameResumes and #files[repair.LEDGER_FILE].gameResumes == 1, 'in the rally ledger (saved)')
check(ui.RallyRaidGameResume.hold and ui.RallyRaidGameResume.flagged and ui.RallyRaidGameResume.flagged.count == 1, 'Repair app: clock held, flagged')
check(ui.RallyRaidUpdate.paused == true and ui.RallyRaidUpdate.held == true, 'HUD: clock held')
local saved2 = readSave()
check(saved2 and saved2.reason == 'resumed' and #saved2.stage.gameResumeLog == 1, 'saved again at once (a second crash resumes from here, with the flag)')
-- the clock waits for the car
wait(3)
check(math.abs(S.clock - want.clock) < 1e-6, 'standing still: the clock stays at the saved time')
driveOn(S.clock + 0.0001, 40)
for _ = 1, 3 do car.speed = 30 / 3.6; step(0.1) end
check(not gameResume.holding() and S.clock > want.clock, 'driving off starts it again')
check(e.clockReleasedBy == 'drove off', 'logged how the clock started')
-- on to the finish: the result carries the flag; the save goes
driveOn(1e9, 70)
check(S.phase == 'finished', 'stage finished after the resume')
local res2 = S.result
check(res2.gameCrashResume and res2.gameCrashResume.count == 1 and res2.gameCrashResume.flagged and #res2.gameCrashResume.review == 1, 'result: gameCrashResume with the review line')
check(res2.reviewRequired == true and res2.official == true and res2.flags.reviewRequired, 'result: review required (still official: the organizer decides)')
check(res2.resumes.stage == 1 and res2.carRecovery and res2.sparesUsed == 1, 'result: the recovery and spare from before the crash are in it')
local pr2 = 0; for _, p in ipairs(res2.penalties) do if p.kind == 'gameCrashResume' then pr2 = pr2 + 1 end end
check(pr2 == 0, 'no game-crash penalty')
check(not gameResume.io.exists(gameResume.paths(base())[1]) and not gameResume.io.exists(base() .. '.beat.json'), 'the save is cleared when the stage finishes')

-- 14) a corrupt save falls back to the one before; none good: nothing offered ------------------------------------------
newRun()
driveOn(35, 60)
local good = readSave()
local older = readSave(2)
check(good and older and older.seq < good.seq, 'two saves on disk')
local f = io.open(real(gameResume.paths(base())[1]), 'wb'); f:write(gameResume.io.read(gameResume.paths(base())[1]):sub(1, 200)); f:close()
kill(120)
core.loadStage(path); S = core._debug()
gr = ui.RallyRaidGameResume
check(gr.offer and gr.offer.used == 2 and gr.offer.skipped[1] and gr.offer.skipped[1].why:find('corrupt'), 'half-written newest save skipped (' .. tostring(gr.offer and gr.offer.skipped[1] and gr.offer.skipped[1].why) .. '), the one before offered')
check(gr.offer and math.abs(gr.offer.elapsedS - older.stage.clock) < 1e-6, 'with its own elapsed time')
core.cmd('gameResumeResume')
for _ = 1, 60 do step(0.1); if not gameResume.busy() then break end end
check(S.phase == 'running' and math.abs(S.clock - older.stage.clock) < 1e-6 and S.gameResumeLog[1].saveUsed == 2, 'resumed from the older save; the review entry says which')
core.cmd('gameResumeGo')
check(not gameResume.holding(), 'GO starts the clock')
-- every save corrupt
for i, p in ipairs(gameResume.paths(base())) do local g = io.open(real(p), 'wb'); g:write(i == 1 and '{"format": "rallyraid-gamesave", "schemaVersion": 1}' or 'xx'); g:close() end
kill(60)
core.loadStage(path); S = core._debug()
gr = ui.RallyRaidGameResume
check(not gr.offer and gr.msg and gr.msg:find('could not be used'), 'no good save: nothing offered, says why: ' .. tostring(gr.msg))
check(S.phase == 'armed', 'the stage is just loaded')

-- 15) writes: the temp file is checked; no rename on the file system; a failed write keeps the older save -----------
newRun()
driveOn(3, 50)
local before = readSave()
WRITE_FAIL = function(p) return p:find('%.tmp$') ~= nil end
check(gameResume.requestSave('test') == true, 'save asked for')
pump()
check(readSave().seq == before.seq and gameResume._R().saveFails >= 1, 'the temp file could not be written: the save on disk is untouched')
WRITE_FAIL = nil
NO_RENAME = true
gameResume.requestSave('test2'); pump()
check(readSave().reason == 'test2' and readSave(2).seq == before.seq, 'no rename on the file system: written in place, the older one kept')
NO_RENAME = false
-- the game is closed normally mid-stage: one last save; resuming it is flagged as a clean exit
driveOn(9, 50)
core.onExit()
check(readSave().reason == 'quit', 'closing the game mid-stage: a last save')
kill(30)
core.loadStage(path); S = core._debug()
core.cmd('gameResumeResume')
for _ = 1, 60 do step(0.1); if not gameResume.busy() then break end end
check(S.gameResumeLog[1] and S.gameResumeLog[1].cleanExit == true, 'the review entry says the game was closed, not crashed')
core.cmd('abort')
check(not gameResume.io.exists(gameResume.paths(base())[1]), 'abort clears the save')

-- 16) discard: the save goes, the restart is logged and flagged ------------------------------------------------------
newRun()
driveOn(35, 60)
kill(300)
core.loadStage(path); S = core._debug()
check(ui.RallyRaidGameResume.offer, 'offered again')
core.cmd('gameResumeDiscard')
check(ui.RallyRaidGameResume.askDiscard and ui.RallyRaidGameResume.offer, 'DISCARD asks "sure?" first')
core.cmd('gameResumeDiscard')
check(not ui.RallyRaidGameResume.offer and not gameResume.io.exists(gameResume.paths(base())[1]), 'discarded: the save is gone')
local disc = repair.ledger().gameResumeDiscards
check(disc and #disc == 1 and disc[1].stageId == stage.id and disc[1].savedClock > 30, 'the discard is in the rally ledger')
ri = 0
driveOn(2, 50)
check(S.phase == 'running' and S.flags.restartedAfterGameCrash == 1, 'the stage starts again from scratch, flagged as a restart')
core.cmd('wPlus')
driveOn(1e9, 70)
check(S.result.reviewRequired == true and S.result.gameCrashResume.flagged and S.result.gameCrashResume.review[1]:find('restarted from scratch'), 'result: review required for the restart')

-- 17) the official rules (one switch): 15 / 30 min, shared budget, limits; over the limit the stage is retired --------
gcfg = cfg.gameCrashResume
gcfg.useOfficialRules = true
repair.newRally()
newRun()
driveOn(35, 60)
kill(90)
gcfg = cfg.gameCrashResume
gcfg.useOfficialRules = true
core.loadStage(path); S = core._debug()
check(ui.RallyRaidGameResume.offer.policy.penaltyS == 15 * 60, 'official rules: the first resume costs 15 min')
core.cmd('gameResumeResume')
for _ = 1, 60 do step(0.1); if not gameResume.busy() then break end end
check(penaltiesOf(S, 'gameCrashResume') == 1 and S.gameResumeLog[1].penaltyS == 900, 'the 15 min penalty is added and logged')
core.cmd('gameResumeGo')
driveOn(S.clock + 35, 60)
kill(90)
gcfg = cfg.gameCrashResume
gcfg.useOfficialRules = true
core.loadStage(path); S = core._debug()
local pol = ui.RallyRaidGameResume.offer.policy
check(pol.refused and pol.retire and pol.reason:find('on this stage'), 'second on the same stage: over the limit (' .. tostring(pol.reason) .. ')')
core.cmd('gameResumeResume')
check(S.phase == 'finished' and tostring(S.result.retired):find('game crash') and S.result.reviewRequired, 'the stage is retired with the saved state, flagged')
check(math.abs(S.result.stageTime - S.result.stageTime) < 1 and S.result.gameCrashResume.resumes[2].kind == 'gameCrashResumeRetired', 'the retirement is in the review log')
gcfg.useOfficialRules = false

print(passes .. ' passed, ' .. fails .. ' failed')
return fails
