-- rally.raid Earth: OFFICIAL RUNS of an async event (docs/EVENTS.md). The website (stagebuilder.wyans.net/events) gives each
-- entrant an event pack per stage: <user folder>/rallyraid/events/<event>-ss<n>.rrevent.json. It holds the locked stage
-- and roadbook files as text, their SHA-256 hashes (the ones published on the event page), the event's window and
-- rules, the minimum mod version, and the entrant's upload key.
--
--   load:   the pack's files are hashed here and must match its hashes; the mod must be new enough; the official rules
--           are forced (game-crash resume limits ON with the event's penalties, Recover car's limits, reset keys
--           blocked); the in-game planner, recce and roadbook reload are refused, so no route is shown on any map.
--   start:  the same checks again before the DSS clock can start (a failed check keeps the stage armed).
--   finish: a result package (result + waypoint log + hashes + mod version + GPS trace + resume / recovery flags) is
--           written to /rallyraid/results/official/ and sent to the website over plain HTTP (LuaSocket: the game's Lua
--           has no HTTPS). No network or a refusal: the file stays there for the website's drag-and-drop upload.
local sha = require('rallyRaid/sha256')
local cfgAll = require('rallyRaid/repairConfig')
local stagesMod = require('rallyRaid/stages')

local M = {}
M.PACK_FORMAT = 'rallyraid-event-pack'
M.PACKAGE_FORMAT = 'rallyraid-result-package'
M.DIR = '/rallyraid/events/'
M.OUT_DIR = '/rallyraid/results/official/'
M.UPLOAD_TIMEOUT_S = 15

local H = {}
local O = { active = nil, upload = nil, last = nil, saved = nil, msg = nil }

local function log_(l, m) if H.log then H.log(l, m) end end
local function notify(t, s) if H.notify then H.notify(t, s) end end
local function iso(e) return os.date('!%Y-%m-%dT%H:%M:%SZ', e) end

-- files / json / time / http: the game's, replaced in tests
local function fs() return rawget(_G, 'FS') end
M.io = {
  read = function(p) local r = rawget(_G, 'readFile'); if not r then return nil end local ok, t = pcall(r, p); if ok and type(t) == 'string' then return t end end,
  write = function(p, t) local w = rawget(_G, 'writeFile'); if not w then return false end return (pcall(w, p, t)) end,
  mkdir = function(d) local f = fs(); if f and f.directoryCreate then pcall(f.directoryCreate, f, d, true) end end,
  list = function(d)
    local f = fs()
    if not (f and f.findFiles) then return {} end
    local ok, files = pcall(function() return f:findFiles(d, '*.rrevent.json', -1, true, false) end)
    return ok and files or {}
  end,
  encode = function(t) local e = rawget(_G, 'jsonEncode'); if not e then return nil end local ok, s = pcall(e, t); return ok and s or nil end,
  decode = function(s) local d = rawget(_G, 'jsonDecode'); if not d then return nil end local ok, r = pcall(d, s); if ok then return r end end,
  time = function() return os.time() end,
  -- POST body to url; returns http status code (number) and the response text, or nil, why
  post = function(url, body, headers)
    local okH, http = pcall(require, 'socket.http')
    local okL, ltn12 = pcall(require, 'ltn12')
    if not (okH and http and okL and ltn12) then return nil, 'no LuaSocket in this game build' end
    if url:sub(1, 8) == 'https://' then return nil, 'the game cannot do HTTPS' end
    http.TIMEOUT = M.UPLOAD_TIMEOUT_S
    local out = {}
    local h = { ['Content-Type'] = 'application/json', ['Content-Length'] = tostring(#body), ['User-Agent'] = 'RallyRaidMod' }
    for k, v in pairs(headers or {}) do h[k] = v end
    local ok, r, code = pcall(http.request, { url = url, method = 'POST', headers = h, source = ltn12.source.string(body),
      sink = ltn12.sink.table(out), redirect = false })
    if not ok then return nil, tostring(r) end
    if not r then return nil, tostring(code) end
    return tonumber(code), table.concat(out)
  end,
}

-- '0.2.0' >= '0.1.9' ?
function M.versionAtLeast(have, need)
  if not need or need == '' then return true end
  local a, b = {}, {}
  for n in tostring(have):gmatch('%d+') do a[#a + 1] = tonumber(n) end
  for n in tostring(need):gmatch('%d+') do b[#b + 1] = tonumber(n) end
  for i = 1, math.max(#a, #b) do
    local x, y = a[i] or 0, b[i] or 0
    if x ~= y then return x > y end
  end
  return true
end

local function epochOf(s)
  if type(s) ~= 'string' then return tonumber(s) end
  local y, mo, d, h, mi, se = s:match('^(%d+)-(%d+)-(%d+)T(%d+):(%d+):?(%d*)')
  if not y then return nil end
  -- days since 1970-01-01 (proleptic Gregorian, H. Hinnant's days_from_civil): no time zone involved
  y, mo, d = tonumber(y), tonumber(mo), tonumber(d)
  if mo <= 2 then y = y - 1 end
  local era = math.floor(y / 400)
  local yoe = y - era * 400
  local mp = (mo + 9) % 12
  local doy = math.floor((153 * mp + 2) / 5) + d - 1
  local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
  local days = era * 146097 + doe - 719468
  return days * 86400 + tonumber(h) * 3600 + tonumber(mi) * 60 + (tonumber(se) or 0)
end
M.epochOf = epochOf

------------------------------------------------------------------------------------------------------------------
-- the checks (load, and again before the start)
function M.check(pack, modVersion, now)
  local errs, warns, hashes = {}, {}, {}
  if type(pack) ~= 'table' or pack.format ~= M.PACK_FORMAT then return { ok = false, errors = { 'not an event pack' }, warnings = {} } end
  local files = type(pack.files) == 'table' and pack.files or {}
  for _, k in ipairs({ 'stage', 'roadbook' }) do
    local f = files[k]
    if type(f) ~= 'table' or type(f.text) ~= 'string' then
      if k == 'stage' then errs[#errs + 1] = 'the pack has no stage file' else warns[#warns + 1] = 'no roadbook in the pack' end
    else
      hashes[k] = sha.hex(f.text)
      if hashes[k] ~= f.sha256 then errs[#errs + 1] = k .. ' file hash does not match the published hash (file changed)' end
    end
  end
  local ev = type(pack.event) == 'table' and pack.event or {}
  if not M.versionAtLeast(modVersion, ev.minModVersion) then
    errs[#errs + 1] = 'mod version ' .. tostring(modVersion) .. ' is older than the event needs (' .. tostring(ev.minModVersion) .. '): update the mod'
  end
  local o, c = epochOf(ev.opensAt), epochOf(ev.closesAt)
  if o and now < o then errs[#errs + 1] = 'the event opens at ' .. tostring(ev.opensAt) .. ' (UTC)' end
  if c and now > c then errs[#errs + 1] = 'the event closed at ' .. tostring(ev.closesAt) .. ' (UTC)' end
  if type(pack.entry) ~= 'table' or not pack.entry.token then warns[#warns + 1] = 'no upload key in the pack: upload the result file on the website' end
  return { ok = #errs == 0, errors = errs, warnings = warns, hashes = hashes, checkedAt = iso(now) }
end

------------------------------------------------------------------------------------------------------------------
-- official rules: forced while an official stage is loaded, put back afterwards
local function forceRules(ev)
  if O.savedRules then return end
  local g, go = cfgAll.gameCrashResume, cfgAll.gameCrashResumeOfficial
  O.savedRules = { use = g.useOfficialRules, off = {}, block = cfgAll.block and cfgAll.block.useCompetitiveTemplate }
  for k, v in pairs(go) do O.savedRules.off[k] = v end
  g.useOfficialRules = true                                 -- resume limits ON (3 / rally, 1 / stage, none within 1 km)
  -- Wyans 2026-11-16: a game-crash resume has no time penalty (flagged for review); an event may set one
  local r = type(ev.rules) == 'table' and type(ev.rules.gameCrashResume) == 'table' and ev.rules.gameCrashResume or {}
  go.firstPenaltyS = tonumber(r.firstPenaltyS) or 0
  go.laterPenaltyS = tonumber(r.laterPenaltyS) or 0
  if cfgAll.carRecovery then O.savedRules.recEnabled = cfgAll.carRecovery.enabled; cfgAll.carRecovery.enabled = true end
end
local function restoreRules()
  local s = O.savedRules
  if not s then return end
  cfgAll.gameCrashResume.useOfficialRules = s.use
  for k in pairs(cfgAll.gameCrashResumeOfficial) do cfgAll.gameCrashResumeOfficial[k] = s.off[k] end
  if cfgAll.carRecovery then cfgAll.carRecovery.enabled = s.recEnabled end
  O.savedRules = nil
end

------------------------------------------------------------------------------------------------------------------
function M.list()
  local out = {}
  for _, p in ipairs(M.io.list(M.DIR)) do
    local raw = M.io.read(p)
    local d = raw and M.io.decode(raw)
    if type(d) == 'table' and d.format == M.PACK_FORMAT then
      local ev, st = d.event or {}, d.stage or {}
      out[#out + 1] = { path = p, event = ev.name, eventId = ev.id, stage = st.name, stageNo = st.index, opensAt = ev.opensAt,
        closesAt = ev.closesAt, entrant = d.entry and d.entry.displayName or nil, class = d.entry and d.entry.class or nil }
    end
  end
  return out
end

-- load a pack as the official stage. Returns true or false, errors
function M.load(path)
  local raw = M.io.read(path)
  if not raw then return false, { 'cannot read ' .. tostring(path) } end
  local pack = M.io.decode(raw)
  local c = M.check(pack, H.modVersion, M.io.time())
  if not c.ok then
    O.msg = 'Official run refused: ' .. table.concat(c.errors, '; ')
    notify('rally.raid Earth: ' .. O.msg, 10); M.push()
    return false, c.errors
  end
  local stage, nerrs = stagesMod.normalize(M.io.decode(pack.files.stage.text))
  if not stage then return false, nerrs or { 'the stage file is not a valid stage' } end
  local ev, st = pack.event or {}, pack.stage or {}
  local safe = tostring(ev.id or 'event'):gsub('[^%w%-_]', '_')
  local rbPath
  if pack.files.roadbook and pack.files.roadbook.text then
    M.io.mkdir(M.DIR .. safe)
    rbPath = M.DIR .. safe .. '/' .. tostring(stage.id or 'stage'):gsub('[^%w%-_]', '_') .. '.roadbook.json'
    M.io.write(rbPath, pack.files.roadbook.text)
  end
  stage.roadbook = type(stage.roadbook) == 'table' and stage.roadbook or {}
  stage.roadbook.file = rbPath
  stage.path = path
  O.active = { path = path, pack = pack, check = c, stageId = stage.id, eventId = ev.id, loadedAt = iso(M.io.time()) }
  O.msg = nil
  forceRules(ev)
  local ok, errs = H.loadStageTable(stage)
  if ok == false then M.deactivate('load failed'); return false, errs end
  notify('rally.raid Earth: OFFICIAL RUN: ' .. tostring(ev.name) .. ', ' .. tostring(st.name or stage.name) .. '. Files verified. No route on the map; roadbook only.', 8)
  M.push()
  return true
end

-- core.loadStageTable asks: is this the official stage? (another stage loaded = official mode off)
function M.attach(stage)
  local a = O.active
  if a and stage and stage.path == a.path and stage.id == a.stageId then
    return { eventId = a.eventId, eventName = a.pack.event.name, stageNo = a.pack.stage and a.pack.stage.index, entryId = a.pack.entry and a.pack.entry.id }
  end
  if a then M.deactivate('another stage loaded') end
  return nil
end
function M.deactivate(why)
  if O.active then log_('I', 'official run off: ' .. tostring(why)) end
  O.active = nil
  restoreRules()
  M.push()
end
function M.active() return O.active ~= nil end
-- refused in an official run: anything that shows the route or changes the locked files
function M.refuse(what)
  if not O.active then return false end
  notify('rally.raid Earth: not in an official run (' .. what .. ').', 4)
  return true
end

-- before the DSS clock starts
function M.preStart()
  local a = O.active
  if not a then return true end
  local c = M.check(a.pack, H.modVersion, M.io.time())
  a.check = c
  if not c.ok then
    O.msg = 'Start blocked: ' .. table.concat(c.errors, '; ')
    notify('rally.raid Earth: ' .. O.msg, 10); M.push()
    return false
  end
  a.startChecked = c.checkedAt
  return true
end

------------------------------------------------------------------------------------------------------------------
-- the finish: result package, file, upload
function M.buildPackage(res, trace)
  local a = O.active
  local pack = a.pack
  local pkg = {
    format = M.PACKAGE_FORMAT, schemaVersion = 1, createdAt = iso(M.io.time()),
    modVersion = H.modVersion,
    event = { id = pack.event.id, name = pack.event.name },
    stage = { index = pack.stage and pack.stage.index, key = pack.stage and pack.stage.key, id = a.stageId },
    entry = { id = pack.entry and pack.entry.id, displayName = pack.entry and pack.entry.displayName, class = pack.entry and pack.entry.class },
    hashes = { stage = a.check.hashes.stage, roadbook = a.check.hashes.roadbook },
    checks = { loaded = a.loadedAt, start = a.startChecked, errors = a.check.errors, warnings = a.check.warnings },
    rules = { gameCrashResume = res.gameCrashResume and res.gameCrashResume.rules or nil, carRecovery = res.carRecovery and res.carRecovery.rules or nil,
      official = true },
    result = res,
    trace = trace,
  }
  return pkg
end

local function pack_upload_ok(pack) return type(pack.event) == 'table' and type(pack.event.uploadUrl) == 'string' and type(pack.entry) == 'table' and pack.entry.token ~= nil end

function M.finish(res, trace)
  local a = O.active
  if not a then return nil end
  local pkg = M.buildPackage(res, trace)
  local body = M.io.encode(pkg)
  if not body then O.msg = 'could not encode the result package'; M.push() return nil end
  M.io.mkdir(M.OUT_DIR)
  local safe = (tostring(a.eventId) .. '_ss' .. tostring(pkg.stage.index or 1)):gsub('[^%w%-_]', '_')
  local file = M.OUT_DIR .. safe .. '_' .. os.date('%Y%m%d_%H%M%S', M.io.time()) .. '.rrresult.json'
  local wrote = M.io.write(file, body)
  O.last = { file = wrote and file or nil, bytes = #body, status = 'saved', at = pkg.createdAt }
  -- the upload waits a frame so the finish message shows first (the request blocks the game for up to 15 s)
  if pack_upload_ok(a.pack) then O.upload = { body = body, url = a.pack.event.uploadUrl, token = a.pack.entry.token, wait = 0.5 }; O.last.status = 'uploading' end
  M.push()
  return file, body
end

function M.doUpload(u)
  local code, text = M.io.post(u.url, u.body, { Authorization = 'Bearer ' .. tostring(u.token) })
  local L = O.last or {}
  O.last = L
  if code and code >= 200 and code < 300 then
    local d = M.io.decode(text or '') or {}
    L.status, L.server = 'uploaded', d
    O.msg = 'Result uploaded: ' .. tostring(d.status or 'received') .. (d.url and (' ' .. d.url) or '')
    notify('rally.raid Earth: ' .. O.msg, 8)
  else
    L.status, L.error = 'saved', code and ('server said ' .. tostring(code) .. ': ' .. tostring(text):sub(1, 200)) or tostring(text)
    O.msg = 'Upload failed (' .. tostring(L.error) .. '). Upload the file on the event page: ' .. tostring(L.file)
    notify('rally.raid Earth: ' .. O.msg, 12)
  end
  M.push()
  return L.status == 'uploaded'
end
-- retry from the app (the package that was just made)
function M.retryUpload()
  local a, L = O.active, O.last
  if not (a and L and L.file) then return false end
  local body = M.io.read(L.file)
  if not body or not pack_upload_ok(a.pack) then return false end
  O.upload = { body = body, url = a.pack.event.uploadUrl, token = a.pack.entry.token, wait = 0 }
  return true
end

function M.update(dt)
  local u = O.upload
  if not u then return end
  u.wait = u.wait - (dt or 0)
  if u.wait > 0 then return end
  O.upload = nil
  M.doUpload(u)
end

function M.state()
  local a = O.active
  return { active = a ~= nil, event = a and a.pack.event.name or nil, eventId = a and a.eventId or nil,
    stage = a and a.pack.stage and a.pack.stage.name or nil, entrant = a and a.pack.entry and a.pack.entry.displayName or nil,
    checks = a and a.check or nil, last = O.last, msg = O.msg, packs = O.packs }
end
function M.push() if H.ui then H.ui('RallyRaidOfficial', M.state()) end end
function M.cmd(name, arg)
  if name == 'List' then O.packs = M.list(); M.push()
  elseif name == 'Load' then M.load(arg)
  elseif name == 'Retry' then M.retryUpload()
  elseif name == 'Off' then M.deactivate('switched off'); M.push()
  elseif name == 'Here' then O.packs = M.list(); M.push() end
end

function M.init(h) H = h or {} end
function M._O() return O end
function M._reset() restoreRules(); O = { active = nil } end
return M
