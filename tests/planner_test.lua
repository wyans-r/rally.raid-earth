-- The in-game planner's game side (mod/lua/ge/extensions/rallyRaid/planner.lua): position, the driven line (10 m
-- points, jumps start a new piece, mark hands a piece over), keys and the app check, file reads / writes (only
-- /rallyraid/*.json, chunked, ASCII-escaped, JSON-checked, a backup of what is replaced), and loading a saved stage
-- (one the planner's JS wrote, tests/fixtures/planner/, from tests/planner/planner.test.js) into the rally computer.
-- Run with tests/run_tests.py (LuaJIT through lupa).
local MOD = MOD_ROOT .. '/lua/ge/extensions/'
package.path = MOD .. '?.lua;' .. package.path
local car = { lat = 38.567602, lon = -109.531389, alt = 1350.0, speed = 0, heading = 90, camera = false }
local ui, files, notes, apiOn = {}, {}, {}, true
guihooks = { trigger = function(n, d) ui[n] = d end }
extensions = { hook = function() end }
log = function() end
jsonDecode = DECODE_JSON
jsonReadFile = function(p) if files[p] then return DECODE_JSON(files[p]) end return READ_JSON(p) end
jsonWriteFile = function(p, d) return true end
FS = { findFiles = function(self, dir) local l = LIST_FILES(dir); local extra = {}
         for k in pairs(files) do if k:sub(1, #dir) == dir and k:match('%.json$') then extra[#extra + 1] = k end end
         for _, k in ipairs(extra) do l[#l + 1] = k end; return l end,
       fileExists = function(self, p) return files[p] ~= nil end }
local teleports = 0
beamngEarth_api = { version = function() return 1, 8 end, ready = function() return apiOn end, rebasing = function() return false end,
  pose = function() return { lat = car.lat, lon = car.lon, alt = car.alt, speed = car.speed, ve = car.speed, vn = 0, heading = car.heading, camera = car.camera } end,
  notify = function(t) notes[#notes + 1] = t; return true end, teleport = function() teleports = teleports + 1; return true end }
local geo = require('rallyRaid/geo')
local core = require('rallyRaid/core')
local planner = require('rallyRaid/planner')
planner._io = { exists = function(p) return files[p] ~= nil end, read = function(p) return files[p] end, write = function(p, t) files[p] = t; return true end }
local fails, passes = 0, 0
local function check(c, m) if c then passes = passes + 1 else fails = fails + 1; print('FAIL: ' .. m) end end
local KX = 111320 * math.cos(math.rad(car.lat))
local function drive(metres, stepM, climb)
  stepM = stepM or 2
  local n = math.floor(metres / stepM)
  car.speed = 20
  for _ = 1, n do
    car.lon = car.lon + stepM / KX
    car.alt = car.alt + (climb or 0) * stepM
    core.onUpdate(0.1, 0.1)
  end
  car.speed = 0
end
local function call(name, args, text) return core.plannerCall(name, args, text) end
local function lastNote() return notes[#notes] or '' end

-- position ----------------------------------------------------------------------------------------------------------
local p = call('pose')
check(p.ok and math.abs(p.lat - 38.567602) < 1e-9 and p.alt == 1350 and p.heading == 90 and p.camera == false, 'pose: lat / lon / alt / heading')
car.camera = true; p = call('pose'); check(p.ok and p.camera == true, 'pose: the free camera is a position too (flagged)'); car.camera = false
apiOn = false; p = call('pose'); check(not p.ok and p.why == 'waiting for the world', 'pose: world not ready -> why'); apiOn = true

-- the driven line ---------------------------------------------------------------------------------------------------
local r = call('rec', '{"on": true}')
check(r.on == true and planner._P().rec.on, 'rec on')
drive(1000, 2, 0.02)
local R = planner._P().rec
check(#R.piece >= 80 and #R.piece <= 102, 'a point every 10-12 m over 1 km (2 m a tick): ' .. #R.piece)
check(math.abs(R.km - 1.0) < 0.03, 'recorded km ~1.0: ' .. R.km)
local okStep = true
for i = 2, #R.piece do local d = geo.dist(R.piece[i - 1][1], R.piece[i - 1][2], R.piece[i][1], R.piece[i][2]); if d < 9.9 or d > 12.1 then okStep = false end end
check(okStep, 'points 10-12 m apart')
check(R.piece[#R.piece][3] > R.piece[1][3] + 15, 'altitude recorded (climbing 2 %)')
local m = call('mark')
check(m.ok and m.recording and #m.piece >= 80, 'mark hands over the piece: ' .. #m.piece)
check(math.abs(m.lat - car.lat) < 1e-6 and math.abs(m.lon - car.lon) < 1e-6, 'mark: the car position')
check(#planner._P().rec.piece == 1, 'the next piece starts at the mark')
drive(200, 2)
-- a teleport: 5 km away -> a new piece, no distance added
local kmBefore = planner._P().rec.km
car.lon = car.lon + 5000 / KX
core.onUpdate(0.1, 0.1)
check(planner._P().rec.breaks == 1 and #planner._P().rec.piece == 1, 'a 5 km jump starts a new piece')
check(math.abs(planner._P().rec.km - kmBefore) < 0.001, 'the jump adds no distance')
core.onBeamNGEarthTeleported({})
check(planner._P().rec.breaks == 2 and #planner._P().rec.piece == 0, 'BeamNG.Earth teleport event: a new piece')
call('rec', '{"on": false}')
check(not planner._P().rec.on, 'rec off')
m = call('mark')
check(m.ok and not m.recording and #m.piece == 0, 'mark without recording: no piece (a straight leg)')
-- the key toggles recording without the app
core.cmd('plannerRec'); check(planner._P().rec.on and lastNote():match('recording the driven line'), 'Ctrl+Shift+K: recording on, said')
core.cmd('plannerRec'); check(not planner._P().rec.on, 'Ctrl+Shift+K again: off')

-- keys and the app ----------------------------------------------------------------------------------------------------
ui = {}
core.cmd('plannerWaypoint')
check(ui.RallyRaidPlannerKey == nil and lastNote():match('Rally Raid Planner'), 'waypoint key without the app on the HUD: tells you to add it')
core.cmd('plannerMenu'); check(planner._P().open == false, 'menu key without the app: stays closed')
core.cmd('plannerAppHere')
check(ui.RallyRaidPlanner and ui.RallyRaidPlanner.schema == 1, 'app here: state pushed')
core.cmd('plannerWaypoint')
check(ui.RallyRaidPlannerKey and ui.RallyRaidPlannerKey.key == 'waypoint' and planner._P().open, 'waypoint key: event to the app, planner opens')
core.cmd('plannerBox'); check(ui.RallyRaidPlannerKey.key == 'box', 'box key: event to the app')
core.cmd('plannerMenu'); check(planner._P().open == false, 'menu key: closes'); core.cmd('plannerMenu'); check(planner._P().open == true, 'menu key: opens')
ui = {}; for _ = 1, 3 do core.onUpdate(0.1, 0.1) end
check(ui.RallyRaidPlanner and ui.RallyRaidPlanner.open == true and ui.RallyRaidPlanner.pose.ok, 'open: state pushed 4 a second with the pose')
check(ui.RallyRaidPlanner.rec and ui.RallyRaidPlanner.rec.on == false, 'state carries the recording')

-- writing files -----------------------------------------------------------------------------------------------------
for _, bad in ipairs({ '/etc/passwd.json', '/rallyraid/../settings/x.json', '/rallyraid/stages/x.lua', 'rallyraid/stages/x.json', '/rallyraid/stages/a b.json' }) do
  check(call('writeBegin', '{"path": "' .. bad .. '"}').ok == false, 'refuses to write ' .. bad)
end
local w = call('writeBegin', '{"path": "/rallyraid/stages/pl-test.json"}')
check(w.ok and w.token, 'write begin')
check(call('writeChunk', '{"token": "' .. w.token .. '"}', '{"format": "rallyraid-stage", ') == true, 'chunk 1')
call('writeChunk', '{"token": "' .. w.token .. '"}', '"a": 1}')
local c = call('writeCommit', '{"token": "' .. w.token .. '"}')
check(c.ok and files['/rallyraid/stages/pl-test.json'] == '{"format": "rallyraid-stage", "a": 1}' and c.backup == nil, 'commit: the chunks joined, no backup for a new file')
w = call('writeBegin', '{"path": "/rallyraid/stages/pl-test.json"}'); call('writeChunk', '{"token": "' .. w.token .. '"}', '{"broken": ')
c = call('writeCommit', '{"token": "' .. w.token .. '"}')
check(not c.ok and c.why:match('not JSON') and files['/rallyraid/stages/pl-test.json']:match('"a": 1'), 'text that is not JSON is not written')
w = call('writeBegin', '{"path": "/rallyraid/stages/pl-test.json"}'); call('writeChunk', '{"token": "' .. w.token .. '"}', '{"a": 2}')
c = call('writeCommit', '{"token": "' .. w.token .. '"}')
check(c.ok and c.backup and c.backup:match('^/rallyraid/planner/backup/pl%-test%.%d+_%d+%.json$') and files[c.backup]:match('"a": 1'), 'overwrite: the old file is backed up first: ' .. tostring(c.backup))
check(files['/rallyraid/stages/pl-test.json'] == '{"a": 2}', 'overwrite: new text')
w = call('writeBegin', '{"path": "/rallyraid/stages/pl-test.json"}'); call('writeChunk', '{"token": "' .. w.token .. '"}', '{"a": 2}')
c = call('writeCommit', '{"token": "' .. w.token .. '"}')
check(c.ok and c.backup == nil, 'the same text again: no backup')
check(call('writeCommit', '{"token": "nope"}').ok == false, 'unknown token refused')

-- reading files (chunked, non-ASCII escaped) -------------------------------------------------------------------------
local txt = '{"name": "Hassi Labied \xc3\xa9 \xe2\xb5\x83 \xd8\xad \xf0\x9f\x98\x80", "pad": "' .. string.rep('x', 70000) .. '"}'
files['/rallyraid/stages/utf.json'] = txt
local o = call('readOpen', '{"path": "/rallyraid/stages/utf.json"}')
check(o.ok and o.chunks == 3, 'read open: 3 chunks of 30000: ' .. tostring(o.chunks))
local parts = {}
for i = 1, o.chunks do parts[#parts + 1] = call('readChunk', '{"token": "' .. o.token .. '", "i": ' .. i .. '}') end
local got = table.concat(parts)
check(not got:find('[\x80-\xff]'), 'read: ASCII only')
check(got:find('Hassi Labied \\u00e9 \\u2d43 \\u062d \\ud83d\\ude00', 1, true) ~= nil, 'read: UTF-8 as \\u escapes (with a surrogate pair)')
local dec = DECODE_JSON(got)
check(dec.name == 'Hassi Labied \xc3\xa9 \xe2\xb5\x83 \xd8\xad \xf0\x9f\x98\x80' and #dec.pad == 70000, 'read: decodes to the same text')
check(planner._P().reads[o.token] == nil, 'read: released after the last chunk')
check(call('readOpen', '{"path": "/rallyraid/stages/none.json"}').why == 'no such file', 'read: missing file')
check(call('exists', '{"path": "/rallyraid/stages/utf.json"}').exists == true, 'exists')

-- loading a stage the planner wrote ----------------------------------------------------------------------------------
local stText = READ_TEXT('tests/fixtures/planner/ingame-test-stage.json')
local rbText = READ_TEXT('tests/fixtures/planner/ingame-test-stage.roadbook.json')
check(stText ~= nil and rbText ~= nil, 'fixtures from tests/planner/planner.test.js (run node --test tests/planner/ first)')
if stText and rbText then
  local function put(path, text)
    local t = call('writeBegin', '{"path": "' .. path .. '"}'); call('writeChunk', '{"token": "' .. t.token .. '"}', text)
    return call('writeCommit', '{"token": "' .. t.token .. '"}')
  end
  check(put('/rallyraid/stages/ingame-test-stage.json', stText).ok, 'stage written')
  check(put('/rallyraid/roadbooks/ingame-test-stage.roadbook.json', rbText).ok, 'roadbook written')
  local l = call('load', '{"path": "/rallyraid/stages/ingame-test-stage.json", "teleport": true}')
  check(l.ok and l.teleported == true and teleports == 1, 'load into the game + teleport to the DSS')
  local S = core._debug()
  check(S and S.stage.id == 'ingame-test-stage' and S.phase == 'armed', 'the rally computer has the stage, armed')
  local stJ = DECODE_JSON(stText)
  check(#S.stage.waypoints == #stJ.waypoints, 'every waypoint: ' .. #S.stage.waypoints)
  check(S.stage.roadbook.source and S.stage.roadbook.source.count > 2, 'the planner\'s roadbook is used: ' .. tostring(S.stage.roadbook.source and S.stage.roadbook.source.count))
  local list = call('list')
  local found = false
  for _, e in ipairs(list.stages) do if e.id == 'ingame-test-stage' and e.ok and e.roadbook then found = true end end
  check(found, 'the stage list shows it with its roadbook')
  -- a running stage is not replaced without asking
  S.phase = 'running'
  l = call('load', '{"path": "/rallyraid/stages/ingame-test-stage.json"}')
  check(not l.ok and l.why == 'running', 'a running stage: refused unless forced')
  l = call('load', '{"path": "/rallyraid/stages/ingame-test-stage.json", "force": true}')
  check(l.ok and core._debug().phase == 'armed', 'forced: loaded, armed')
  -- a stage the game refuses says why
  put('/rallyraid/stages/bad.json', '{"format": "rallyraid-stage", "schemaVersion": 1, "id": "bad", "waypoints": [{"id": "a", "type": "WPV", "lat": 1, "lon": 2}, {"id": "b", "type": "ASS", "lat": 1, "lon": 2.01}]}')
  l = call('load', '{"path": "/rallyraid/stages/bad.json"}')
  check(not l.ok and l.message:match('first waypoint must be the DSS'), 'refused stage: the reason: ' .. tostring(l.message))
end
check(call('nonsense').ok == false, 'unknown call')

-- the keys: each planner action exists, calls a command the planner knows, and has its Ctrl+Shift key
do
  local acts = DECODE_JSON(READ_TEXT('mod/lua/ge/extensions/core/input/actions/rallyRaid.json'))
  local keys = DECODE_JSON(READ_TEXT('mod/settings/inputmaps/keyboard_rallyRaid.json'))
  local want = { rallyRaid_plannerMenu = 'ctrl shift j', rallyRaid_plannerWaypoint = 'ctrl shift w', rallyRaid_plannerBox = 'ctrl shift b', rallyRaid_plannerRec = 'ctrl shift k' }
  local seen, controls, dup = {}, {}, false
  for _, b in ipairs(keys.bindings) do seen[b.action] = b.control; if controls[b.control] then dup = true end; controls[b.control] = true end
  for a, k in pairs(want) do
    local c = acts[a] and acts[a].onDown:match("cmd%('(planner%a+)'%)")
    check(c ~= nil and seen[a] == k, a .. ': ' .. tostring(c) .. ' on ' .. tostring(seen[a]))
  end
  check(not dup, 'no key used twice')
  planner._reset()
  core.cmd('plannerAppHere'); core.cmd('plannerMenu'); check(planner._P().open == true, 'plannerMenu opens once the app is on the HUD')
end

print(passes .. ' passed, ' .. fails .. ' failed')
return fails
