-- The keys (Wyans 2026-11-17: "take the hotkeys out for everything except the most important to do while driving ...
-- and rely on hud buttons"): only the 9 driving keys keep a default, every other action is still declared (so a player
-- can bind it in Options > Controls) and the apps / messages show the player's actual key (rallyRaid/keys.lua).
-- Run with tests/run_tests.py (LuaJIT through lupa).
local MOD = MOD_ROOT .. '/lua/ge/extensions/'
package.path = MOD .. '?.lua;' .. package.path
local car = { lat = 38.567602, lon = -109.531389, alt = 1350.0, speed = 0, heading = 90, camera = false }
local ui, notes = {}, {}
guihooks = { trigger = function(n, d) ui[n] = d end }
extensions = { hook = function() end }
log = function() end
jsonDecode = DECODE_JSON
jsonReadFile = function(p) return READ_JSON(p) end
jsonWriteFile = function() return true end
FS = { findFiles = function(self, dir) return LIST_FILES(dir) end, fileExists = function() return false end }
beamngEarth_api = { version = function() return 1, 8 end, ready = function() return true end, rebasing = function() return false end,
  pose = function() return { lat = car.lat, lon = car.lon, alt = car.alt, speed = 0, ve = 0, vn = 0, heading = 90, camera = false } end,
  notify = function(t) notes[#notes + 1] = t; return true end, teleport = function() return true end }
local keys = require('rallyRaid/keys')
local core = require('rallyRaid/core')
local fails, passes = 0, 0
local function check(c, m) if c then passes = passes + 1 else fails = fails + 1; print('FAIL: ' .. m) end end

local acts = DECODE_JSON(READ_TEXT('mod/lua/ge/extensions/core/input/actions/rallyRaid.json'))
local kb = DECODE_JSON(READ_TEXT('mod/settings/inputmaps/keyboard_rallyRaid.json'))
local KEPT = { rallyRaid_tripPlus = 'ctrl shift up', rallyRaid_tripMinus = 'ctrl shift down', rallyRaid_wPlus = 'ctrl shift right',
  rallyRaid_wMinus = 'ctrl shift left', rallyRaid_partialReset = 'ctrl shift p', rallyRaid_start = 'ctrl shift home',
  rallyRaid_boxPrev = 'ctrl shift pageup', rallyRaid_boxNext = 'ctrl shift pagedown', rallyRaid_boxSync = 'ctrl shift end' }

-- the keyboard file: exactly the 9 kept keys, nothing else
do
  local n, seen = 0, {}
  for _, b in ipairs(kb.bindings) do n = n + 1; seen[b.action] = b.control end
  check(n == 9, 'keyboard file has 9 bindings (' .. n .. ')')
  for a, c in pairs(KEPT) do check(seen[a] == c, a .. ' keeps ' .. c .. ' (' .. tostring(seen[a]) .. ')') end
  for a in pairs(seen) do check(KEPT[a] ~= nil, a .. ' should not have a default key') end
  for a, c in pairs(keys.DEFAULTS) do check(seen[a] == c, 'keys.DEFAULTS matches the keyboard file: ' .. a) end
  for a in pairs(seen) do check(keys.DEFAULTS[a] ~= nil, 'keys.DEFAULTS has ' .. a) end
end

-- every action still declared, each calls the rally computer, and no description names a key that is not bound
do
  local n = 0
  for a, d in pairs(acts) do
    n = n + 1
    check(type(d.onDown) == 'string' and d.onDown:find('rallyRaid_core') ~= nil, a .. ' calls rallyRaid_core')
    check(not (d.desc or ''):find('Ctrl') and not (d.title or ''):find('Ctrl'), a .. ': no key named in title / desc')
    if not KEPT[a] then check((d.desc or ''):lower():find('no key by default') ~= nil, a .. ': desc says no key by default') end
  end
  check(n == 25, '25 actions declared (' .. n .. ')')
end

-- labels
check(keys.label('ctrl shift pageup') == 'Ctrl+Shift+PgUp', 'label PgUp')
check(keys.label('ctrl shift pagedown') == 'Ctrl+Shift+PgDn', 'label PgDn')
check(keys.label('ctrl shift end') == 'Ctrl+Shift+End', 'label End')
check(keys.label('alt g') == 'Alt+G', 'label Alt+G')
check(keys.label('ctrl shift delete') == 'Ctrl+Shift+Del', 'label Del')
check(keys.label('') == nil and keys.label(nil) == nil, 'label of nothing')

-- no game bindings table: the shipped defaults
keys.invalidate()
local all = keys.all(true)
check(keys.source == 'defaults', 'no core_input_bindings: defaults')
check(all.rallyRaid_boxSync == 'Ctrl+Shift+End' and all.rallyRaid_tripPlus == 'Ctrl+Shift+Up', 'defaults labelled')
check(all.rallyRaid_recoverCar == nil and all.rallyRaid_gameResume == nil and all.rallyRaid_plannerMenu == nil, 'unbound actions: no key')
check(keys.hint('rallyRaid_recoverCar') == '' and keys.hint('rallyRaid_boxSync') == ' (Ctrl+Shift+End)', 'hint: none / default')

-- the game's bindings: the player moved sync to F5 and bound recover car to Alt+G (and a pad button to W+)
core_input_bindings = { bindings = {
  { devname = 'xinput0', contents = { bindings = { { control = 'btn_a', action = 'rallyRaid_wPlus' } } } },
  { devname = 'keyboard0', contents = { bindings = {
    { control = 'ctrl shift up', action = 'rallyRaid_tripPlus' }, { control = 'f5', action = 'rallyRaid_boxSync' },
    { control = 'alt g', action = 'rallyRaid_recoverCar' }, { control = 'ctrl shift right', action = 'rallyRaid_wPlus' },
    { control = 'up', action = 'accelerate' } } } } } }
all = keys.all(true)
check(keys.source == 'game', 'bindings read from the game')
check(all.rallyRaid_boxSync == 'F5', 'rebound sync shows F5 (' .. tostring(all.rallyRaid_boxSync) .. ')')
check(all.rallyRaid_recoverCar == 'Alt+G', 'a player-bound recover shows its key')
check(all.rallyRaid_wPlus == 'Ctrl+Shift+Right', 'keyboard key preferred over the pad')
check(all.rallyRaid_boxPrev == nil, 'an action the player unbound shows no key')
check(all.accelerate == nil, 'only rally.raid Earth actions')
-- the hook pushes them to the apps
ui.RallyRaidKeys = nil
core.onInputBindingsChanged()
check(ui.RallyRaidKeys and ui.RallyRaidKeys.keys.rallyRaid_recoverCar == 'Alt+G' and ui.RallyRaidKeys.source == 'game', 'bindings changed: RallyRaidKeys pushed')
ui.RallyRaidKeys = nil; core.cmd('keys'); check(ui.RallyRaidKeys ~= nil, "cmd('keys') pushes the keys")
ui.RallyRaidKeys = nil; core.requestState(); check(ui.RallyRaidKeys ~= nil, 'requestState pushes the keys')
-- a table in another shape: back to the defaults
core_input_bindings = { bindings = { { devname = 'keyboard0' } } }
all = keys.all(true)
check(keys.source == 'defaults' and all.rallyRaid_boxSync == 'Ctrl+Shift+End', 'unreadable bindings table: defaults')
core_input_bindings = { bindings = 'nonsense' }
check(keys.all(true).rallyRaid_start == 'Ctrl+Shift+Home', 'nonsense bindings table: defaults')
core_input_bindings = nil
keys.invalidate()

-- messages: no unbound key named
notes = {}
core.cmd('recceConfirm')
check(notes[#notes] and not notes[#notes]:find('Ctrl') and notes[#notes]:find('RECCE'), 'recce off: points to the RECCE button: ' .. tostring(notes[#notes]))

-- the Lua and the apps name no unbound default key
do
  local unbound = { 'Ctrl%+Shift%+[RNCMTZFGHJWBK]%f[^%w]', 'Ctrl%+Shift%+Del' }
  for _, f in ipairs({ 'core', 'gameResume', 'resume', 'repair', 'repairConfig', 'planner', 'recce' }) do
    local t = READ_TEXT('mod/lua/ge/extensions/rallyRaid/' .. f .. '.lua') or ''
    for _, pat in ipairs(unbound) do check(not t:find(pat), f .. '.lua names an unbound key (' .. pat .. ')') end
  end
  for _, app in ipairs({ 'RallyRaidGPS', 'RallyRaidRoadbook', 'RallyRaidRepair', 'RallyRaidPlanner' }) do
    local js = READ_TEXT('mod/ui/modules/apps/' .. app .. '/app.js') or ''
    check(not js:find('Ctrl%+Shift'), app .. '/app.js: no hardcoded Ctrl+Shift key (the keys come from RallyRaidKeys)')
    local desc = READ_TEXT('mod/ui/modules/apps/' .. app .. '/app.json') or ''
    for _, pat in ipairs(unbound) do check(not desc:find(pat), app .. '/app.json names an unbound key (' .. pat .. ')') end
  end
end

print(passes .. ' passed, ' .. fails .. ' failed')
return fails
