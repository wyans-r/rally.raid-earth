-- rally.raid Earth: RECOVER CAR (GE half), the one reset allowed in a stage. Required by core.lua. (It began
-- as B11 "crash resume" for a crashed CAR; the GAME crashing is rallyRaid/gameResume.lua.) The car half is the repair
-- system's vehicle extension (lua/vehicle/extensions/rallyRaid/vehRepair.lua: resumeSnapshot / resumeArm). Every
-- tunable is in rallyRaid/repairConfig.lua: the rules and penalty in M.resume (shared with resets the app did not
-- make: 15 min first, then 30 min; 3 per rally, 1 per stage, none within 1 km of the ASS), the mechanics in
-- M.carRecovery (enabled = false switches it off). Players' guide: docs/REPAIR.md "Recover car".
--
--   * every 30 s of stage clock: a recovery state. The game keeps where the car is (lat / lon, never game x / y: the
--     world rebases), its heading, speed, its place along the stage route and the stage progress; the car keeps its
--     damage, tyres, fuel and engine state (vehRepair.resumeSnapshot)
--   * RECOVER in the GPS app (or the Repair app's RECOVER CAR; the rallyRaid_recoverCar action has no key by default): the penalty and recoveries left are shown, a second press (or
--     CONFIRM) starts it; refused with the reason when the rules don't allow it (then RETIRE STAGE is offered)
--   * the recovery: the stage clock stops; the car is set down on the route, backOffM behind where it got stuck, facing
--     along the route, and the damage of the latest good recovery state (at least 5 s old) is put back (not a free
--     repair); the trip is set to that place's roadbook km; the penalty goes onto the stage as time
--     (repair.countResume('carRecovery'): the shared resume / reset budget and log)
--   * everything goes into the stage result (resumes.log from repair v1, plus carRecovery: attempts, snapshots, rules)
local cfgAll = require('rallyRaid/repairConfig')
local keys = require('rallyRaid/keys')
local geo = require('rallyRaid/geo')

local M = {}
M.cfg = cfgAll

local H = {}   -- hooks from core: S(), nav(), api(), addPenalty(kind, s, detail), notify(text, s), ui(name, data),
               -- hook(name, info), retireStage(reason), log(level, msg), setTripKm(km), repair (the repair module)
local R        -- run state (see fresh())

local function C() return cfgAll.carRecovery end
local function RC() return cfgAll.resume end
local function fresh()
  return { t = 0, route = nil, routeFor = nil, snaps = {}, snapId = 0, nextSnapClock = nil, snapWait = nil, ask = nil,
    busy = nil, msg = nil, log = {}, pausedS = 0, lastRepairEntry = nil, req = 0, snapshotsTaken = 0 }
end
R = fresh()

local function now() return os.date('!%Y-%m-%dT%H:%M:%SZ') end
local function S() return H.S and H.S() end
local function nav() return (H.nav and H.nav()) or {} end
local function api() return H.api and H.api() end
local function notify(t, s) if H.notify then H.notify(t, s) end end
local function log_(l, m) if H.log then H.log(l, m) end end
local function round(x, n) local k = 10 ^ (n or 0); return math.floor(x * k + 0.5) / k end
local function copy(t) if type(t) ~= 'table' then return t end local c = {} for k, v in pairs(t) do c[k] = copy(v) end return c end
local function repairMod() return H.repair end
local function fmtMin(s) return string.format('%d min', math.floor((s or 0) / 60 + 0.5)) end

------------------------------------------------------------------------------------------------------------------
-- the stage route as one line (pure: unit tested). From stage.route.legs[].points ([lat, lon]), else the straight
-- legs between the waypoints. d = metres along the route from the DSS; each waypoint gets its d (wpD) so a place on
-- the route can be given in the roadbook's km (the waypoints' km, interpolated).
local function xyAt(lat0, lon0)
  local kx = 111320 * math.cos(math.rad(lat0))
  return function(lat, lon) return (lon - lon0) * kx, (lat - lat0) * 110540 end
end
function M.buildRoute(stage)
  local pts = {}
  local function add(lat, lon)
    lat, lon = tonumber(lat), tonumber(lon)
    if not (lat and lon) then return end
    local last = pts[#pts]
    if last and math.abs(last.lat - lat) < 1e-9 and math.abs(last.lon - lon) < 1e-9 then return end
    pts[#pts + 1] = { lat = lat, lon = lon }
  end
  local legs = type(stage.route) == 'table' and type(stage.route.legs) == 'table' and stage.route.legs or {}
  for _, leg in ipairs(legs) do
    for _, p in ipairs(type(leg.points) == 'table' and leg.points or {}) do
      if type(p) == 'table' then add(p[1] or p.lat, p[2] or p.lon) end
    end
  end
  local source = 'route'
  if #pts < 2 then
    pts, source = {}, 'waypoints'
    for _, w in ipairs(stage.waypoints or {}) do add(w.lat, w.lon) end
  end
  local d = 0
  for i, p in ipairs(pts) do
    if i > 1 then d = d + geo.dist(pts[i - 1].lat, pts[i - 1].lon, p.lat, p.lon) end
    p.d = d
  end
  local route = { pts = pts, length = d, source = source, wpD = {} }
  -- each waypoint's place on the route: the nearest point, searching on from the previous waypoint's
  local from = 0
  for i, w in ipairs(stage.waypoints or {}) do
    local n = M.nearest(route, w.lat, w.lon, from, nil)
    route.wpD[i] = n and n.d or from
    from = route.wpD[i]
  end
  route.wpKm = {}
  for i, w in ipairs(stage.waypoints or {}) do route.wpKm[i] = tonumber(w.km) or route.wpD[i] / 1000 end
  return route
end

-- the nearest place on the route to lat, lon, with d in [fromD, toD]: { d, lat, lon, off (m from the route), seg }
function M.nearest(route, lat, lon, fromD, toD)
  local pts = route.pts
  if #pts == 0 then return nil end
  if #pts == 1 then return { d = 0, lat = pts[1].lat, lon = pts[1].lon, off = geo.dist(lat, lon, pts[1].lat, pts[1].lon), seg = 1 } end
  fromD, toD = fromD or -math.huge, toD or math.huge
  local xy = xyAt(lat, lon)
  local best
  for i = 2, #pts do
    local a, b = pts[i - 1], pts[i]
    if b.d >= fromD and a.d <= toD then
      local ax, ay = xy(a.lat, a.lon)
      local bx, by = xy(b.lat, b.lon)
      local dx, dy = bx - ax, by - ay
      local L2 = dx * dx + dy * dy
      local t = L2 > 0 and math.max(0, math.min(1, -(ax * dx + ay * dy) / L2)) or 0
      local segLen = b.d - a.d
      -- keep inside the window
      if segLen > 0 then
        t = math.max(t, (fromD - a.d) / segLen); t = math.min(t, (toD - a.d) / segLen)
        t = math.max(0, math.min(1, t))
      end
      local px, py = ax + t * dx, ay + t * dy
      local off = math.sqrt(px * px + py * py)
      if not best or off < best.off then
        best = { d = a.d + t * segLen, off = off, seg = i, lat = a.lat + t * (b.lat - a.lat), lon = a.lon + t * (b.lon - a.lon) }
      end
    end
  end
  return best
end

-- the place d metres along the route: lat, lon and the heading along the route there (degrees true)
function M.pointAt(route, d)
  local pts = route.pts
  if #pts == 0 then return nil end
  d = math.max(0, math.min(route.length, d))
  for i = 2, #pts do
    local a, b = pts[i - 1], pts[i]
    if d <= b.d or i == #pts then
      local segLen = b.d - a.d
      local t = segLen > 0 and math.max(0, math.min(1, (d - a.d) / segLen)) or 0
      return { d = d, lat = a.lat + t * (b.lat - a.lat), lon = a.lon + t * (b.lon - a.lon), heading = M.headingAt(route, d) }
    end
  end
  return { d = 0, lat = pts[1].lat, lon = pts[1].lon, heading = 0 }
end
-- the direction of travel at d: from the route 10 m before to 10 m ahead (a corner in between is smoothed over)
function M.headingAt(route, d)
  local pts = route.pts
  local function at(x)
    x = math.max(0, math.min(route.length, x))
    for i = 2, #pts do
      local a, b = pts[i - 1], pts[i]
      if x <= b.d or i == #pts then
        local segLen = b.d - a.d
        local t = segLen > 0 and math.max(0, math.min(1, (x - a.d) / segLen)) or 0
        return a.lat + t * (b.lat - a.lat), a.lon + t * (b.lon - a.lon)
      end
    end
  end
  local lat1, lon1 = at(d - 10)
  local lat2, lon2 = at(d + 10)
  if not lat1 or (math.abs(lat1 - lat2) < 1e-10 and math.abs(lon1 - lon2) < 1e-10) then
    if #pts >= 2 then return geo.bearing(pts[1].lat, pts[1].lon, pts[2].lat, pts[2].lon) end
    return 0
  end
  return geo.bearing(lat1, lon1, lat2, lon2)
end
-- the roadbook km at d (between two waypoints: their km, in proportion to the distance along the route)
function M.kmAt(route, d)
  local wd, wk = route.wpD, route.wpKm
  if #wd == 0 then return d / 1000 end
  if d <= wd[1] then return wk[1] + (d - wd[1]) / 1000 end
  for i = 2, #wd do
    if d <= wd[i] then
      local span = wd[i] - wd[i - 1]
      if span <= 0 then return wk[i] end
      return wk[i - 1] + (wk[i] - wk[i - 1]) * (d - wd[i - 1]) / span
    end
  end
  return wk[#wk] + (d - wd[#wd]) / 1000
end

local function route()
  local s = S()
  if not s then return nil end
  if R.routeFor ~= s.stage then R.route, R.routeFor = M.buildRoute(s.stage), s.stage end
  return R.route
end

------------------------------------------------------------------------------------------------------------------
-- game access (replaced in tests)
local function playerVeh() local be_ = rawget(_G, 'be'); return be_ and be_:getPlayerVehicle(0) end
local function destination(lat, lon, brg, m)
  local b = math.rad(brg)
  return lat + m * math.cos(b) / 110540, lon + m * math.sin(b) / (111320 * math.cos(math.rad(lat)))
end
M.game = {
  vehId = function() local rm = repairMod(); return rm and rm.game.vehId() end,
  send = function(cmd) local rm = repairMod(); return rm and rm.game.send(cmd) end,
  resetInPlace = function() local rm = repairMod(); return rm and rm.game.resetInPlace() end,
  pose = function() local a = api(); if a and a.pose then local ok, p = pcall(a.pose); if ok then return p end end end,
  teleport = function(lat, lon, name) local a = api(); if not (a and a.teleport) then return false, 'BeamNG.Earth not found' end return a.teleport(lat, lon, name) end,
  -- can we set the car down here without BeamNG.Earth's teleport (the world there is loaded)?
  canPlaceLocally = function(t)
    local a = api()
    return a ~= nil and a.toGame ~= nil and a.toGame(t.lat, t.lon, t.alt or 0) ~= nil
  end,
  -- set the car down at t = { lat, lon, alt, heading }: upright, facing heading, on the ground. Returns ok, why,
  -- resets (true: the game resets the car as part of it, as spawn.safeTeleport with resetVehicle does)
  place = function(t)
    local a, veh = api(), playerVeh()
    local vec, qdir = rawget(_G, 'vec3'), rawget(_G, 'quatFromDir')
    if not (a and a.toGame and veh and vec and qdir) then return false, 'game functions missing' end
    local x, y, z = a.toGame(t.lat, t.lon, t.alt or 0)
    if not x then return false, 'the world there is not loaded' end
    local lat2, lon2 = destination(t.lat, t.lon, t.heading or 0, 10)
    local x2, y2 = a.toGame(lat2, lon2, t.alt or 0)
    local dir = vec(x2 - x, y2 - y, 0)
    if dir:length() < 1e-3 then dir = vec(0, 1, 0) end
    dir = dir:normalized()
    -- the ground: a ray down from well over the higher of the route's height and the car's
    local top = z
    local okP, cp = pcall(function() return veh:getPosition() end)
    if okP and cp and tonumber(cp.z) then top = math.max(top, cp.z) end
    top = top + 100
    local ray = rawget(_G, 'castRayStatic')
    if ray then
      local okR, dist = pcall(ray, vec(x, y, top), vec(0, 0, -1), 400)
      if okR and tonumber(dist) and dist < 400 then z = top - dist end
    end
    local pos, rot = vec(x, y, z + (C().liftM or 0.5)), qdir(dir, vec(0, 0, 1))
    local sp = rawget(_G, 'spawn')
    if sp and sp.safeTeleport then
      -- as BeamNG.Earth sets the car down after its own teleports: reset, bounding box onto the ground, no speed
      local ok, err = pcall(sp.safeTeleport, veh, pos, rot, nil, nil, false, nil, true)
      if ok then return true, nil, true end
      log_('W', 'car recovery: spawn.safeTeleport failed: ' .. tostring(err))
    end
    local ok, err = pcall(function() veh:setPositionRotation(pos.x, pos.y, pos.z, rot.x, rot.y, rot.z, rot.w) end)
    if not ok then return false, tostring(err) end
    return true, nil, false
  end,
}

local function vehCall(fn, ...)
  local rm = repairMod()
  local s = rawget(_G, 'serialize')
  local args = { s and s(rm.vehCfg()) or 'nil' }
  for _, a in ipairs({ ... }) do args[#args + 1] = type(a) == 'table' and (s and s(a) or 'nil') or tostring(a) end
  local ext = rm.VEH_EXT
  return M.game.send('extensions.load("' .. ext .. '"); if ' .. ext .. ' then ' .. ext .. '.' .. fn .. '(' .. table.concat(args, ', ') .. ') end')
end

------------------------------------------------------------------------------------------------------------------
-- resume states (snapshots)
local function stageProgress(s)
  local st = {}
  for i, v in ipairs(s.state or {}) do st[i] = v end
  local lastOk = 1
  for i = 1, #st do if st[i] == 'ok' then lastOk = i end end
  return { target = s.target, lastOk = lastOk, states = st }
end

function M.takeSnapshot(reason)
  local s, n = S(), nav()
  local rt = route()
  if not (s and s.phase == 'running' and rt and n.ok and n.lat) then return nil end
  local a = api()
  if a and a.rebasing and a.rebasing() then return nil end
  local rm = repairMod()
  if rm and rm._R().busy then return nil end
  local p = M.game.pose() or {}
  -- its place on the route: near the last one (a route that crosses itself), never before the last waypoint passed
  local prog = stageProgress(s)
  local last = R.snaps[#R.snaps]
  local lo = math.max(rt.wpD[prog.lastOk] or 0, (last and last.routeD or 0) - C().searchBackM)
  local hi = (last and last.routeD or rt.wpD[prog.lastOk] or 0) + C().searchAheadM
  local nr = M.nearest(rt, n.lat, n.lon, lo, hi)
  R.snapId = R.snapId + 1
  local sn = { id = R.snapId, reason = reason, clock = s.clock, t = R.t, at = now(), lat = n.lat, lon = n.lon, alt = p.alt,
    heading = n.heading, speed = n.speed, routeD = nr and nr.d or nil, offRouteM = nr and round(nr.off, 1) or nil,
    trip = H.tripKm and H.tripKm() or nil, progress = prog, vehId = M.game.vehId(), car = nil, good = false }
  sn.why = (not nr) and 'no route' or (nr.off > C().maxOffRouteM and string.format('%.0f m off the route', nr.off)) or 'waiting for the car'
  R.snaps[#R.snaps + 1] = sn
  while #R.snaps > C().keepSnapshots do table.remove(R.snaps, 1) end
  R.snapshotsTaken = R.snapshotsTaken + 1
  vehCall('resumeSnapshot', sn.id, C().keepSnapshots)
  return sn
end

local function snapById(id) for _, sn in ipairs(R.snaps) do if sn.id == id then return sn end end end

-- the snapshot a resume uses: the latest good one at least minSnapshotAgeS old (of stage clock), else the latest good
function M.pickSnapshot()
  local s = S()
  local clock = s and s.clock or 0
  local vid = M.game.vehId()
  local latestGood
  for i = #R.snaps, 1, -1 do
    local sn = R.snaps[i]
    if sn.good and (vid == nil or sn.vehId == nil or sn.vehId == vid) then
      latestGood = latestGood or sn
      if clock - sn.clock >= C().minSnapshotAgeS then return sn end
    end
  end
  return latestGood
end

------------------------------------------------------------------------------------------------------------------
-- may the driver resume now? { allowed, reason, retireInstead, penaltyS, used, max, stageUsed, stageMax, leftAfter,
-- distToFinishM, target = { lat, lon, heading, d, km, backM }, snapshot = { id, ageS } }
function M.preview()
  local s, n = S(), nav()
  local rm = repairMod()
  local L = rm.ledger()
  local rc = RC()
  local stageN = s and s.repair and s.repair.resumes or 0
  local out = { used = #L.resumes, max = rc.maxPerRally, stageUsed = stageN, stageMax = rc.maxPerStage,
    firstPenaltyS = rc.firstPenaltyS, laterPenaltyS = rc.laterPenaltyS }
  out.penaltyS = (#L.resumes == 0) and rc.firstPenaltyS or rc.laterPenaltyS
  out.leftAfter = math.max(0, rc.maxPerRally - #L.resumes - 1)
  local function no(why, retire) out.allowed, out.reason, out.retireInstead = false, why, retire or false; return out end
  if C().enabled == false then return no('car recovery is switched off (repairConfig carRecovery.enabled)') end
  if not (s and s.phase == 'running') then return no('no car recovery here: only while a stage clock is running') end
  if H.otherBusy and H.otherBusy() then return no('a game-crash resume is running') end
  if R.busy then return no('a car recovery is already running') end
  if rm._R().busy then return no('a repair is running') end
  if L.retired then out.rallyRetired = true end
  if not (n.ok and n.lat) then return no('no position from BeamNG.Earth yet') end
  local ass = s.stage.waypoints[#s.stage.waypoints]
  out.distToFinishM = math.floor(geo.dist(n.lat, n.lon, ass.lat, ass.lon))
  if stageN + 1 > rc.maxPerStage then return no('second recovery / reset on this stage (max ' .. rc.maxPerStage .. ' per stage): the stage is retired', true) end
  if #L.resumes + 1 > rc.maxPerRally then return no('all ' .. rc.maxPerRally .. ' recoveries / resets of the rally used: the stage is retired', true) end
  if out.distToFinishM < rc.noResumeNearFinishM then
    return no(string.format('within %d m of the ASS (%d m): no recovery here. Get to the finish or retire.', rc.noResumeNearFinishM, out.distToFinishM), true)
  end
  if (n.speed or 0) * 3.6 > C().maxCallKmh then return no(string.format('stop first (under %d km/h)', C().maxCallKmh)) end
  -- where the car goes: the nearest place on the route to where it is, near its last good snapshot, then back a bit
  local rt = route()
  local sn = M.pickSnapshot()
  local prog = stageProgress(s)
  local baseD = sn and sn.routeD or rt.wpD[prog.lastOk] or 0
  local lo = math.max(rt.wpD[prog.lastOk] or 0, baseD - C().searchBackM)
  local nr = M.nearest(rt, n.lat, n.lon, lo, baseD + C().searchAheadM)
  if not nr then return no('the stage has no route to go back to') end
  local d = math.max(0, nr.d - C().backOffM)
  local p = M.pointAt(rt, d)
  out.crash = { lat = n.lat, lon = n.lon, d = round(nr.d, 1), offRouteM = round(nr.off, 1), heading = n.heading }
  out.target = { lat = p.lat, lon = p.lon, heading = round(p.heading, 1), d = round(d, 1), km = round(M.kmAt(rt, d), 3),
    backM = round(nr.d - d, 1), fromCarM = round(geo.dist(n.lat, n.lon, p.lat, p.lon), 1) }
  out.snapshot = sn and { id = sn.id, ageS = round(s.clock - sn.clock, 1), clock = sn.clock } or nil
  out.allowed = true
  return out
end

------------------------------------------------------------------------------------------------------------------
-- UI state ('RallyRaidResume')
function M.state()
  local st = { msg = R.msg, busy = R.busy and { phase = R.busy.phase, startedT = R.busy.startedT } or nil,
    ask = R.ask and R.ask.p or nil, askRetire = R.askRetire or nil, paused = M.clockPaused(),
    snapshots = #R.snaps, key = keys.get('rallyRaid_recoverCar'), enabled = C().enabled ~= false }
  local s = S()
  st.inStage = (s and s.phase == 'running') and true or false
  if st.inStage then
    local sn = M.pickSnapshot()
    st.lastSnapshotAgeS = sn and round(s.clock - sn.clock, 0) or nil
  end
  return st
end
function M.push() if H.ui then H.ui('RallyRaidRecover', M.state()) end end

local function logAttempt(e)
  local s = S()
  e.at = e.at or now(); e.t = e.t or (s and s.clock)
  R.log[#R.log + 1] = e
  if s then s.carRecoveryLog = R.log end
end

------------------------------------------------------------------------------------------------------------------
-- the driver's side: ask (shows the confirm), confirm, cancel, retire
function M.ask()
  local p = M.preview()
  R.ask, R.askRetire, R.msg = { p = p, t = R.t }, nil, nil
  if p.allowed then
    notify(string.format('rally.raid Earth: RECOVER CAR? +%s penalty, %d of %d recoveries left after it. Back on the route %d m behind you (km %.2f). CONFIRM to go' .. keys.hint('rallyRaid_recoverCar', ' (or %s again)') .. '.',
      fmtMin(p.penaltyS), p.leftAfter, p.max, math.floor(p.target.fromCarM + 0.5), p.target.km), 8)
  else
    notify('rally.raid Earth: no car recovery: ' .. p.reason .. '.', 6)
    logAttempt({ kind = 'refused', reason = p.reason, distToFinishM = p.distToFinishM })
  end
  M.push()
  return p
end
function M.cancel() R.ask, R.askRetire, R.msg = nil, nil, nil; M.push() end
function M.key()
  if R.ask and R.ask.p.allowed and R.t - R.ask.t <= C().confirmS then return M.confirm() end
  return M.ask()
end

function M.retire()
  local s = S()
  if not (s and s.phase == 'running') or R.busy then return false end
  if not R.askRetire then R.askRetire = true; M.push(); return false end    -- the app asks "sure?" first
  local p = R.ask and R.ask.p or M.preview()
  logAttempt({ kind = 'retiredByDriver', reason = p.reason })
  R.ask, R.askRetire = nil, nil
  notify('rally.raid Earth: stage RETIRED by the driver (' .. tostring(p.reason or 'crash') .. ').', 8)
  if H.retireStage then H.retireStage('stuck car: ' .. tostring(p.reason or 'retired by the driver')) end
  M.push()
  return true
end

local function fail(why)
  local b = R.busy
  R.busy = nil
  R.msg, R.msgAt = 'Car recovery failed: ' .. why .. ' No penalty was charged.', R.t
  if b then
    logAttempt({ kind = 'failed', reason = why, phase = b.phase, pausedS = round(b.pausedS or 0, 1) })
    M.game.send('if ' .. repairMod().VEH_EXT .. ' then ' .. repairMod().VEH_EXT .. '.cancel() end')
  end
  notify('rally.raid Earth: ' .. R.msg, 6)
  log_('W', 'car recovery failed: ' .. why)
  M.push()
end

function M.confirm()
  local p = M.preview()
  R.ask, R.askRetire = nil, nil
  if not p.allowed then
    R.msg = 'No car recovery: ' .. p.reason .. '.'
    notify('rally.raid Earth: ' .. R.msg, 6)
    logAttempt({ kind = 'refused', reason = p.reason, distToFinishM = p.distToFinishM })
    R.ask = { p = p, t = R.t }
    M.push()
    return false, p.reason
  end
  local sn = p.snapshot and snapById(p.snapshot.id)
  R.req = R.req + 1
  local pose = M.game.pose() or {}
  p.target.alt = (sn and sn.alt) or pose.alt
  R.busy = { reqId = R.req, phase = 'start', startedT = R.t, phaseT = R.t, preview = p, target = p.target, snap = sn,
    pausedS = 0, resetSeen = false }
  R.msg = nil
  notify('rally.raid Earth: car recovery: the clock is stopped, putting the car back on the route ...', 4)
  R.busy.far = p.target.fromCarM > C().localMoveMaxM or not M.game.canPlaceLocally(p.target)
  if sn then M.go()
  else
    -- no resume state yet: the car's damage as it is now is saved first (a teleport's own reset would wipe it)
    R.snapId = R.snapId + 1
    R.busy.phase, R.busy.captureId, R.busy.capturedNow = 'capture', R.snapId, true
    vehCall('resumeSnapshot', R.snapId, C().keepSnapshots)
  end
  M.push()
  return true
end

-- the damage to put back is in the car: move it
function M.go()
  local b = R.busy
  b.phaseT = R.t
  -- far away (or the world there not loaded): BeamNG.Earth's own teleport first, then set down there
  if b.far then
    b.phase = 'teleport'
    local ok, why = M.game.teleport(b.target.lat, b.target.lon, 'Recover car')
    if not ok then fail('the teleport was refused (' .. tostring(why) .. ').'); return false end
  else
    b.phase = 'arm'
    vehCall('resumeArm', b.captureId or b.snap.id, b.reqId)
  end
  return true
end

-- the car is armed (it remembers the damage to put back): set it down
local function place()
  local b = R.busy
  b.phase, b.phaseT = 'place', R.t
  b.resetSeen = false            -- (BeamNG.Earth's teleport before this resets the car too: that one does not count)
  local ok, why, resets = M.game.place(b.target)
  if not ok then fail('the car could not be set down (' .. tostring(why) .. ').'); return end
  b.placeResets = resets
  if not resets and not b.resetSeen then b.needReset = true end
end

function M.teleported()
  if R.busy and R.busy.phase == 'teleport' then
    R.busy.phase, R.busy.phaseT = 'arm', R.t
    vehCall('resumeArm', R.busy.captureId or (R.busy.snap and R.busy.snap.id) or -1, R.busy.reqId)
    M.push()
    return true
  end
  return false
end

-- the commit: charge the resume (the shared budget in repair v1), set the trip, log everything
local function commit(d)
  local b = R.busy
  local s = S()
  local rm = repairMod()
  local p = b.preview
  local r = rm.countResume('carRecovery', { lat = p.crash.lat, lon = p.crash.lon, km = H.tripKm and H.tripKm() or nil,
    distToFinishM = p.distToFinishM })
  local e = r.entry
  e.resume = { from = p.crash, to = p.target, snapshot = b.snap and { id = b.snap.id, clock = b.snap.clock, ageS = round(s.clock - b.snap.clock, 1),
      lat = b.snap.lat, lon = b.snap.lon, progress = b.snap.progress, trip = b.snap.trip, routeD = b.snap.routeD } or nil,
    damageFrom = (b.capturedNow or not d.fromSnapshot) and 'now' or 'snapshot', damageAfter = d.after, stats = d.stats, fuel = d.fuel,
    engineFlagsNotRestored = d.engineFlagsNotRestored, far = b.far or false, tripKmBefore = H.tripKm and H.tripKm() or nil }
  if r.allowed then
    if H.addPenalty then H.addPenalty('carRecovery', r.penaltyS, string.format('car recovery %d/%d (+%s)', e.rallyCount, RC().maxPerRally, fmtMin(r.penaltyS))) end
  end
  if H.setTripKm then H.setTripKm(p.target.km) end
  b.entry, b.result = e, r
end

function M.reply(d)
  if type(d) ~= 'table' then return end
  if d.kind == 'resumeSnap' and R.busy and R.busy.phase == 'capture' and d.id == R.busy.captureId then
    if not d.ok then fail('the car did not answer (' .. tostring(d.why) .. ').') return end
    M.go()
  elseif d.kind == 'resumeSnap' then
    local sn = snapById(d.id)
    if sn then
      sn.car = { ok = d.ok, upright = d.upright, beams = d.beams, nodes = d.nodes, why = d.why }
      if not d.ok then sn.why = 'the car did not answer (' .. tostring(d.why) .. ')'
      elseif (tonumber(d.upright) or 1) < C().minUprightZ then sn.why = 'car not upright'
      elseif sn.offRouteM and sn.offRouteM > C().maxOffRouteM then sn.why = string.format('%.0f m off the route', sn.offRouteM)
      elseif not sn.routeD then sn.why = 'no route'
      else sn.good, sn.why = true, nil end
    end
  elseif d.kind == 'resumeReady' then
    local b = R.busy
    if b and b.reqId == d.reqId and b.phase == 'arm' then
      if not d.ok then fail('the car did not answer (' .. tostring(d.why) .. ').') return end
      b.fromSnapshot = d.fromSnapshot
      place()
    end
  elseif d.kind == 'resumeDone' then
    local b = R.busy
    if b and b.reqId == d.reqId then
      if not d.ok then fail('the damage could not be put back (' .. tostring(d.why) .. ').') return end
      d.fromSnapshot = b.fromSnapshot
      commit(d)
      b.phase, b.phaseT = 'settle', R.t
    end
  end
  M.push()
end

local function finishResume()
  local b = R.busy
  local s = S()
  local p = M.game.pose() or {}
  local e = b.entry
  if e then
    e.resume.pausedS = round(b.pausedS, 1)
    if p.heading and b.target.heading then
      local off = math.abs(geo.angleDiff(p.heading, b.target.heading))
      e.resume.headingOffDeg = round(off, 1)
      if off > C().headingWarnDeg then log_('W', string.format('car recovery: the car faces %.0f deg off the route', off)) end
    end
    if p.lat then e.resume.landedOffM = round(geo.dist(p.lat, p.lon, b.target.lat, b.target.lon), 1) end
    logAttempt({ kind = 'resumed', rallyCount = e.rallyCount, penaltyS = e.penaltyS, km = b.target.km, backM = b.target.backM,
      pausedS = e.resume.pausedS, damageFrom = e.resume.damageFrom, snapshotId = b.snap and b.snap.id or nil })
    notify(string.format('rally.raid Earth: car recovery %d of %d done: +%s. Back on the route at km %.2f. Go!', e.rallyCount,
      RC().maxPerRally, fmtMin(e.penaltyS), b.target.km), 6)
    R.msgAt = R.t
    R.msg = string.format('Car recovery %d of %d: +%s, back on the route at km %.2f.', e.rallyCount, RC().maxPerRally, fmtMin(e.penaltyS), b.target.km)
  end
  if H.hook then H.hook('onRallyRaidCarRecovery', e) end
  R.lastEntry = e
  R.busy = nil
  -- a fresh resume state from here; the older ones are from before the crash
  for _, sn in ipairs(R.snaps) do sn.good, sn.why = false, 'before the last resume' end
  R.nextSnapClock = s and (s.clock + C().firstSnapshotAfterS) or nil
  local rm = repairMod()
  if rm and rm.push then rm.push() end
  M.push()
end

------------------------------------------------------------------------------------------------------------------
-- frame update (core.onUpdate) and the hooks core passes on
function M.clockPaused() return R.busy ~= nil end
function M.holdNav() return R.busy ~= nil end
function M.busy() return R.busy ~= nil end

function M.update(dtReal, dtSim)
  dtReal = dtReal or 0
  R.t = R.t + dtReal
  local s = S()
  local b = R.busy
  if b then
    b.pausedS = b.pausedS + (dtSim or dtReal)
    if not (s and s.phase == 'running') then R.busy = nil; M.push(); return end
    local age = R.t - b.phaseT
    if b.phase == 'capture' and age > C().answerTimeoutS then fail('the car did not answer.')
    elseif b.phase == 'teleport' and age > C().teleportTimeoutS then fail('the teleport took too long.')
    elseif b.phase == 'arm' and age > C().answerTimeoutS then fail('the car did not answer.')
    elseif b.phase == 'place' then
      if b.needReset and not b.resetSeen and age >= C().resetFallbackS then
        b.needReset = false
        if not M.game.resetInPlace() then fail('the car could not be reset.') end
      elseif age > C().answerTimeoutS then fail('the car did not answer.') end
    elseif b.phase == 'settle' and age >= C().settleS then finishResume() end
    return
  end
  if R.ask and R.t - R.ask.t > 60 then R.ask, R.askRetire = nil, nil; M.push() end
  if R.msg and R.msgAt and R.t - R.msgAt > 12 then R.msg, R.msgAt = nil, nil; M.push() end   -- the outcome, shown a while
  if not (s and s.phase == 'running') then return end
  -- a repair since the last snapshot: the older ones hold the damage it fixed
  local rm = repairMod()
  local le = rm and rm._R().lastEntry
  if le and le ~= R.lastRepairEntry then
    R.lastRepairEntry = le
    for _, sn in ipairs(R.snaps) do sn.good, sn.why = false, 'before a repair' end
    R.nextSnapClock = s.clock + 1
  end
  if R.nextSnapClock and s.clock >= R.nextSnapClock then
    if M.takeSnapshot(R.snapshotsTaken == 0 and 'start' or 'timer') then R.nextSnapClock = s.clock + C().snapshotEveryS
    else R.nextSnapClock = s.clock + 1 end      -- not now (rebasing, a repair running, no position): try again in 1 s
  end
end

-- a reset while a resume runs is ours (core asks first, before repair v1 counts it as an unauthorized one)
function M.onVehicleResetted(vehId)
  if not R.busy then return nil end
  local pid = M.game.vehId()
  if vehId ~= nil and pid ~= nil and vehId ~= pid then return nil end
  R.busy.resetSeen = true
  return 'ours'
end

function M.stageStarted()
  local keepLog = {}
  R.snaps, R.ask, R.askRetire, R.busy, R.msg, R.log = {}, nil, nil, nil, nil, keepLog
  R.snapshotsTaken = 0
  local s = S()
  if s then s.carRecoveryLog = R.log end
  R.route, R.routeFor = nil, nil
  route()
  R.nextSnapClock = C().firstSnapshotAfterS
  R.lastRepairEntry = repairMod() and repairMod()._R().lastEntry
  M.push()
end
-- the stage goes on after a game-crash resume (rallyRaid/gameResume.lua restored it from disk): no recovery states
-- in memory any more (the car VM is new); fresh ones from now on, the log from the save kept
function M.stageResumed()
  local s = S()
  R.snaps, R.ask, R.askRetire, R.busy, R.msg = {}, nil, nil, nil, nil
  R.log = (s and type(s.carRecoveryLog) == 'table') and s.carRecoveryLog or {}
  if s then s.carRecoveryLog = R.log end
  R.route, R.routeFor = nil, nil
  route()
  R.nextSnapClock = (s and s.clock or 0) + C().firstSnapshotAfterS
  R.lastRepairEntry = repairMod() and repairMod()._R().lastEntry
  M.push()
end
function M.stageChanged()
  R.snaps, R.ask, R.askRetire, R.busy, R.nextSnapClock = {}, nil, nil, nil, nil
  R.route, R.routeFor = nil, nil
  M.push()
end

function M.resultFields(s)
  local snaps = {}
  for _, sn in ipairs(R.snaps) do snaps[#snaps + 1] = { id = sn.id, clock = sn.clock, good = sn.good, why = sn.why, km = sn.trip, offRouteM = sn.offRouteM } end
  return { attempts = s.carRecoveryLog or {}, snapshotsTaken = R.snapshotsTaken, lastSnapshots = snaps, rules = copy(C()) }
end

function M.cmd(sub, arg)
  if sub == 'Ask' then M.ask()
  elseif sub == 'Key' then M.key()
  elseif sub == 'Confirm' then M.confirm()
  elseif sub == 'Cancel' then M.cancel()
  elseif sub == 'Retire' then M.retire()
  elseif sub == 'State' then M.push()
  else log_('W', 'unknown resume command ' .. tostring(sub)) end
end

function M.init(hooks) H = hooks or {} end
function M._R() return R end
function M._reset() R = fresh() end

return M
