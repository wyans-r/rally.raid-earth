-- A stand-in for BeamNG's GE Lua around the real mod code, for tests/bridge/bridge_server.py: the UI apps run in Chrome
-- (Angular 1.5.8, BeamNG's version) and every bngApi.engineLua call runs here, in LuaJIT, so the exact Lua strings the
-- apps send are what is tested. guihooks.trigger messages go back to the page as Angular $broadcast events.
-- Files: reads fall back to the mod folder (MOD_ROOT, as the game's virtual file system shows the mod zip); every write
-- goes to TMP_DIR (the "user folder"), which survives a RESTART (a game kill: no onExit, a fresh Lua state).
local MOD = MOD_ROOT .. '/lua/ge/extensions/'
package.path = MOD .. '?.lua;' .. MOD_ROOT .. '/lua/vehicle/extensions/?.lua;' .. package.path

EVENTS, LOGS, NOTES, GS_CALLS = {}, {}, {}, {}
CAR = { lat = 38.58, lon = -109.52, speed = 0, heading = 90, alt = 1300 }
guihooks = { trigger = function(n, d) EVENTS[#EVENTS + 1] = { n, d } end }
extensions = { hook = function() end, load = function() end, isExtensionLoaded = function() return false end }
log = function(level, tag, msg) LOGS[#LOGS + 1] = tostring(level) .. ' ' .. tostring(tag) .. ': ' .. tostring(msg) end
ui_message = function(t) NOTES[#NOTES + 1] = t end
serialize = function() return 'nil' end

local function real(p) return TMP_DIR .. p end
local function dirOf(p) return (p:match('^(.*)/[^/]*$')) or p end
function readFile(p)
  local f = io.open(real(p), 'rb')
  if f then local t = f:read('*a'); f:close(); return t end
  return READ_MOD_TEXT(p)              -- the mod's own files (stages, rallies)
end
function writeFile(p, t) MKDIR(dirOf(real(p))); local f = io.open(real(p), 'wb'); if not f then return false end f:write(t); f:close(); return true end
jsonEncode = JSON_ENCODE
jsonDecode = function(s) return DECODE_JSON(s) end
function jsonReadFile(p) local t = readFile(p); if not t then return nil end local ok, d = pcall(DECODE_JSON, t); if ok then return d end end
function jsonWriteFile(p, d) return writeFile(p, JSON_ENCODE(d)) end
FS = {
  findFiles = function(self, dir, pattern) return LIST_ANY(dir, pattern or '*.json') end,
  fileExists = function(self, p) return readFile(p) ~= nil end,
  renameFile = function(self, a, b) os.remove(real(b)); return os.rename(real(a), real(b)) end,
  removeFile = function(self, p) os.remove(real(p)) end,
  directoryCreate = function(self, d) MKDIR(real(d)) end,
  getUserPath = function() return TMP_DIR .. '/' end,
}
beamngEarth_api = {
  version = function() return 1, 8 end, ready = function() return true end, rebasing = function() return false end,
  pose = function() return { lat = CAR.lat, lon = CAR.lon, alt = CAR.alt, speed = CAR.speed, heading = CAR.heading, camera = false } end,
  notify = function(t) NOTES[#NOTES + 1] = t; return true end,
  teleport = function(lat, lon) CAR.lat, CAR.lon = lat, lon; return true end,
}
core_gamestate = { state = { state = 'freeroam', appLayout = 'freeroam', menuItems = 'freeroam' },
  setGameState = function(state, layout, menu) GS_CALLS[#GS_CALLS + 1] = { state, layout, menu }; core_gamestate.state.appLayout = layout end }

rallyRaid_core = require('rallyRaid/core')
rallyRaid_core.onExtensionLoaded()
