-- The 17 Nov in-game bug batch, game side (tests/browser/bridge_test.js runs the same Lua behind the real apps):
-- command logging and error capture, the app heartbeat, the layout switch, the UI log limit, the planner not refusing
-- without its app, and the rally ledger being written at once (the crash-resume root cause).
local fails, passes = 0, 0
local function check(cond, msg) if cond then passes = passes + 1 else fails = fails + 1; print('FAIL: ' .. msg) end end
local function has(list, pat) for _, l in ipairs(list) do if tostring(l):find(pat) then return true end end return false end
local function count(list, pat) local n = 0 for _, l in ipairs(list) do if tostring(l):find(pat) then n = n + 1 end end return n end

-- the bridge env (tests/bridge/env.lua) wants these: the mod's files, and a listing of the mod + the temp user folder
READ_MOD_TEXT = function(p) return READ_TEXT('mod' .. p) end
LIST_ANY = function(dir, pattern)
  local out = {}
  local lst = LIST_FILES(dir)
  for i = 1, #lst do out[#out + 1] = lst[i] end
  local pipe = io.popen('cd "' .. TMP_DIR .. '" 2>/dev/null && find .' .. dir .. ' -type f 2>/dev/null')
  if pipe then for l in pipe:lines() do out[#out + 1] = l:sub(2) end pipe:close() end
  local rx = '^' .. pattern:gsub('%.', '%%.'):gsub('%*', '.*') .. '$'
  local res = {}
  for _, f in ipairs(out) do if f:match('[^/]*$'):match(rx) then res[#res + 1] = f end end
  return res
end
local function boot()
  for k in pairs(package.loaded) do if k:find('^rallyRaid/') then package.loaded[k] = nil end end
  dofile(MOD_ROOT .. '/../tests/bridge/env.lua')
  return rallyRaid_core
end
os.remove(TMP_DIR .. '/rallyraid/rally/current.json')
local core = boot()

-- the ledger: written when it is made, the same rally id after a kill (fresh Lua)
local f = io.open(TMP_DIR .. '/rallyraid/rally/current.json', 'rb')
check(f ~= nil, 'a new rally ledger is written at once')
if f then f:close() end
check(has(LOGS, '%[rally%.raid Earth%] rally ledger: new rally %d+%-%d+ %(written'), 'ledger creation logged')
check(has(LOGS, '%[rally%.raid Earth%] rally%.raid Earth .* loaded'), 'extension load logged with the prefix')
check(has(LOGS, 'crash saves on disk'), 'startup scan logged')
local id1 = require('rallyRaid/repair').ledger().id
core = boot()
check(require('rallyRaid/repair').ledger().id == id1, 'same rally id after a relaunch: ' .. tostring(id1))
check(has(LOGS, 'rally ledger: rally ' .. id1:gsub('%-', '%%-') .. ' %(from'), 'ledger reload logged')

-- command logging
LOGS = {}
core.cmd('tripReset', nil, 'gps')
check(has(LOGS, '%[rally%.raid Earth%] cmd tripReset %(gps%)'), 'a button press is logged with its app')
core.cmd('tripStep', '50', 'gps')
check(has(LOGS, 'cmd tripStep "50" %(gps%)'), 'the argument is logged')
LOGS = {}
for i = 1, 20 do core.cmd('tripPlus', nil, 'hold') end
check(count(LOGS, 'cmd tripPlus') == 0, 'held trip repeats are not logged (no per-frame spam)')
-- a Lua error in a command: logged, a notice, no error thrown to the UI
LOGS, NOTES = {}, {}
local real = core.unloadStage
core.unloadStage = function() error('boom') end
local ok = pcall(core.cmd, 'unload', nil, 'gps')
core.unloadStage = real
check(ok, 'an error inside a command does not escape')
check(has(LOGS, '^E .*cmd unload.*boom') or has(LOGS, '^E .*boom'), 'the error is logged as E with the message')
check(#NOTES > 0, 'and the player gets a notice')

-- the app heartbeat
check(not core.appOn('repair'), 'no Repair app yet')
core.appHello('repair', true)
check(core.appOn('repair'), 'hello: the Repair app is on screen')
check(has(LOGS, 'app on screen: repair'), 'first hello logged')
LOGS = {}
for i = 1, 30 do core.appHello('repair', true) end
check(count(LOGS, 'app on screen') == 0, 'repeated hellos are not logged')
for i = 1, 90 do core.onUpdate(0.1, 0.1) end
check(not core.appOn('repair'), 'no hello for 9 s: the app is gone (closed, or UI reloaded)')
core.appHello('repair', true); core.appHello('planner', true)
local snap = core.getState()
check(snap.apps and snap.apps.repair == true and snap.apps.planner == true and snap.apps.gps == false, 'the state tells the GPS which apps are on screen')
check(core.appHello('repair', false) == false and not core.appOn('repair'), 'hello(false): gone at once')
check(core.appHint('repair'):find('Repair') and core.appHint('repair'):find('RALLY LAYOUT'), 'hint: ' .. core.appHint('repair'))

-- the layouts
GS_CALLS = {}
core_gamestate.state.appLayout = 'freeroam'
core.cmd('appsRally', nil, 'gps')
check(#GS_CALLS == 1 and GS_CALLS[1][2] == 'rallyRaidEarth', 'RALLY LAYOUT -> setGameState(.., rallyRaidEarth, ..)')
core.cmd('appsPlanner', nil, 'gps')
check(GS_CALLS[2] and GS_CALLS[2][2] == 'rallyRaidEarthPlanner', 'PLANNER LAYOUT')
core.cmd('appsBack', nil, 'gps')
check(GS_CALLS[3] and GS_CALLS[3][2] == 'freeroam', 'MY LAYOUT: back to the layout before (freeroam)')
local saved = core_gamestate; core_gamestate = nil; NOTES = {}
pcall(core.cmd, 'appsRally', nil, 'gps')
core_gamestate = saved
check(#NOTES > 0, 'no core_gamestate: a notice, not an error')

-- the UI log limit
LOGS = {}
for i = 1, 50 do core.uiLog('gps', 'press ' .. i) end
local n = count(LOGS, 'UI gps: press')
check(n > 0 and n <= 31, 'UI log lines are limited per app (got ' .. n .. ' of 50)')

-- the planner opens without its app having said hello
core.appHello('planner', false)
NOTES = {}
core.cmd('plannerOpen', nil, 'gps')
local P = require('rallyRaid/planner')._P()
check(P.open == true, 'GPS PLANNER opens the planner menu even before the Planner app said hello')

print(string.format('ingame1117_test: %d passed, %d failed', passes, fails))
return fails
