-- rally.raid Earth: the in-game planner's game side (docs/INGAME_PLANNER.md). The planner itself (the stage
-- and roadbook documents, every edit) lives in the rally.raid Earth Planner UI app (ui/modules/apps/RallyRaidPlanner), the
-- same code as the website's builder / editor, so files stay exactly compatible. This module gives it what only the
-- game has:
--   * where the car (or the free camera) is, as lat / lon / alt from beamngEarth_api.pose() (never game coordinates:
--     BeamNG.Earth rebases the world as you drive)
--   * the driven line, recorded here so it survives the UI being closed or reloaded: a point every 10 m
--     ([lat, lon, alt]); mark() hands the piece since the last mark to the app (the leg to a new waypoint)
--   * files: reading and writing JSON text in the game's user folder (chunked, ASCII only on the way across, a backup
--     of every file it overwrites in /rallyraid/planner/backup/), only under /rallyraid/ and only .json
--   * loading a saved stage into the rally computer (rallyRaid_core.loadStage) and the teleport to its start
-- The app calls rallyRaid_core.plannerCall(name, argsJson, text); keys go through rallyRaid_core.cmd('planner<Sub>').
local geo = require('rallyRaid/geo')

local M = {}
M.DIR = '/rallyraid/planner/'
M.BACKUP_DIR = '/rallyraid/planner/backup/'
M.DRAFT_DIR = '/rallyraid/planner/drafts/'
M.DRIVE_DIR = '/rallyraid/planner/drive/'
M.STEP_M = 10                  -- driven line: one point every 10 m
M.JUMP_M = 250                 -- a jump further than this between two fixes (teleport, reset) starts a new piece
M.MAX_POINTS = 20000           -- per piece (200 km at 10 m)
M.CHUNK = 30000                -- characters per read chunk

local H = {}                   -- hooks from core: api, ui, notify, log, loadStage, teleport, stageInfo, reloadRoadbook
local P                        -- planner state
local function reset()
  P = { open = false, appSeen = false, t = 0, pushAcc = 0, fix = nil,
    rec = { on = false, piece = {}, km = 0, total = 0, last = nil, breaks = 0, startedAt = nil },
    writes = {}, reads = {}, seq = 0 }
end
reset()

local function log_(l, m) if H.log then H.log(l, m) end end
local function notify(t, s) if H.notify then H.notify(t, s) end end
local function ui(n, d) if H.ui then H.ui(n, d) end end
local function api() return H.api and H.api() end
local function r6(x) return math.floor(x * 1e6 + 0.5) / 1e6 end
local function r1(x) return math.floor(x * 10 + 0.5) / 10 end

------------------------------------------------------------------------------------------------------------------
-- where the player is
function M.pose()
  local a = api()
  if not a then return { ok = false, why = 'BeamNG.Earth not found' } end
  if a.ready and not a.ready() then return { ok = false, why = 'waiting for the world' } end
  if a.rebasing and a.rebasing() and P.fix then local f = {}; for k, v in pairs(P.fix) do f[k] = v end; f.stale = true; return f end
  local ok, p = pcall(a.pose)
  if not ok or type(p) ~= 'table' or not tonumber(p.lat) then return { ok = false, why = 'no position yet' } end
  return { ok = true, lat = r6(p.lat), lon = r6(p.lon), alt = tonumber(p.alt) and r1(p.alt) or nil,
    heading = tonumber(p.heading) and math.floor(p.heading + 0.5) % 360 or nil, speed = tonumber(p.speed) or 0, camera = p.camera == true }
end

------------------------------------------------------------------------------------------------------------------
-- the driven line
local function addFix(lat, lon, alt)
  local R = P.rec
  local last = R.last
  if last then
    local d = geo.dist(last[1], last[2], lat, lon)
    if d > M.JUMP_M then
      -- a teleport / reset: the line so far is not joined to here; the piece starts again
      R.piece, R.breaks = {}, R.breaks + 1
    elseif d < M.STEP_M then return end
    if d <= M.JUMP_M then R.km = R.km + d / 1000 end
  end
  local q = { r6(lat), r6(lon), alt and r1(alt) or nil }
  if #R.piece < M.MAX_POINTS then R.piece[#R.piece + 1] = q end
  R.total = R.total + 1
  R.last = q
end
-- every rally-computer tick (core, 10 a second) with the pose it read
function M.tick(p)
  if not (p and tonumber(p.lat)) then return end
  P.fix = { ok = true, lat = r6(p.lat), lon = r6(p.lon), alt = tonumber(p.alt) and r1(p.alt) or nil,
    heading = tonumber(p.heading) and math.floor(p.heading + 0.5) % 360 or nil, speed = tonumber(p.speed) or 0, camera = p.camera == true }
  if P.rec.on and not p.camera then addFix(p.lat, p.lon, tonumber(p.alt)) end
end
function M.teleported() if P.rec.on then P.rec.last = nil; P.rec.piece = {}; P.rec.breaks = P.rec.breaks + 1 end end
function M.recSet(on)
  local R = P.rec
  if on and not R.on then
    R.on, R.piece, R.km, R.last, R.startedAt = true, {}, 0, nil, os.time()
    local f = M.pose(); if f.ok and not f.camera then addFix(f.lat, f.lon, f.alt) end
  elseif not on and R.on then R.on = false end
  M.push()
  return R.on
end
-- the piece of driven line since the last mark (or since recording started), and the position now; the next piece
-- starts here. { ok, lat, lon, alt, heading, camera, piece = {{lat, lon, alt}, ...}, recording }
function M.mark()
  local f = M.pose()
  if not f.ok then return f end
  local R = P.rec
  local out = { ok = true, lat = f.lat, lon = f.lon, alt = f.alt, heading = f.heading, camera = f.camera, recording = R.on, piece = R.piece }
  if R.on then
    addFix(f.lat, f.lon, f.alt)
    out.piece = R.piece
    R.piece = { R.last or { f.lat, f.lon, f.alt } }
  else out.piece = {} end
  return out
end

------------------------------------------------------------------------------------------------------------------
-- files (virtual paths: /rallyraid/... is <BeamNG user folder>/current/rallyraid/..., and also the mod zip's files)
local function okPath(path)
  path = tostring(path or '')
  if not path:match('^/rallyraid/[%w%-%._/]+%.json$') or path:find('%.%.') then return nil end
  return path
end
M.okPath = okPath
local function exists(path)
  if not (FS and FS.fileExists) then return false end
  local ok, e = pcall(function() return FS:fileExists(path) end)
  return ok and e and true or false
end
local function readText(path)
  local rf = rawget(_G, 'readFile')
  if rf then local ok, t = pcall(rf, path); if ok and type(t) == 'string' then return t end end
  local f = io.open(path, 'r'); if not f then return nil end
  local t = f:read('*a'); f:close(); return t
end
local function writeText(path, text)
  local wf = rawget(_G, 'writeFile')
  if wf then local ok, r = pcall(wf, path, text); if ok and r ~= false then return true end end
  local f = io.open(path, 'w'); if not f then return false end
  f:write(text); f:close(); return true
end
M._io = { exists = exists, read = readText, write = writeText }   -- the tests replace these
-- non-ASCII as \uXXXX (UTF-8 decoded; JSON only has non-ASCII inside strings, so this stays the same JSON)
local function u16(cp)
  if cp < 0x10000 then return string.format('\\u%04x', cp) end
  cp = cp - 0x10000
  return string.format('\\u%04x\\u%04x', 0xD800 + math.floor(cp / 0x400), 0xDC00 + cp % 0x400)
end
function M.asciiJson(text)
  return (text:gsub('[\xC0-\xF7][\x80-\xBF]*', function(s)
    local c, n = s:byte(1), #s
    local cp
    if c >= 0xF0 and n == 4 then cp = (c - 0xF0) * 0x40000 + (s:byte(2) - 0x80) * 0x1000 + (s:byte(3) - 0x80) * 0x40 + (s:byte(4) - 0x80)
    elseif c >= 0xE0 and n == 3 then cp = (c - 0xE0) * 0x1000 + (s:byte(2) - 0x80) * 0x40 + (s:byte(3) - 0x80)
    elseif c >= 0xC0 and n == 2 then cp = (c - 0xC0) * 0x40 + (s:byte(2) - 0x80)
    else return '?' end
    return u16(cp)
  end))
end
local function token() P.seq = P.seq + 1; return 't' .. P.seq end
-- read: open (the whole file, ASCII-escaped, kept here), then the app asks for its chunks
function M.readOpen(path)
  path = okPath(path)
  if not path then return { ok = false, why = 'not a /rallyraid/ .json path' } end
  if not M._io.exists(path) then return { ok = false, why = 'no such file', path = path } end
  local t = M._io.read(path)
  if not t then return { ok = false, why = 'could not read', path = path } end
  t = M.asciiJson(t)
  local tok = token()
  P.reads[tok] = t
  return { ok = true, token = tok, size = #t, chunks = math.max(1, math.ceil(#t / M.CHUNK)), path = path }
end
function M.readChunk(tok, i)
  local t = P.reads[tok]; i = tonumber(i) or 1
  if not t then return nil end
  local s = t:sub((i - 1) * M.CHUNK + 1, i * M.CHUNK)
  if i * M.CHUNK >= #t then P.reads[tok] = nil end
  return s
end
-- write: begin (path), chunks of text, commit (checks it is JSON, backs up what it replaces, writes)
function M.writeBegin(path)
  path = okPath(path)
  if not path then return { ok = false, why = 'not a /rallyraid/ .json path' } end
  local tok = token()
  P.writes[tok] = { path = path, parts = {} }
  return { ok = true, token = tok }
end
function M.writeChunk(tok, text)
  local w = P.writes[tok]
  if not w or type(text) ~= 'string' then return false end
  w.parts[#w.parts + 1] = text
  return true
end
function M.backupName(path)
  local base = path:match('([^/]+)%.json$') or 'file'
  return M.BACKUP_DIR .. base .. '.' .. os.date('%Y%m%d_%H%M%S') .. '.json'
end
function M.writeCommit(tok, opts)
  local w = P.writes[tok]
  P.writes[tok] = nil
  if not w then return { ok = false, why = 'unknown write' } end
  local text = table.concat(w.parts)
  local dec = rawget(_G, 'jsonDecode')
  if dec then
    local ok, v = pcall(dec, text)
    if not ok or type(v) ~= 'table' then return { ok = false, why = 'the text is not JSON (nothing written)', path = w.path } end
  end
  local backup
  if not (opts and opts.noBackup) and M._io.exists(w.path) then
    local old = M._io.read(w.path)
    if old and old ~= text then
      backup = M.backupName(w.path)
      if not M._io.write(backup, old) then return { ok = false, why = 'could not write the backup ' .. backup, path = w.path } end
    end
  end
  if not M._io.write(w.path, text) then return { ok = false, why = 'could not write', path = w.path } end
  log_('I', 'planner wrote ' .. w.path .. ' (' .. #text .. ' bytes)' .. (backup and (', backup ' .. backup) or ''))
  return { ok = true, path = w.path, bytes = #text, backup = backup }
end
-- the files the planner can open: stages (with their roadbook) and the drafts
function M.list()
  local stages = H.listStages and H.listStages() or {}
  local drafts = {}
  if FS and FS.findFiles then
    local ok, files = pcall(function() return FS:findFiles(M.DRAFT_DIR, '*.json', -1, true, false) end)
    for _, p in ipairs(ok and type(files) == 'table' and files or {}) do drafts[#drafts + 1] = { path = p, file = tostring(p):match('([^/\\]+)$') or p } end
  end
  table.sort(drafts, function(a, b) return a.file < b.file end)
  local user
  if FS and FS.getUserPath then local ok, u = pcall(function() return FS:getUserPath() end); if ok then user = u end end
  return { stages = stages, drafts = drafts, userPath = user }
end

------------------------------------------------------------------------------------------------------------------
-- load a saved stage into the rally computer (and the car to its start)
function M.loadIntoGame(path, teleport, force)
  path = okPath(path)
  if not path then return { ok = false, why = 'not a stage path' } end
  local info = H.stageInfo and H.stageInfo() or {}
  if info.phase == 'running' and not force then
    return { ok = false, why = 'running', message = 'A stage is running (' .. tostring(info.name) .. '). Loading another ends it.' }
  end
  local ok, errs = H.loadStage(path)
  if not ok then
    local list = {}
    for _, e in ipairs(type(errs) == 'table' and errs or { errs }) do list[#list + 1] = tostring(e) end
    return { ok = false, why = 'refused', message = table.concat(list, '; ') }
  end
  local tp
  if teleport and H.teleport then tp = H.teleport() and true or false end
  return { ok = true, path = path, teleported = tp }
end

------------------------------------------------------------------------------------------------------------------
-- the app
function M.state()
  local R = P.rec
  local f = M.pose()
  local info = H.stageInfo and H.stageInfo() or {}
  return { schema = 1, open = P.open, pose = f, rec = { on = R.on, points = #R.piece, km = math.floor(R.km * 100 + 0.5) / 100, breaks = R.breaks },
    game = { stageId = info.id, stageName = info.name, phase = info.phase, path = info.path } }
end
function M.push() ui('RallyRaidPlanner', M.state()) end
function M.update(dt)
  P.t = P.t + (dt or 0)
  P.pushAcc = P.pushAcc + (dt or 0)
  if P.pushAcc >= (P.open and 0.25 or 1.0) then P.pushAcc = 0; if P.appSeen then M.push() end end
end
local function needApp()
  if not P.appSeen then notify('rally.raid Earth: add the "rally.raid Earth Planner" app (UI Apps) to plan stages in game.', 6) return true end
end
-- keys and buttons: rallyRaid_core.cmd('planner<Sub>')
function M.cmd(sub, arg)
  if sub == 'Menu' then if needApp() then return end; P.open = not P.open; M.push()
  elseif sub == 'Open' then P.open = true; M.push()
  elseif sub == 'Close' then P.open = false; M.push()
  elseif sub == 'Rec' then
    local on = M.recSet(not P.rec.on)
    notify(on and 'rally.raid Earth planner: recording the driven line (the leg to the next point you add).' or
      'rally.raid Earth planner: recording off.', 4)
  elseif sub == 'Waypoint' or sub == 'Box' then
    if needApp() then return end
    if not P.open then P.open = true end
    ui('RallyRaidPlannerKey', { key = sub == 'Waypoint' and 'waypoint' or 'box', t = P.t })
    M.push()
  elseif sub == 'AppHere' then P.appSeen = true; M.push()
  else log_('W', 'unknown planner command ' .. tostring(sub)) end
end
-- the app's calls: rallyRaid_core.plannerCall(name, argsJson, text) -> a plain table / string
function M.call(name, argsJson, text)
  local a = {}
  if type(argsJson) == 'string' and argsJson ~= '' then
    local dec = rawget(_G, 'jsonDecode')
    if dec then local ok, v = pcall(dec, argsJson); if ok and type(v) == 'table' then a = v end end
  elseif type(argsJson) == 'table' then a = argsJson end
  if name == 'state' then return M.state()
  elseif name == 'pose' then return M.pose()
  elseif name == 'mark' then return M.mark()
  elseif name == 'rec' then return { on = M.recSet(a.on == true) }
  elseif name == 'list' then return M.list()
  elseif name == 'exists' then local p = okPath(a.path); return { exists = p and M._io.exists(p) or false }
  elseif name == 'readOpen' then return M.readOpen(a.path)
  elseif name == 'readChunk' then return M.readChunk(a.token, a.i)
  elseif name == 'writeBegin' then return M.writeBegin(a.path)
  elseif name == 'writeChunk' then return M.writeChunk(a.token, text)
  elseif name == 'writeCommit' then return M.writeCommit(a.token, a)
  elseif name == 'load' then return M.loadIntoGame(a.path, a.teleport == true, a.force == true)
  elseif name == 'reloadRoadbook' then if H.reloadRoadbook then H.reloadRoadbook() end return { ok = true }
  elseif name == 'open' then P.open = a.on == true; M.push(); return { open = P.open }
  end
  return { ok = false, why = 'unknown call ' .. tostring(name) }
end

function M.init(hooks) H = hooks or {} end
function M._P() return P end
function M._reset() reset() end
return M
