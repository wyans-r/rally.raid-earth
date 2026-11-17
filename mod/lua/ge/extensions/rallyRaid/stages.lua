-- rally.raid Earth: finding, reading and checking stage files (docs/STAGE_FORMAT.md).
-- Stage files live in the game's virtual folder /rallyraid/stages/, which merges:
--   <BeamNG user folder>/current/rallyraid/stages/*.json   (your own and downloaded stages)
--   rallyraid/stages/*.json inside any mod zip               (this mod's samples, or a "stage pack" mod)
local geo = require('rallyRaid/geo')

local M = {}
M.DIR = '/rallyraid/stages/'
M.ROADBOOK_DIR = '/rallyraid/roadbooks/'
M.ROADBOOK_FORMAT = 'rallyraid-roadbook'
M.ROADBOOK_SCHEMA = 1
M.FORMAT = 'rallyraid-stage'
M.SCHEMA = 1

local TYPES = { DSS = true, WPV = true, WPE = true, WPM = true, WPN = true, WPS = true, WPC = true, WPP = true,
  DZ = true, FZ = true, ASS = true }
M.TYPES = TYPES

local function readJson(path)
  local read = rawget(_G, 'jsonReadFile')
  if not read then return nil, 'jsonReadFile missing' end
  local ok, data = pcall(read, path)
  if not ok then return nil, tostring(data) end
  if type(data) ~= 'table' then return nil, 'not a JSON object' end
  return data
end

-- check and tidy a decoded stage table. Returns stage or nil, errors (a list of strings)
function M.normalize(s)
  local errs = {}
  if type(s) ~= 'table' then return nil, { 'not a JSON object' } end
  if s.format ~= nil and s.format ~= M.FORMAT then errs[#errs + 1] = 'format is not "' .. M.FORMAT .. '"' end
  local sv = tonumber(s.schemaVersion) or 0
  if sv < 1 then errs[#errs + 1] = 'schemaVersion missing' end
  if sv > M.SCHEMA then errs[#errs + 1] = 'schemaVersion ' .. sv .. ' is newer than this mod understands (' .. M.SCHEMA .. ')' end
  if type(s.waypoints) ~= 'table' or #s.waypoints < 2 then
    errs[#errs + 1] = 'needs at least a DSS and an ASS waypoint'
    return nil, errs
  end
  local wps = {}
  for i, w in ipairs(s.waypoints) do
    local t = type(w.type) == 'string' and w.type:upper() or nil
    local lat, lon = tonumber(w.lat), tonumber(w.lon)
    if not (t and TYPES[t]) then errs[#errs + 1] = 'waypoint ' .. i .. ': unknown type ' .. tostring(w.type) end
    if not (lat and lon and lat >= -90 and lat <= 90 and lon >= -180 and lon <= 180) then
      errs[#errs + 1] = 'waypoint ' .. i .. ': bad lat / lon'
    end
    if t == 'DZ' and not tonumber(w.speedLimit) then errs[#errs + 1] = 'waypoint ' .. i .. ': DZ needs speedLimit (km/h)' end
    local c = {}
    for k, v in pairs(w) do c[k] = v end
    c.type, c.lat, c.lon, c.index = t, lat, lon, i
    c.n = tonumber(w.n) or i
    c.speedLimit = tonumber(w.speedLimit)
    wps[i] = c
  end
  if #errs > 0 then return nil, errs end
  if wps[1].type ~= 'DSS' then errs[#errs + 1] = 'the first waypoint must be the DSS' end
  if wps[#wps].type ~= 'ASS' then errs[#errs + 1] = 'the last waypoint must be the ASS' end
  local inZone = false
  for i, w in ipairs(wps) do
    if (w.type == 'DSS' and i ~= 1) or (w.type == 'ASS' and i ~= #wps) then
      errs[#errs + 1] = 'waypoint ' .. i .. ': ' .. w.type .. ' only at the start / end'
    end
    if w.type == 'DZ' then
      if inZone then errs[#errs + 1] = 'waypoint ' .. i .. ': DZ inside another speed zone (close it with FZ first)' end
      inZone = true
    elseif w.type == 'FZ' then
      if not inZone then errs[#errs + 1] = 'waypoint ' .. i .. ': FZ without a DZ before it' end
      inZone = false
    end
  end
  if inZone then errs[#errs + 1] = 'a speed zone (DZ) is never closed with an FZ' end
  if #errs > 0 then return nil, errs end
  -- roadbook km: from the file (the builder measures along the route), else straight lines
  local km = 0
  for i, w in ipairs(wps) do
    if i > 1 then km = km + geo.dist(wps[i - 1].lat, wps[i - 1].lon, w.lat, w.lon) / 1000 end
    if not tonumber(w.km) then w.km = km else w.km = tonumber(w.km) end
  end
  s.waypoints = wps
  s.id = tostring(s.id or s.name or 'stage')
  s.name = tostring(s.name or s.id)
  s.roadbook = type(s.roadbook) == 'table' and s.roadbook or {}
  s.roadbook.boxes = type(s.roadbook.boxes) == 'table' and s.roadbook.boxes or {}
  return s, nil
end

function M.load(path)
  local raw, err = readJson(path)
  if not raw then return nil, { err } end
  local s, errs = M.normalize(raw)
  if s then s.path = path end
  return s, errs
end

-- every stage file: { {path, file, id, name, ok, error, waypoints, km}, ... } sorted by name
function M.list()
  local out = {}
  if not (FS and FS.findFiles) then return out end
  local ok, files = pcall(function() return FS:findFiles(M.DIR, '*.json', -1, true, false) end)
  if not ok or type(files) ~= 'table' then return out end
  for _, path in ipairs(files) do
    if tostring(path):match('%.roadbook%.json$') then goto continue end   -- a roadbook kept next to its stage
    local s, errs = M.load(path)
    local file = tostring(path):match('([^/\\]+)$') or path
    if s then
      out[#out + 1] = { path = path, file = file, id = s.id, name = s.name, ok = true,
        waypoints = #s.waypoints, km = s.waypoints[#s.waypoints].km, region = s.region, roadbook = M.findRoadbook(s) }
    else
      out[#out + 1] = { path = path, file = file, name = file, ok = false, error = table.concat(errs or {}, '; ') }
    end
    ::continue::
  end
  table.sort(out, function(a, b) return tostring(a.name) < tostring(b.name) end)
  return out
end

-- the roadbook file made in the stage builder's roadbook editor (docs/ROADBOOK_FORMAT.md). Looked for in order:
--   1. stage.roadbook.file (a path; without a leading / it is relative to /rallyraid/roadbooks/)
--   2. /rallyraid/roadbooks/<stage id>.roadbook.json
--   3. next to the stage file: <stage file name>.roadbook.json
-- Returns boxes (live boxes, sorted by km, only the fields the HUD needs), info { path, count, warnings } or nil, why
local BOX_FIELDS = { 'id', 'n', 'km', 'partial', 'cap', 'capIn', 'capOut', 'label', 'waypoint', 'notes', 'danger',
  'symbols', 'tulip', 'offPiste', 'verified', 'lat', 'lon', 'rev', 'source', 'pinned' }
function M.roadbookCandidates(stage)
  local c = {}
  local f = type(stage.roadbook) == 'table' and stage.roadbook.file
  if type(f) == 'string' and f:match('%.json$') then c[#c + 1] = f:sub(1, 1) == '/' and f or (M.ROADBOOK_DIR .. f) end
  c[#c + 1] = M.ROADBOOK_DIR .. tostring(stage.id) .. '.roadbook.json'
  if type(stage.path) == 'string' then c[#c + 1] = (stage.path:gsub('%.json$', '')) .. '.roadbook.json' end
  return c
end
-- the first roadbook file that exists for this stage (nil if none): shown in the roadbook app's stage list
function M.findRoadbook(stage)
  if not (FS and FS.fileExists) then return nil end
  for _, path in ipairs(M.roadbookCandidates(stage)) do
    local ok, e = pcall(function() return FS:fileExists(path) end)
    if ok and e then return path end
  end
end
function M.normalizeRoadbook(rb, stage)
  if type(rb) ~= 'table' then return nil, 'not a JSON object' end
  if rb.format ~= M.ROADBOOK_FORMAT then return nil, 'format is not "' .. M.ROADBOOK_FORMAT .. '"' end
  if (tonumber(rb.schemaVersion) or 0) > M.ROADBOOK_SCHEMA then return nil, 'schemaVersion ' .. tostring(rb.schemaVersion) .. ' is newer than this mod understands' end
  local rs = type(rb.stage) == 'table' and rb.stage or {}
  if rs.id and stage.id and tostring(rs.id) ~= tostring(stage.id) then return nil, 'made for stage ' .. tostring(rs.id) .. ', not ' .. tostring(stage.id) end
  local out = {}
  for _, b in ipairs(type(rb.boxes) == 'table' and rb.boxes or {}) do
    if type(b) == 'table' and not b.deleted and tonumber(b.km) then
      local c = {}
      for _, k in ipairs(BOX_FIELDS) do c[k] = b[k] end
      c.km = tonumber(b.km)
      if type(c.notes) ~= 'string' then c.notes = c.notes and tostring(c.notes) or '' end
      if type(c.tulip) ~= 'table' then c.tulip = nil end
      if type(c.symbols) ~= 'table' then c.symbols = {} end
      out[#out + 1] = c
    end
  end
  if #out == 0 then return nil, 'no boxes' end
  table.sort(out, function(a, b) if a.km ~= b.km then return a.km < b.km end return (tonumber(a.n) or 0) < (tonumber(b.n) or 0) end)
  for i, b in ipairs(out) do b.n = i; b.partial = i > 1 and math.floor((b.km - out[i - 1].km) * 100 + 0.5) / 100 or 0 end
  -- the roadbook belongs to a (possibly older) version of the stage: a length change of more than 200 m means its
  -- distances no longer match (the editor's stage hash check is the exact test; this is the cheap in-game one)
  local warnings = {}
  local wps = stage.waypoints or {}
  local lastKm = wps[#wps] and tonumber(wps[#wps].stageKm or wps[#wps].km)
  local rbLen = tonumber(rs.lengthKm)
  if lastKm and rbLen and math.abs(lastKm - rbLen) > 0.2 then
    warnings[#warnings + 1] = string.format('roadbook is for a %.2f km stage, this one is %.2f km: re-sync it in the editor', rbLen, lastKm)
  end
  return out, warnings
end
-- the roadbook's distances are what the driver reads, so the waypoints take their km from the roadbook's waypoint boxes
-- (the trip snaps to these at each waypoint). The roadbook may follow a planned off-piste line a little longer than
-- the stage's straight legs. The stage's own km is kept in stageKm.
function M.applyRoadbookKm(stage, boxes)
  local at = {}
  for _, b in ipairs(boxes or {}) do if b.waypoint ~= nil then at[tostring(b.waypoint)] = b.km end end
  local n = 0
  for _, w in ipairs(stage.waypoints or {}) do
    if w.stageKm == nil then w.stageKm = w.km end
    local k = w.id ~= nil and at[tostring(w.id)]
    if k then w.km = k; n = n + 1 else w.km = w.stageKm end
  end
  return n
end
function M.loadRoadbook(stage)
  local why = {}
  for _, path in ipairs(M.roadbookCandidates(stage)) do
    local exists = true
    if FS and FS.fileExists then local ok, e = pcall(function() return FS:fileExists(path) end); exists = (not ok) or e end
    if exists then
      local raw = readJson(path)
      if raw then
        local boxes, w = M.normalizeRoadbook(raw, stage)
        if boxes then return boxes, { path = path, count = #boxes, warnings = w, name = raw.name, revision = raw.revision, id = raw.id,
          stageHash = type(raw.stage) == 'table' and raw.stage.hash or nil } end
        why[#why + 1] = path .. ': ' .. tostring(w)
      end
    end
  end
  return nil, why
end

return M
