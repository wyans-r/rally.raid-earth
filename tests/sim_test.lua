-- Offline test of the mod's Lua logic: a fake BeamNG + BeamNG.Earth API, a car driven along the sample stage's
-- route. Run with tests/run_tests.py (LuaJIT through lupa). Nothing here runs in the game.
local MOD = MOD_ROOT .. '/lua/ge/extensions/'
package.path = MOD .. '?.lua;' .. package.path

-- fake game environment ------------------------------------------------------------------------------------------
local car = { lat = 0, lon = 0, speed = 0, ve = 0, vn = 0, heading = 0 }
local ui, events, files, notes = {}, {}, {}, {}
guihooks = { trigger = function(n, d) ui[n] = d end }
extensions = { hook = function(n, info) events[#events + 1] = { n = n, info = info } end }
log = function() end
ui_message = function(t) notes[#notes + 1] = t end
jsonReadFile = function(p) return READ_JSON(p) end
jsonWriteFile = function(p, d) files[p] = d; return true end
FS = { findFiles = function(self, dir) return LIST_FILES(dir) end }
beamngEarth_api = {
  version = function() return 1, 8 end, ready = function() return true end, rebasing = function() return false end,
  pose = function() return { lat = car.lat, lon = car.lon, speed = car.speed, ve = car.ve, vn = car.vn, heading = car.heading, camera = false } end,
  notify = function(t) notes[#notes + 1] = t; return true end,
  teleport = function(lat, lon) car.lat, car.lon = lat, lon; return true end,
}

local geo = require('rallyRaid/geo')
local core = require('rallyRaid/core')
local rules = require('rallyRaid/rules')
local stages = require('rallyRaid/stages')

local fails, passes = 0, 0
local function check(cond, msg) if cond then passes = passes + 1 else fails = fails + 1; print('FAIL: ' .. msg) end end

-- unit checks -----------------------------------------------------------------------------------------------------
check(math.abs(geo.dist(0, 0, 0, 1) - 111195) < 10, 'one degree of longitude at the equator ~111.2 km')
check(math.abs(geo.bearing(0, 0, 1, 0) - 0) < 1e-6 and math.abs(geo.bearing(0, 0, 0, 1) - 90) < 1e-6, 'bearings N / E')
check(math.abs(geo.angleDiff(10, 350) - 20) < 1e-9, 'angleDiff wraps')
local R = rules.build(nil)
check(rules.impulsePenalty(R, 3) == 10 and rules.impulsePenalty(R, 12) == 60 and rules.impulsePenalty(R, 30) == 120 and rules.impulsePenalty(R, 70) == 360 and rules.impulsePenalty(R, 0.5) == 0, 'FIM impulse bands')
-- FIM Art. 16 worked example: 40 zone, 70, 70, 52, 43 -> 2x2' + 1' + 10 s = 5'10"
check(rules.impulsePenalty(R, 30) * 2 + rules.impulsePenalty(R, 12) + rules.impulsePenalty(R, 3) == 310, 'FIM worked example 5:10')
local R2 = rules.build({ waypoints = { WPM = { validate = 50 } } })
check(R2.waypoints.WPM.validate == 50 and R2.waypoints.WPM.radius == 800 and R2.waypoints.WPS.validate == 30, 'rules override merges')
local bad = stages.normalize({ schemaVersion = 1, waypoints = { { type = 'WPM', lat = 1, lon = 1 }, { type = 'ASS', lat = 1, lon = 1.1 } } })
check(bad == nil, 'stage without DSS refused')
local bad2 = stages.normalize({ schemaVersion = 1, waypoints = { { type = 'DSS', lat = 1, lon = 1 }, { type = 'DZ', lat = 1, lon = 1.01 }, { type = 'ASS', lat = 1, lon = 1.1 } } })
check(bad2 == nil, 'DZ without speed limit / FZ refused')

-- drive helper ----------------------------------------------------------------------------------------------------
local function step(dt) core.onUpdate(dt, dt) end
local function driveTo(lat, lon, kmh, opts)
  opts = opts or {}
  local v = kmh / 3.6
  for _ = 1, 100000 do
    local d = geo.dist(car.lat, car.lon, lat, lon)
    if d < 0.5 then break end
    local b = geo.bearing(car.lat, car.lon, lat, lon)
    local move = math.min(d, v * 0.1)
    -- small flat-earth step
    local dn, de = move * math.cos(math.rad(b)), move * math.sin(math.rad(b))
    car.lat = car.lat + dn / 111195
    car.lon = car.lon + de / (111195 * math.cos(math.rad(car.lat)))
    car.speed, car.heading = v, b
    car.ve, car.vn = v * math.sin(math.rad(b)), v * math.cos(math.rad(b))
    if opts.reverse then car.heading = (b + 180) % 360 end
    step(0.1)
    if opts.each then opts.each() end
  end
end
local function followRoute(stage, fromId, toId, kmh, each)
  local on = false
  for _, leg in ipairs(stage.route.legs) do
    if leg.from == fromId then on = true end
    if on then for i = 2, #leg.points do driveTo(leg.points[i][1], leg.points[i][2], type(kmh) == 'function' and kmh(leg) or kmh, { each = each }) end end
    if leg.to == toId then break end
  end
end

-- 1) a clean run of the sample stage -----------------------------------------------------------------------------
local list = {}
for _, st in ipairs(core.listStages()) do if st.file == 'moab-sand-flats-ss1.json' then list[1] = st end end
check(#list >= 1 and list[1].ok, 'sample stage listed and valid: ' .. tostring(list[1] and (list[1].error or list[1].name)))
local raw = READ_JSON(list[1].path)
check(core.loadStage(list[1].path) == true, 'sample stage loads')
local S = core._debug()
local dss = S.stage.waypoints[1]
car.lat, car.lon = dss.lat + 0.01, dss.lon       -- ~1.1 km north of the start
step(0.1); step(0.1)
check(ui.RallyRaidUpdate.phase == 'armed' and ui.RallyRaidUpdate.wp and ui.RallyRaidUpdate.wp.type == 'DSS', 'armed, pointing to DSS')
check(ui.RallyRaidUpdate.wp.revealed == true and ui.RallyRaidUpdate.wp.dtw > 1000, 'DSS shown from afar (first waypoint)')
driveTo(dss.lat, dss.lon, 50)
check(ui.RallyRaidUpdate.atStart == true, 'at start in DSS circle')
-- WPM must be hidden while far, shown within 800 m
local wpmIdx
for i, w in ipairs(S.stage.waypoints) do if w.type == 'WPM' then wpmIdx = i end end
local sawHidden, sawShown, zoneLive, impulsesInZone = false, false, false, 0
local maxBefore = 0
followRoute(raw, 'dss', 'ass', function(leg)
  if leg.from == 'dz1' then return 60 end                        -- 20 km/h over the 40 limit in the zone
  return 80
end, function()
  local u = ui.RallyRaidUpdate
  if u.wp and u.wp.index == wpmIdx then
    if u.wp.revealed then sawShown = true; check(u.wp.dtw <= 800.5, 'WPM revealed only within 800 m (' .. u.wp.dtw .. ')')
    else sawHidden = true; check(u.wp.dtw == nil, 'hidden WPM leaks no distance') end
  end
  if u.zone and u.zone.live and not u.zone.tolerance then zoneLive = true end
end)
local u = ui.RallyRaidUpdate
check(sawHidden and sawShown, 'WPM hidden then revealed')
check(zoneLive, 'speed zone went live')
check(u.phase == 'finished', 'stage finished, phase=' .. tostring(u.phase))
local res
for p, d in pairs(files) do if p:match('^/rallyraid/results/') then res = d end end
check(res ~= nil, 'results file written')
if res then
  local missed = 0
  for _, w in ipairs(res.waypoints) do if w.status ~= 'ok' then missed = missed + 1 end end
  check(missed == 0, 'no waypoint missed on the clean run (' .. missed .. ')')
  check(res.speedImpulses >= 3, 'speeding at 60 in a 40 zone gave impulses: ' .. res.speedImpulses)
  local imp = 0
  for _, p in ipairs(res.penalties) do if p.kind == 'speedImpulse' then imp = imp + p.seconds; check(p.seconds == 120, '20 km/h over = 2 min per impulse') end end
  check(res.penaltyTime == imp, 'penalties = impulses only')
  local zoneLen = (S.stage.waypoints[3].km - S.stage.waypoints[2].km) * 1000 - 180
  local expect = math.floor(zoneLen / ((60 / 3.6) * 10 < 150 and (60 / 3.6) * 10 or 150)) + 1
  check(math.abs(res.speedImpulses - expect) <= 1, 'impulse count ~ every 10 s / 150 m: got ' .. res.speedImpulses .. ' expected ~' .. expect)
  check(math.abs(res.distanceDriven - S.stage.waypoints[#S.stage.waypoints].km) < 0.6, 'distance driven ~ stage length: ' .. res.distanceDriven)
  check(res.stageTime > 0 and res.totalTime == res.stageTime + res.penaltyTime, 'times add up')
  print(string.format('  clean run: stage %.0f s, penalties %d s, %d impulses, %.2f km driven, trip %.3f',
    res.stageTime, res.penaltyTime, res.speedImpulses, res.distanceDriven, u.trip))
end
check(math.abs(u.trip - S.stage.waypoints[#S.stage.waypoints].km) < 0.1, 'trip matches roadbook km at the finish (snapped at the 90 m circle)')

-- 2) a run that skips the WPC: missed penalty, W- / W+ ------------------------------------------------------------
files = {}
core.cmd('abort')
S = core._debug()
local wpc, wpe
for i, w in ipairs(S.stage.waypoints) do if w.type == 'WPC' then wpc = i elseif w.type == 'WPE' then wpe = i end end
car.lat, car.lon = dss.lat, dss.lon
step(0.1)
core.cmd('start'); check(S.phase == 'countdown', 'START gives a countdown')
for _ = 1, 60 do step(0.1) end
check(S.phase == 'running', 'countdown -> running')
followRoute(raw, 'dss', 'wps1', 35)
check(S.target == wpc, 'next target is the WPC')
-- go straight (off route, far from the WPC) to the WPE
local we = S.stage.waypoints[wpe]
local wc = S.stage.waypoints[wpc]
car.lat, car.lon = car.lat, car.lon
driveTo(wc.lat - 0.01, wc.lon, 60)             -- detour south, > 300 m from the WPC
driveTo(we.lat, we.lon, 60)
check(S.state[wpc] == 'missed' and S.state[wpe] == 'ok', 'taking the WPE marks the WPC missed')
check(S.penaltyTotal == 900, 'WPC missed = 15 min, got ' .. S.penaltyTotal)
-- reveal rule of WPC: never shows distance
-- W- back to the WPC lifts the penalty? only if the target is right after it: here target is ASS (after WPE), so no
core.cmd('wMinus')
check(S.target == wpe + 1, 'W- does nothing when the previous WP was validated')
-- trip corrections
local t0 = core.getState().trip
core.cmd('tripPlus'); core.cmd('tripPlus'); core.cmd('tripMinus')
check(math.abs(core.getState().trip - t0 - 0.01) < 1e-9, 'trip +10 +10 -10 m')
core.cmd('tripStep', '100'); core.cmd('tripPlus')
check(math.abs(core.getState().trip - t0 - 0.11) < 1e-9, 'trip step 100 m')
core.cmd('tripStep', '10')
core.cmd('partialReset'); check(core.getState().partial == 0, 'partial reset')
-- reversing counts the trip down
local tb = core.getState().trip
driveTo(car.lat + 0.0005, car.lon, 10, { reverse = true })
check(core.getState().trip < tb - 0.04, 'reversing counts the trip down')
-- W+ on the ASS is refused (cannot skip the finish)
core.cmd('wPlus')
check(S.target == #S.stage.waypoints, 'W+ cannot skip the ASS')

-- 3) W+ then W- restores the waypoint ------------------------------------------------------------------------------
core.cmd('abort'); S = core._debug()
car.lat, car.lon = dss.lat, dss.lon; step(0.1)
driveTo(dss.lat + 0.003, dss.lon, 40)  -- leave the circle: auto start
check(S.phase == 'running', 'auto start when leaving the DSS circle')
core.cmd('wPlus')
check(S.state[2] == 'missed' and S.penaltyTotal == 900, 'W+ marks the DZ missed')
core.cmd('wMinus')
check(S.state[2] == 'pending' and S.penaltyTotal == 0 and S.target == 2, 'W- goes back and lifts the penalty')

-- 4) rebase / no Earth safety ---------------------------------------------------------------------------------------
local saved = beamngEarth_api
beamngEarth_api = nil; step(0.2)
check(ui.RallyRaidUpdate.ok == false and ui.RallyRaidUpdate.why == 'BeamNG.Earth not found', 'no Earth: says so, no crash')
beamngEarth_api = saved
beamngEarth_api.rebasing = function() return true end
local before = core.getState().trip
car.lat = car.lat + 0.01; step(0.2)
beamngEarth_api.rebasing = function() return false end
check(core.getState().trip == before, 'nothing counted during a rebase frame')
-- a teleport-sized jump does not add to the trip and flags the run
step(0.2)
check(core.getState().trip == before, 'a 1 km jump is not driving')
check(S.flags.positionJump == true, 'jump flagged as unofficial')

-- roadbook contract
local rb = ui.RallyRaidRoadbook
check(rb and rb.schema == 1 and rb.trip and rb.stageId == S.stage.id, 'roadbook state sent')
local seen = {}
for _, e in ipairs(events) do seen[e.n] = true end
for _, n in ipairs({ 'onRallyRaidStageLoaded', 'onRallyRaidStageStart', 'onRallyRaidWaypoint', 'onRallyRaidStageFinish', 'onRallyRaidTick', 'onRallyRaidTripChanged', 'onRallyRaidSpeedImpulse' }) do
  check(seen[n], 'event ' .. n .. ' fired')
end
core.cmd('syncBox', '5')
local box5 = S.stage.roadbook.boxes[5]
check(math.abs(core.getState().trip - box5.km) < 1e-9, 'syncBox sets the trip to the box km')


-- roadbook file from the editor (docs/ROADBOOK_FORMAT.md) -----------------------------------------------------
local moab = stages.load(list[1].path)
local fake = { format = 'rallyraid-roadbook', schemaVersion = 1, name = 'test', revision = 3,
  stage = { id = moab.id, lengthKm = moab.waypoints[#moab.waypoints].km }, boxes = {} }
local km = 0
for i, w in ipairs(moab.waypoints) do
  -- a waypoint box at the stage km + 0.3 km per leg (as if the roadbook followed a longer planned line)
  fake.boxes[#fake.boxes + 1] = { id = 'wp' .. i, n = 99, km = w.km + 0.3 * (i - 1), waypoint = w.id, label = w.type, notes = 'WP ' .. i,
    danger = 0, symbols = { 'wp' }, tulip = { entry = { track = 'track' }, exit = { angle = 0, track = 'track' }, branches = {} } }
  if i > 1 then fake.boxes[#fake.boxes + 1] = { id = 'mid' .. i, km = (moab.waypoints[i - 1].km + 0.3 * (i - 2) + w.km + 0.3 * (i - 1)) / 2, notes = 'CAP 123',
    danger = 2, symbols = { 'danger' }, tulip = { entry = { track = 'offpiste' }, exit = { angle = 30, track = 'offpiste' }, branches = { { angle = -60, track = 'track' } } } } end
end
fake.boxes[#fake.boxes + 1] = { id = 'gone', km = 0.05, deleted = true, notes = 'deleted box' }
local rbPath = '/rallyraid/roadbooks/' .. moab.id .. '.roadbook.json'
local served = {}
jsonReadFile = function(p) served[#served + 1] = p; if p == rbPath then return fake end return READ_JSON(p) end
check(#stages.roadbookCandidates(moab) == 2 and stages.roadbookCandidates(moab)[1] == rbPath, 'roadbook looked for in rallyraid/roadbooks/<id>.roadbook.json, then next to the stage')
local nb = select(1, stages.normalizeRoadbook(fake, moab))
check(nb and #nb == #fake.boxes - 1, 'deleted boxes are dropped')
check(nb and nb[1].n == 1 and nb[2].n == 2 and nb[2].km > nb[1].km, 'boxes renumbered in km order')
check(select(1, stages.normalizeRoadbook({ format = 'rallyraid-roadbook', schemaVersion = 1, stage = { id = 'other' }, boxes = fake.boxes }, moab)) == nil, 'a roadbook for another stage is refused')
check(select(1, stages.normalizeRoadbook({ format = 'x', boxes = fake.boxes }, moab)) == nil, 'wrong format refused')
check(select(1, stages.normalizeRoadbook({ format = 'rallyraid-roadbook', schemaVersion = 9, boxes = fake.boxes }, moab)) == nil, 'newer schema refused')
local _, warn = stages.normalizeRoadbook({ format = 'rallyraid-roadbook', schemaVersion = 1, stage = { id = moab.id, lengthKm = 999 }, boxes = fake.boxes }, moab)
check(type(warn) == 'table' and #warn == 1, 'stage length mismatch warned')
local lst = core.listStages()
local listedRb = false
for _, e in ipairs(lst) do if tostring(e.file):match('roadbook') then listedRb = true end end
check(not listedRb, 'roadbook files are not listed as stages')

core.loadStage(list[1].path)
S = core._debug()
check(S.stage.roadbook.source and S.stage.roadbook.source.path == rbPath, 'roadbook file loaded with the stage')
check(#S.stage.roadbook.boxes == #fake.boxes - 1, 'its boxes replace the stage boxes')
local last = S.stage.waypoints[#S.stage.waypoints]
check(math.abs(last.km - (last.stageKm + 0.3 * (#S.stage.waypoints - 1))) < 1e-9, 'waypoint km taken from the roadbook (stage km kept in stageKm)')
core.cmd('tripSet', '0')
local st0 = core.roadbookState()
check(st0.boxCount == #fake.boxes - 1 and st0.viewIndex == 1 and #st0.view == 4 and st0.view[1].current, 'display window: current box + next 3')
check(st0.view[2].tulip and st0.view[2].tulip.branches[1].angle == -60 and st0.view[2].danger == 2, 'tulip / danger sent to the HUD')
-- scrolling by odometer
core.cmd('tripSet', tostring(S.stage.roadbook.boxes[3].km + 0.01))
check(core.roadbookState().viewIndex == 3 and core.roadbookState().box == 3, 'display follows the trip')
-- box down / up keys scroll without touching the trip
local tripBefore = core.getState().trip
core.cmd('boxNext'); core.cmd('boxNext')
local sc = core.roadbookState()
check(sc.viewIndex == 5 and sc.manual and sc.box == 3, 'box down scrolls the display, the trip box stays')
check(core.getState().trip == tripBefore, 'scrolling does not change the trip')
core.cmd('boxPrev')
check(core.roadbookState().viewIndex == 4, 'box up')
for _ = 1, 50 do core.cmd('boxPrev') end
check(core.roadbookState().viewIndex == 1, 'box up stops at box 1')
-- an odometer adjust re-syncs
core.cmd('boxNext'); core.cmd('boxNext'); core.cmd('boxNext'); core.cmd('boxNext')
check(core.roadbookState().manual, 'scrolled')
core.cmd('tripPlus', '10')
check(not core.roadbookState().manual and core.roadbookState().viewIndex == 3, 'trip + re-syncs the display to the odometer')
-- sync the trip to the box on screen
core.cmd('boxNext'); core.cmd('boxNext')
core.cmd('boxSync')
check(math.abs(core.getState().trip - S.stage.roadbook.boxes[5].km) < 1e-9 and core.roadbookState().box == 5 and not core.roadbookState().manual, 'box sync: trip := the shown box km')
-- reaching the scrolled box by driving ends the scroll
core.cmd('boxNext'); core.cmd('boxNext')
core.cmd('tripSet', tostring(S.stage.roadbook.boxes[7].km + 0.001))
check(not core.roadbookState().manual and core.roadbookState().viewIndex == 7, 'driving to the scrolled box follows the trip again')
-- no roadbook file (hide the ready-made ones in rallyraid/roadbooks/): back to the stage's own boxes
jsonReadFile = function(p) if p:find('%.roadbook%.json$') then return nil end return READ_JSON(p) end
core.cmd('reloadRoadbook')
check(#S.stage.roadbook.boxes == #fake.boxes - 1, 'reload without a file keeps the boxes in use')
core.loadStage(list[1].path)
S = core._debug()
check(S.stage.roadbook.source == nil and #S.stage.roadbook.boxes == #raw.roadbook.boxes, 'no roadbook file: stage boxes')
check(S.stage.waypoints[#S.stage.waypoints].km == S.stage.waypoints[#S.stage.waypoints].stageKm, 'no roadbook: stage km')
-- the ready-made roadbook that ships with the mod is found by stage id
jsonReadFile = function(p) return READ_JSON(p) end
core.loadStage(list[1].path)
S = core._debug()
check(S.stage.roadbook.source and S.stage.roadbook.source.path:find('/rallyraid/roadbooks/') == 1 and #S.stage.roadbook.boxes > #raw.roadbook.boxes, 'shipped roadbook found in rallyraid/roadbooks/')

print(string.format('%d passed, %d failed', passes, fails))
return fails
