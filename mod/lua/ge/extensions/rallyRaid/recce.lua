-- rally.raid Earth: recce mode (docs/ROADBOOK_FORMAT.md "Recce").
-- Drive the stage before racing it and correct the roadbook from the real world:
--   * the driven line is recorded in lat / lon (from BeamNG.Earth's pose, so the world's rebasing cannot break it)
--   * the car's own motion adds boxes: jumps (airtime, length, height), hard compressions, crests (pitch-over),
--     soft sand (slow + wheelspin), steep climbs / descents and side slopes (terrain probes or the car's attitude)
--   * the driver drops boxes at the car's position (symbol / danger quick-pick) and confirms, moves, retags or deletes
--     the nearest roadbook box
-- Every one of those is a change record {op, id, baseRev, by, ...} saved in /rallyraid/recce/<stage id>.recce.json.
-- They are merged into the .roadbook.json in game (M.merge, same rules as the editor's RoadbookGen.applyChanges) or
-- imported in the stage builder's roadbook editor. This file has no direct game calls except in M.gameSampler /
-- M.gameProbe, so it runs in the unit tests with simulated telemetry.
local geo = require('rallyRaid/geo')

local M = {}
M.DIR = '/rallyraid/recce/'
M.FORMAT = 'rallyraid-recce'
M.SCHEMA = 1
M.STEP_M = 10                 -- driven line: one point every 10 m
M.NEAR_M = 150                -- "nearest box" range
M.G = 9.81
-- detection thresholds (tuned on simulated runs; see tests/recce_test.lua)
M.T = {
  airAccel = 3.0,             -- m/s2: proper acceleration along the car's up axis below this = falling freely
  airMin = 0.35,              -- s of airtime for a jump box
  airLand = 6.0,              -- m/s2 above this = wheels back on the ground
  compressG = 2.4,            -- g along the up axis (1 g = standing still) for a compression box
  landGrace = 0.6,            -- s after a landing in which a big g is the landing, not a compression
  crestPitch = 6,             -- deg: nose up at least this before and nose down at least this after
  crestWithinM = 30,          -- ... within this many metres of travel
  crestMinSpeed = 8,          -- m/s
  sandSlip = 0.35,            -- (wheel speed - ground speed) / ground speed
  sandMaxKmh = 30, sandThrottle = 0.4, sandTime = 2.5,
  slopeGrade = 0.25,          -- 25 % climb / descent ...
  slopeLen = 30,              -- ... for at least 30 m
  sideGrade = 0.30,           -- side slope 30 % (17 deg) ...
  sideLen = 25,
  dupM = 40,                  -- two automatic boxes of the same kind closer than this: keep one
  sameAsBoxM = 60,            -- an automatic box this close to a roadbook box with the same symbol: noted as `near`
}
-- the quick-pick's first page (FIM legend names; the app's other tabs show the whole library from roadbook-render.js)
M.QUICK = { 'jump', 'crest', 'bump', 'compression', 'dip', 'ditch', 'step_down', 'hole', 'ruts', 'undulations', 'twisty',
  'soft_sand', 'dunes', 'rocks', 'danger', 'keep_left', 'keep_right', 'narrow', 'water', 'climb', 'descent', 'sideslope_l',
  'sideslope_r', 'junction', 'trees', 'vegetation', 'fence', 'gate', 'cliff', 'over_crest' }
-- note presets for correcting a roadbook while driving it (roadbook wording: capitals, short; danger is the ! buttons)
M.PRESETS = { 'TRACK FADES', 'KEEP LEFT', 'KEEP RIGHT', 'ROUGH', 'STONY', 'SOFT SAND', 'JUNCTION NOT VISIBLE', 'HOLE',
  'BIG BUMP', 'NARROW', 'STAY ON TRACK', 'CAUTION' }
M.NOTES_MAX = 120

local R                       -- the running recce (nil = off)

local function now() return os.date('!%Y-%m-%dT%H:%M:%SZ') end
local function r2(x, d) local m = 10 ^ (d or 0); return math.floor(x * m + 0.5) / m end
local function upper(s) return (tostring(s or ''):upper()) end
local function contains(t, v) for _, x in ipairs(t or {}) do if x == v then return true end end return false end
local function copy(t) if type(t) ~= 'table' then return t end local c = {} for k, v in pairs(t) do c[k] = copy(v) end return c end
local function arr(x) if type(x) ~= 'table' then return {} end if #x > 0 or next(x) == nil then return x end
  local keys = {} for k in pairs(x) do keys[#keys + 1] = tonumber(k) end table.sort(keys)
  local out = {} for _, k in ipairs(keys) do out[#out + 1] = x[k] or x[tostring(k)] end return out end

------------------------------------------------------------------------------------------------------------------
-- game access (replaced in tests)
-- one physics sample of the player vehicle in game coordinates (fine for derivatives within a frame or two; nothing
-- here is stored in game coordinates): position, velocity, nose and roof direction
function M.gameSampler()
  local be_ = rawget(_G, 'be')
  local v = be_ and be_:getPlayerVehicle(0)
  if not v then return nil end
  local ok, s = pcall(function()
    local p, vel, d, u = v:getPosition(), v:getVelocity(), v:getDirectionVector(), v:getDirectionVectorUp()
    return { x = p.x, y = p.y, z = p.z, vx = vel.x, vy = vel.y, vz = vel.z, dx = d.x, dy = d.y, dz = d.z,
      ux = u.x, uy = u.y, uz = u.z, vid = v:getID() }
  end)
  return ok and s or nil
end
-- height of the ground under game point x, y (a ray cast straight down), or nil
function M.gameProbe(x, y, z)
  local cast = rawget(_G, 'castRayStatic')
  local vec = rawget(_G, 'vec3')
  if not (cast and vec) then return nil end
  local ok, d = pcall(cast, vec(x, y, z + 30), vec(0, 0, -1), 80)
  if ok and tonumber(d) and d < 80 then return z + 30 - d end
  return nil
end
-- ask the vehicle (its own Lua VM) for wheel speed and throttle: answers through rallyRaid_core.recceVeh
function M.gameAskVehicle()
  local be_ = rawget(_G, 'be')
  local v = be_ and be_:getPlayerVehicle(0)
  if not v then return end
  pcall(function() v:queueLuaCommand("obj:queueGameEngineLua('if rallyRaid_core then rallyRaid_core.recceVeh(' .. tostring(electrics.values.wheelspeed or 0) .. ',' .. tostring(electrics.values.throttle or 0) .. ') end')") end)
end
M.sampler, M.probe, M.askVehicle = M.gameSampler, M.gameProbe, M.gameAskVehicle

local function readJson(path)
  local read = rawget(_G, 'jsonReadFile')
  if not read then return nil end
  local ok, d = pcall(read, path)
  if ok and type(d) == 'table' then return d end
end
local function writeJson(path, data)
  local write = rawget(_G, 'jsonWriteFile')
  if not write then return false end
  local ok, r = pcall(write, path, data, false)
  return ok and r ~= false
end

------------------------------------------------------------------------------------------------------------------
-- start / stop
function M.path(stageId) return M.DIR .. tostring(stageId) .. '.recce.json' end
function M.active() return R ~= nil end
function M.get() return R end

-- ctx: { stage, boxes (the roadbook display's box list, edited live), rbInfo ({path, revision, id, stageHash}),
--        trip = function() return km end }; fresh = ignore an earlier recce file of this stage
function M.start(ctx, fresh)
  local stage = ctx.stage
  local file = M.path(stage.id)
  local old = (not fresh) and readJson(file) or nil
  if old and (old.format ~= M.FORMAT or (old.stage and old.stage.id ~= stage.id)) then old = nil end
  local info = ctx.rbInfo or {}
  R = { ctx = ctx, file = file, dirty = true, saveAcc = 0, seq = 0, events = {}, lastEvent = nil, pending = nil,
    doc = old or { format = M.FORMAT, schemaVersion = M.SCHEMA, created = now(),
      stage = { id = stage.id, name = stage.name, hash = info.stageHash },
      roadbook = { id = info.id, revision = info.revision, file = info.path },
      driven = { stepM = M.STEP_M, points = {}, breaks = {} }, changes = {}, applied = {} },
    -- detectors
    acc = nil, prevVel = nil, air = nil, landedAt = -99, comp = nil, pitchHist = {}, sand = { t = 0, start = nil },
    slope = nil, side = nil, veh = { wheel = nil, throttle = nil, t = -99 }, askAcc = 0, clock = 0,
    fixes = {}, lastPt = nil, km = 0 }
  local d = R.doc
  d.driven = d.driven or { stepM = M.STEP_M }
  d.driven.points, d.driven.breaks = arr(d.driven.points), arr(d.driven.breaks)
  d.changes, d.applied = arr(d.changes), arr(d.applied)
  local pts = d.driven.points
  if #pts > 0 then R.km = (tonumber(pts[#pts][3]) or 0) * 1000; R.lastPt = { lat = pts[#pts][1], lon = pts[#pts][2] }; d.driven.breaks[#d.driven.breaks + 1] = #pts + 1 end
  -- a resumed recce: its not yet merged changes show on the roadbook display again
  for _, c in ipairs(d.changes) do M.applyToDisplay(ctx.boxes, c) end
  d.started = d.started or now()
  R.sessionFrom = #d.changes            -- changes before this index were made in an earlier recce of this stage
  return R
end

function M.stop()
  if not R then return end
  M.commitPending()
  M.save()
  local d = R.doc
  R = nil
  return d
end

function M.save()
  if not R then return false end
  local d = R.doc
  d.updated = now()
  d.driven.km = r2(R.km / 1000, 3)
  local ok = writeJson(R.file, d)
  if ok then R.dirty = false end
  return ok
end

------------------------------------------------------------------------------------------------------------------
-- the roadbook display list: keep it in step with the changes (so new boxes show up while driving)
local function renumber(boxes)
  table.sort(boxes, function(a, b) local ka, kb = tonumber(a.km) or 0, tonumber(b.km) or 0; if ka ~= kb then return ka < kb end return tostring(a.id) < tostring(b.id) end)
  for i, b in ipairs(boxes) do b.n = i; b.partial = i > 1 and r2((b.km - boxes[i - 1].km), 2) or 0 end
end
M.renumber = renumber

function M.applyToDisplay(boxes, c)
  if type(boxes) ~= 'table' or type(c) ~= 'table' then return end
  if c.op == 'add' then
    for _, b in ipairs(boxes) do if b.id == c.id then return end end
    local b = copy(c.box or {})
    b.id, b.source, b.rev = c.id, c.by, 1
    b.symbols = arr(b.symbols); b.notes = b.notes or ''; b.danger = tonumber(b.danger) or 0; b.label = b.label or 'NOTE'
    b.verified = c.by ~= 'recce-auto'; b.recce = c.by
    boxes[#boxes + 1] = b
  else
    for i, b in ipairs(boxes) do
      if b.id == c.id then
        if c.op == 'delete' then table.remove(boxes, i)
        elseif c.op == 'confirm' then b.verified = true
        elseif c.op == 'move' then b.lat, b.lon, b.km = c.lat or b.lat, c.lon or b.lon, c.km or b.km; b.verified = true
        elseif c.op == 'update' then for k, v in pairs(c.fields or {}) do b[k] = copy(v) end; b.verified = c.by ~= 'recce-auto' or b.verified end
        b.rev = (tonumber(b.rev) or 1) + 1; b.recce = b.recce or c.by
        break
      end
    end
  end
  renumber(boxes)
end

local function addChange(c)
  if not R then return end
  c.at = c.at or now()
  R.doc.changes[#R.doc.changes + 1] = c
  M.applyToDisplay(R.ctx.boxes, c)
  R.dirty = true
  R.preview = nil                       -- a merge preview is out of date after any change
  M.save()
  return c
end

-- rebuild the display from the roadbook file + the remaining changes (after an undo)
local function rebuild(reload)
  if not reload then return end
  local fresh = reload()
  if not fresh then return end
  for k in pairs(R.ctx.boxes) do R.ctx.boxes[k] = nil end
  for i, b in ipairs(fresh) do R.ctx.boxes[i] = b end
  for _, x in ipairs(R.doc.changes) do M.applyToDisplay(R.ctx.boxes, x) end
end
-- undo change i of the list (default: the last one). Undoing an added box also drops the later changes to that box.
-- Returns the change and how many later changes went with it.
function M.undoAt(i, reload)
  if not R then return nil end
  local ch = R.doc.changes
  i = tonumber(i) or #ch
  if not ch[i] then return nil end
  local c = table.remove(ch, i)
  if i <= (R.sessionFrom or 0) then R.sessionFrom = R.sessionFrom - 1 end
  local dropped = 0
  if c.op == 'add' then
    for j = #ch, i, -1 do
      if ch[j].id == c.id then table.remove(ch, j); dropped = dropped + 1; if j <= (R.sessionFrom or 0) then R.sessionFrom = R.sessionFrom - 1 end end
    end
  end
  rebuild(reload)
  R.preview = nil
  M.save()
  return c, dropped
end
function M.undo(reload) return M.undoAt(nil, reload) end

------------------------------------------------------------------------------------------------------------------
-- the driven line and positions
-- fix = { lat, lon, trip (km), speed (m/s) }, from rallyRaid_core every tick (0.1 s)
function M.tick(fix, dt)
  if not R or not fix or not fix.lat then return end
  R.clock = R.clock + (dt or 0)
  local d = R.doc
  local pts = d.driven.points
  if not R.lastPt then
    pts[#pts + 1] = { r2(fix.lat, 7), r2(fix.lon, 7), r2(R.km / 1000, 3) }
    R.lastPt = { lat = fix.lat, lon = fix.lon }
  else
    local m = geo.dist(R.lastPt.lat, R.lastPt.lon, fix.lat, fix.lon)
    if m > 250 then                                  -- teleport / reset: a gap in the line, not driven distance
      d.driven.breaks[#d.driven.breaks + 1] = #pts + 1
      pts[#pts + 1] = { r2(fix.lat, 7), r2(fix.lon, 7), r2(R.km / 1000, 3) }
      R.lastPt = { lat = fix.lat, lon = fix.lon }
    elseif m >= M.STEP_M then
      R.km = R.km + m
      pts[#pts + 1] = { r2(fix.lat, 7), r2(fix.lon, 7), r2(R.km / 1000, 3) }
      R.lastPt = { lat = fix.lat, lon = fix.lon }
      R.dirty = true
    end
  end
  -- recent fixes, to place a detection at the spot it started
  local f = { t = R.clock, lat = fix.lat, lon = fix.lon, trip = fix.trip, heading = fix.heading, km = R.km / 1000 + (R.lastPt and geo.dist(R.lastPt.lat, R.lastPt.lon, fix.lat, fix.lon) / 1000 or 0) }
  R.fixes[#R.fixes + 1] = f
  if #R.fixes > 400 then table.remove(R.fixes, 1) end
  R.here = f
  R.saveAcc = R.saveAcc + (dt or 0)
  if R.dirty and R.saveAcc > 15 then R.saveAcc = 0; M.save() end
  M.slopeTick(fix)
end

local function fixAt(t)
  local best
  for i = #R.fixes, 1, -1 do local f = R.fixes[i]; best = f; if f.t <= t then break end end
  return best or R.here
end

------------------------------------------------------------------------------------------------------------------
-- automatic boxes
local function nearestBox(lat, lon, filter)
  local best, bd
  for _, b in ipairs(R.ctx.boxes or {}) do
    if tonumber(b.lat) and tonumber(b.lon) and (not filter or filter(b)) then
      local dd = geo.dist(lat, lon, b.lat, b.lon)
      if not bd or dd < bd then best, bd = b, dd end
    end
  end
  return best, bd
end

function M.autoBox(kind, t, info)
  if not R then return end
  local f = fixAt(t)
  if not f then return end
  -- the same thing found twice (e.g. a long crest): keep the first, unless the new one is more dangerous
  for _, c in ipairs(R.doc.changes) do
    if c.op == 'add' and c.by == 'recce-auto' and c.box and c.box.features and c.box.features[1] and c.box.features[1].kind == kind
      and geo.dist(c.box.lat, c.box.lon, f.lat, f.lon) < M.T.dupM then
      if (info.danger or 0) > (c.box.danger or 0) then
        c.box.danger, c.box.notes, c.box.features = info.danger, info.notes, { info.feature }
        M.applyToDisplay(R.ctx.boxes, { op = 'update', id = c.id, by = 'recce-auto', fields = { danger = info.danger, notes = info.notes } })
        R.dirty = true
      end
      return nil
    end
  end
  R.seq = R.seq + 1
  local box = { km = r2(f.trip or 0, 3), drivenKm = r2(f.km, 3), lat = r2(f.lat, 7), lon = r2(f.lon, 7),
    symbols = { info.symbol }, danger = info.danger or 0, notes = info.notes, label = 'NOTE', features = { info.feature } }
  box.features[1].by = 'recce-auto'
  local sym = info.symbol
  local nb, nd = nearestBox(f.lat, f.lon, function(b) return not b.recce and contains(arr(b.symbols), sym) end)
  if nb and nd < M.T.sameAsBoxM then box.near = nb.id end
  local c = addChange({ op = 'add', id = 'rc-' .. os.time() .. '-' .. R.seq, by = 'recce-auto', box = box })
  R.lastEvent = { kind = kind, notes = info.notes, danger = info.danger, t = R.clock, n = nil }
  return c
end

-- one physics sample per game frame
function M.frame(dt, s)
  if not R or not s or not dt or dt <= 0 then return end
  local T, G = M.T, M.G
  -- proper acceleration (what an accelerometer in the car feels) along the car's up axis: d(velocity)/dt + gravity
  if R.prevVel then
    local ax, ay, az = (s.vx - R.prevVel[1]) / dt, (s.vy - R.prevVel[2]) / dt, (s.vz - R.prevVel[3]) / dt + G
    local aUp = ax * s.ux + ay * s.uy + az * s.uz
    local k = math.min(1, dt / 0.05)              -- ~50 ms smoothing: frame jitter out, a landing spike kept
    R.acc = R.acc and (R.acc + (aUp - R.acc) * k) or aUp
  end
  R.prevVel = { s.vx, s.vy, s.vz }
  if not R.acc then return end
  local t = R.clock
  local hspeed = math.sqrt(s.vx * s.vx + s.vy * s.vy)
  -- airtime -> jump
  local A = R.air
  if not A then
    if R.acc < T.airAccel and hspeed > 3 then
      R.airCand = (R.airCand or 0) + dt
      if R.airCand >= 0.08 then R.air = { t0 = t - R.airCand, x0 = s.x, y0 = s.y, z0 = s.z, zMax = s.z, time = R.airCand } end
    else R.airCand = 0 end
  else
    A.time = A.time + dt
    if s.z > A.zMax then A.zMax = s.z end
    if R.acc > T.airLand then
      local len = math.sqrt((s.x - A.x0) ^ 2 + (s.y - A.y0) ^ 2)
      R.air, R.airCand = nil, 0
      if A.time >= T.airMin then R.landedAt = t end    -- a real jump: its landing is not a compression
      if A.time >= T.airMin and len < 300 then
        local h, drop = A.zMax - A.z0, A.z0 - s.z
        local danger = (A.time >= 1.2 or len >= 30) and 3 or (A.time >= 0.7 or len >= 15) and 2 or 1
        local notes = string.format('JUMP, %.1f S AIR, %d M LONG', A.time, math.floor(len + 0.5))
        if drop > 1.5 then notes = notes .. string.format(', LANDS %d M LOWER', math.floor(drop + 0.5)) end
        M.autoBox('jump', A.t0, { symbol = 'jump', danger = danger, notes = notes,
          feature = { kind = 'jump', airtime = r2(A.time, 2), length = r2(len, 1), height = r2(h, 1), drop = r2(drop, 1) } })
      end
    end
  end
  -- hard compression (not the landing of a jump)
  if not R.air and t - R.landedAt > T.landGrace then
    local g = R.acc / G
    if g >= T.compressG then
      R.comp = R.comp or { t0 = t, peak = 0 }
      if g > R.comp.peak then R.comp.peak = g end
    elseif R.comp then
      local p = R.comp.peak
      local danger = p >= 4 and 3 or p >= 3 and 2 or 1
      M.autoBox('compression', R.comp.t0, { symbol = 'compression', danger = danger,
        notes = string.format('COMPRESSION, %.1f G', p), feature = { kind = 'compression', g = r2(p, 1) } })
      R.comp = nil
    end
  end
  -- pitch-over -> crest: nose up, then nose down within a few car lengths, at speed, on the ground
  local pitch = math.deg(math.asin(math.max(-1, math.min(1, s.dz))))
  local h = R.pitchHist
  local travelled = (h[#h] and h[#h].m or 0) + hspeed * dt
  if not R.air then h[#h + 1] = { t = t, p = pitch, m = travelled, v = hspeed } else R.pitchHist = {}; h = R.pitchHist end
  while #h > 0 and travelled - h[1].m > T.crestWithinM do table.remove(h, 1) end
  if #h > 2 and pitch <= -T.crestPitch and hspeed >= T.crestMinSpeed and t - (R.lastCrest or -99) > 3 then
    local maxUp, at = -90, nil
    for _, e in ipairs(h) do if e.p > maxUp then maxUp, at = e.p, e end end
    if maxUp >= T.crestPitch and at then
      R.lastCrest = t
      local change = maxUp - pitch
      local danger = (change >= 30 or hspeed > 25) and 2 or 1
      if change >= 40 then danger = 3 end
      M.autoBox('crest', at.t, { symbol = 'crest', danger = danger,
        notes = string.format('CREST, %d DEG OVER%s', math.floor(change + 0.5), danger >= 2 and ', BLIND' or ''),
        feature = { kind = 'crest', pitchChange = r2(change, 1), speed = r2(hspeed * 3.6, 0) } })
      R.pitchHist = {}
    end
  end
  -- wheel speed / throttle from the vehicle, four times a second
  R.askAcc = R.askAcc + dt
  if R.askAcc >= 0.25 then R.askAcc = 0; if M.askVehicle then M.askVehicle() end end
  -- soft sand: slow, throttle on, wheels spinning faster than the car moves
  local v = R.veh
  local sand = R.sand
  if v.wheel and t - v.t < 1 then
    local slip = (v.wheel - hspeed) / math.max(hspeed, 1)
    if hspeed * 3.6 < T.sandMaxKmh and (v.throttle or 0) >= T.sandThrottle and slip >= T.sandSlip and not R.air then
      sand.t = sand.t + dt; sand.start = sand.start or t; sand.minV = math.min(sand.minV or 99, hspeed)
      if sand.t >= T.sandTime and not sand.done then
        sand.done = true
        local bog = sand.minV * 3.6 < 8
        M.autoBox('soft_sand', sand.start, { symbol = 'soft_sand', danger = bog and 2 or 1,
          notes = bog and 'SOFT SAND, BOGGING' or 'SOFT SAND, WHEELSPIN', feature = { kind = 'soft_sand', slip = r2(slip, 2), minKmh = r2(sand.minV * 3.6, 0) } })
      end
    elseif sand.start and t - sand.start > 8 then R.sand = { t = 0 } end
  end
  R.lastSample = s
end

-- the vehicle's answer (wheel speed m/s, throttle 0..1)
function M.vehData(wheel, throttle)
  if not R then return end
  R.veh = { wheel = tonumber(wheel), throttle = tonumber(throttle), t = R.clock }
end

-- terrain grade along and across the car, every tick: from ground probes around the car if the game answers them,
-- else from the car's own attitude (pitch / roll follow the ground when the wheels are on it)
function M.slopeTick(fix)
  local s = R.lastSample
  if not s or R.air then return end
  local hd = math.sqrt(s.dx * s.dx + s.dy * s.dy)
  if hd < 0.1 then return end
  local fx, fy = s.dx / hd, s.dy / hd                  -- forward on the ground
  local rx, ry = fy, -fx                                -- right
  local grade, side
  local P = M.probe
  if P then
    local a, b = P(s.x + fx * 8, s.y + fy * 8, s.z), P(s.x - fx * 8, s.y - fy * 8, s.z)
    local l, r = P(s.x - rx * 4, s.y - ry * 4, s.z), P(s.x + rx * 4, s.y + ry * 4, s.z)
    if a and b then grade = (a - b) / 16 end
    if l and r then side = (r - l) / 8 end             -- > 0: ground rises to the right (falls to the left)
  end
  if not grade then grade = s.dz / math.max(0.1, math.sqrt(1 - s.dz * s.dz)) end
  if not side then
    -- right-axis z component: right = forward x up
    local rz = s.dx * s.uy - s.dy * s.ux
    side = rz / math.max(0.1, math.sqrt(1 - rz * rz))  -- right side up = ground rises to the right
  end
  local f = R.here
  local T = M.T
  -- along: climbs and descents
  local dir = (grade >= T.slopeGrade and 1) or (grade <= -T.slopeGrade and -1) or 0
  local sl = R.slope
  if sl and (dir ~= sl.dir) then
    if sl.km2 - sl.km1 >= T.slopeLen / 1000 then
      local kind = sl.dir > 0 and 'climb' or 'descent'
      local g = math.floor(sl.max * 100 + 0.5)
      local len = math.floor((sl.km2 - sl.km1) * 1000 + 0.5)
      M.autoBox(kind, sl.t, { symbol = kind, danger = g >= 45 and 3 or g >= 35 and 2 or 1,
        notes = string.format('%s %d%%, %d M', sl.dir > 0 and 'STEEP CLIMB' or 'STEEP DESCENT', g, len),
        feature = { kind = kind, grade = g, len = len, measured = P and 'probe' or 'attitude' } })
    end
    sl = nil
  end
  if dir ~= 0 then
    sl = sl or { dir = dir, t = R.clock, km1 = f.km, max = 0 }
    sl.km2 = f.km; sl.max = math.max(sl.max, math.abs(grade))
  end
  R.slope = sl
  -- across: side slopes
  local sdir = (side >= T.sideGrade and 1) or (side <= -T.sideGrade and -1) or 0
  local ss = R.side
  if ss and sdir ~= ss.dir then
    if ss.km2 - ss.km1 >= T.sideLen / 1000 then
      local deg = math.floor(math.deg(math.atan(ss.max)) + 0.5)
      local len = math.floor((ss.km2 - ss.km1) * 1000 + 0.5)
      local falls = ss.dir > 0 and 'LEFT' or 'RIGHT'
      M.autoBox('sideslope', ss.t, { symbol = ss.dir > 0 and 'sideslope_l' or 'sideslope_r', danger = deg >= 25 and 2 or 1,
        notes = string.format('SIDE SLOPE, FALLS %s, %d DEG, %d M', falls, deg, len),
        feature = { kind = 'sideslope', deg = deg, len = len, falls = falls:lower() } })
    end
    ss = nil
  end
  if sdir ~= 0 then
    ss = ss or { dir = sdir, t = R.clock, km1 = f.km, max = 0 }
    ss.km2 = f.km; ss.max = math.max(ss.max, math.abs(side))
  end
  R.side = ss
end

------------------------------------------------------------------------------------------------------------------
-- the driver's own boxes and edits
-- the nearest roadbook box (within NEAR_M), for confirm / move here / retag / delete
function M.nearest()
  if not R or not R.here then return nil end
  local b, d = nearestBox(R.here.lat, R.here.lon)
  if b and d <= M.NEAR_M then return b, d end
end

-- drop a box here: opens the quick-pick (symbol / danger / notes); M.commitPending saves it
function M.drop()
  if not R or not R.here then return nil end
  M.commitPending()
  local f = R.here
  R.pending = { mode = 'add', lat = f.lat, lon = f.lon, km = f.trip, drivenKm = f.km, symbols = {}, danger = 0, notes = '' }
  return R.pending
end
-- retag the nearest box: the quick-pick filled with its symbols / danger / notes
function M.retag(id)
  if not R then return nil end
  local b
  if id then for _, x in ipairs(R.ctx.boxes) do if x.id == id then b = x end end else b = M.target() end
  if not b then return nil end
  M.commitPending()
  R.pending = { mode = 'update', id = b.id, baseRev = tonumber(b.rev) or 1, symbols = copy(arr(b.symbols)), danger = tonumber(b.danger) or 0, notes = b.notes or '' }
  return R.pending
end
-- quick-pick input: {symbol = code (toggles)} / {danger = 0..3} / {notes = text}
function M.pick(p)
  local P = R and R.pending
  if not P or type(p) ~= 'table' then return P end
  if p.symbol then
    local found
    for i, s in ipairs(P.symbols) do if s == p.symbol then table.remove(P.symbols, i); found = true; break end end
    if not found then P.symbols[#P.symbols + 1] = p.symbol end
  end
  if p.danger then P.danger = math.max(0, math.min(3, tonumber(p.danger) or 0)) end
  if p.notes then P.notes = upper(p.notes):sub(1, M.NOTES_MAX) end
  if p.preset then                      -- a note preset toggles in the notes ("ROUGH, KEEP LEFT")
    local w = upper(p.preset)
    local parts, found = {}, false
    for part in tostring(P.notes or ''):gmatch('[^,]+') do
      part = part:gsub('^%s+', ''):gsub('%s+$', '')
      if part == w then found = true elseif part ~= '' then parts[#parts + 1] = part end
    end
    if not found then parts[#parts + 1] = w end
    P.notes = table.concat(parts, ', '):sub(1, M.NOTES_MAX)
  end
  return P
end
function M.cancelPending() if R then R.pending = nil end end
function M.commitPending()
  local P = R and R.pending
  if not P then return nil end
  R.pending = nil
  if P.mode == 'add' then
    R.seq = R.seq + 1
    local notes = P.notes ~= '' and P.notes or nil
    return addChange({ op = 'add', id = 'rc-' .. os.time() .. '-' .. R.seq, by = 'recce-manual',
      box = { km = r2(P.km or 0, 3), drivenKm = r2(P.drivenKm or 0, 3), lat = r2(P.lat, 7), lon = r2(P.lon, 7),
        symbols = P.symbols, danger = P.danger, notes = notes or '', label = 'NOTE' } })
  else
    return addChange({ op = 'update', id = P.id, baseRev = P.baseRev, by = 'recce-manual',
      fields = { symbols = P.symbols, danger = P.danger, notes = P.notes } })
  end
end
-- confirm / moveHere / delete the nearest box (or the box with this id)
function M.boxOp(op, id)
  if not R then return nil end
  local b
  if id then for _, x in ipairs(R.ctx.boxes) do if x.id == id then b = x end end else b = M.target() end
  if not b then return nil end
  local base = tonumber(b.rev) or 1
  if op == 'confirm' then return addChange({ op = 'confirm', id = b.id, baseRev = base, by = 'recce-manual' })
  elseif op == 'delete' then return addChange({ op = 'delete', id = b.id, baseRev = base, by = 'recce-manual' })
  elseif op == 'move' then
    local f = R.here
    return addChange({ op = 'move', id = b.id, baseRev = base, by = 'recce-manual', lat = r2(f.lat, 7), lon = r2(f.lon, 7), km = r2(f.trip or b.km, 3), drivenKm = r2(f.km, 3) })
  end
end

------------------------------------------------------------------------------------------------------------------
-- fixing an existing roadbook while driving it (17 Nov): pick any box, set its km from the trip meter, its CAP from
-- the car, the list of changes (undo any one), a merge preview and a report file
local function boxById(id) if not R then return nil end for _, x in ipairs(R.ctx.boxes) do if x.id == id then return x end end end
-- the box the recce buttons act on: the selected one (R.sel), else the nearest within NEAR_M
function M.target()
  if not R then return nil end
  if R.sel then local b = boxById(R.sel); if b then return b, 'selected' end; R.sel = nil end
  local b = M.nearest()
  if b then return b, 'nearest' end
end
-- how: 'next' / 'prev' (step through the boxes), 'trip' (the box the trip meter is in), 'nearest' (back to the
-- nearest box), or a box id. Returns the box and its index.
function M.select(how, tripKm)
  if not R then return nil end
  local boxes = R.ctx.boxes
  if #boxes == 0 then return nil end
  if how == 'nearest' or how == 'clear' then R.sel = nil; return nil end
  local cur = M.target()
  local idx
  if cur then for i, b in ipairs(boxes) do if b.id == cur.id then idx = i end end end
  if how == 'next' then idx = idx and math.min(#boxes, idx + 1) or 1
  elseif how == 'prev' then idx = idx and math.max(1, idx - 1) or 1
  elseif how == 'trip' then
    local t = tonumber(tripKm) or (R.here and R.here.trip) or 0
    idx = 1
    for i, b in ipairs(boxes) do if (tonumber(b.km) or 0) <= t + 1e-6 then idx = i end end
  else
    idx = nil
    for i, b in ipairs(boxes) do if b.id == how then idx = i end end
  end
  if not idx then return nil end
  R.sel = boxes[idx].id
  return boxes[idx], idx
end
-- the target box's km: how = 'trip' (the trip meter now) or a nudge in metres ('+10', '-10'). The partial distances
-- after it follow (renumber). Repeated edits of the same box make one change (its first km is kept as oldKm).
function M.setKm(how, id)
  if not R then return nil, 'recce is off' end
  local b = id and boxById(id) or M.target()
  if not b then return nil, 'no box selected or within ' .. M.NEAR_M .. ' m' end
  local km
  if how == 'trip' then
    if not (R.here and tonumber(R.here.trip)) then return nil, 'no trip meter reading yet' end
    km = R.here.trip
  else
    local dm = tonumber(how)
    if not dm then return nil, 'bad km nudge ' .. tostring(how) end
    km = (tonumber(b.km) or 0) + dm / 1000
  end
  km = math.max(0, r2(km, 3))
  local old = r2(tonumber(b.km) or 0, 3)
  R.sel = b.id
  local ch = R.doc.changes
  local last = ch[#ch]
  if last and last.op == 'move' and last.kmOnly and last.id == b.id and #ch > (R.sessionFrom or 0) then
    last.km, last.at = km, now()
    b.km = km; renumber(R.ctx.boxes)
    R.dirty, R.preview = true, nil
    M.save()
    return last, b, old
  end
  return addChange({ op = 'move', id = b.id, baseRev = tonumber(b.rev) or 1, by = 'recce-manual', km = km, oldKm = old, kmOnly = true }), b, old
end
-- the target box's CAP (heading out of the box) := the car's heading now
function M.setCap(id)
  if not R then return nil, 'recce is off' end
  local b = id and boxById(id) or M.target()
  if not b then return nil, 'no box selected or within ' .. M.NEAR_M .. ' m' end
  local h = R.here and tonumber(R.here.heading)
  if not h then return nil, 'no heading from the car yet' end
  local cap = math.floor(h % 360 + 0.5) % 360
  R.sel = b.id
  return addChange({ op = 'update', id = b.id, baseRev = tonumber(b.rev) or 1, by = 'recce-manual', fields = { cap = cap, capOut = cap }, oldCap = tonumber(b.cap) }), b
end

local OPNAME = { add = 'ADD', move = 'MOVE', update = 'TAG', confirm = 'OK', delete = 'DEL' }
local function describe(c)
  local kind = (c.by == 'recce-auto' and 'AUTO') or (c.op == 'move' and c.kmOnly and 'KM') or
    (c.op == 'update' and c.fields and c.fields.cap ~= nil and c.fields.symbols == nil and 'CAP') or OPNAME[c.op] or upper(c.op)
  local text = ''
  if c.op == 'add' then local bx = c.box or {}; text = (bx.notes and bx.notes ~= '') and bx.notes or table.concat(arr(bx.symbols), ' ')
  elseif kind == 'KM' then text = string.format('%.2f > %.2f KM', tonumber(c.oldKm) or 0, tonumber(c.km) or 0)
  elseif kind == 'CAP' then text = 'CAP ' .. tostring(c.fields.cap) .. (c.oldCap and (' (WAS ' .. c.oldCap .. ')') or '')
  elseif c.op == 'update' then local f = c.fields or {}; text = (f.notes and f.notes ~= '') and f.notes or table.concat(arr(f.symbols), ' ')
  elseif c.op == 'move' then text = 'MOVED TO THE CAR' .. (c.km and string.format(' (%.2f KM)', c.km) or '') end
  return kind, text
end
-- the changes, newest first (at most max): {i, kind, n, km, text, earlier}
function M.changeList(max)
  if not R then return {} end
  local out, ch = {}, R.doc.changes
  for i = #ch, math.max(1, #ch - (max or 40) + 1), -1 do
    local c = ch[i]
    local b = boxById(c.id)
    local kind, text = describe(c)
    out[#out + 1] = { i = i, kind = kind, n = b and b.n or nil, km = b and r2(tonumber(b.km) or 0, 2) or (c.box and r2(tonumber(c.box.km) or 0, 2)) or nil,
      text = tostring(text):sub(1, 40), earlier = (i <= (R.sessionFrom or 0)) or nil, gone = (not b) or nil }
  end
  return out
end

-- what a merge would do, without writing anything: the changes applied to a copy of the roadbook file
function M.preview(rbPath)
  if not R then return nil, 'recce is off' end
  if not rbPath then return nil, 'this stage has no roadbook file (make one in the stage builder first)' end
  local rb = readJson(rbPath)
  if not rb or rb.format ~= 'rallyraid-roadbook' then return nil, 'cannot read ' .. tostring(rbPath) end
  if #R.doc.changes == 0 then return nil, 'nothing to merge' end
  local applied, conflicts = M.applyChanges(copy(rb), copy(R.doc.changes))
  local why = {}
  for k = 1, math.min(3, #conflicts) do local x = conflicts[k]; why[#why + 1] = tostring(x.change and x.change.op) .. ' ' .. tostring(x.change and x.change.id) .. ': ' .. tostring(x.reason) end
  R.preview = { applied = applied, conflicts = #conflicts, why = why, changes = #R.doc.changes, revision = rb.revision, file = rbPath }
  return R.preview
end
function M.previewCancel() if R then R.preview = nil end end

-- the recce report: what changed, as JSON and plain text next to the recce file (/rallyraid/recce/<stage>.report.*)
function M.reportPaths(stageId) local b = M.DIR .. tostring(stageId) .. '.report'; return b .. '.json', b .. '.txt' end
function M.report(reason)
  if not R then return nil, 'recce is off' end
  local d, boxes = R.doc, R.ctx.boxes
  local counts, list = {}, {}
  for i, c in ipairs(d.changes) do
    local kind, text = describe(c)
    counts[kind] = (counts[kind] or 0) + 1
    local b = boxById(c.id)
    list[#list + 1] = { i = i, kind = kind, id = c.id, n = b and b.n or nil, km = b and r2(tonumber(b.km) or 0, 3) or nil, text = text, at = c.at, by = c.by,
      earlier = (i <= (R.sessionFrom or 0)) or nil }
  end
  local unverified = 0
  for _, b in ipairs(boxes) do if b.recce == 'recce-auto' and not b.verified then unverified = unverified + 1 end end
  local lastKm = boxes[#boxes] and r2(tonumber(boxes[#boxes].km) or 0, 3) or nil
  local rep = { format = 'rallyraid-recce-report', schemaVersion = 1, created = now(), reason = reason, stage = d.stage,
    roadbook = d.roadbook, recceFile = R.file, drivenKm = r2(R.km / 1000, 3), lastBoxKm = lastKm, boxes = #boxes,
    changes = #d.changes, thisSession = #d.changes - (R.sessionFrom or 0), counts = counts, unverifiedAuto = unverified,
    merged = d.mergedInto, list = list }
  local L = {}
  L[#L + 1] = 'rally.raid Earth recce report  ' .. rep.created .. (reason and ('  (' .. reason .. ')') or '')
  L[#L + 1] = 'Stage: ' .. tostring(d.stage and d.stage.name or '?') .. ' (' .. tostring(d.stage and d.stage.id) .. ')'
  L[#L + 1] = 'Roadbook: ' .. tostring(d.roadbook and d.roadbook.file or 'none') .. ', revision ' .. tostring(d.roadbook and d.roadbook.revision or '?')
  L[#L + 1] = string.format('Driven: %.2f km   last box at %s km   boxes %d', rep.drivenKm, lastKm and string.format('%.2f', lastKm) or '-', #boxes)
  local ks = {} for k in pairs(counts) do ks[#ks + 1] = k end table.sort(ks)
  local cs = {} for _, k in ipairs(ks) do cs[#cs + 1] = k .. ' ' .. counts[k] end
  L[#L + 1] = string.format('Changes not merged yet: %d (%d this session)%s', #d.changes, rep.thisSession, #cs > 0 and ('  [' .. table.concat(cs, ', ') .. ']') or '')
  L[#L + 1] = 'Automatic boxes still to check: ' .. unverified
  if d.mergedInto then L[#L + 1] = 'Last merge: revision ' .. tostring(d.mergedInto.revision) .. ', ' .. tostring(d.mergedInto.applied) .. ' applied, ' .. tostring(d.mergedInto.conflicts) .. ' conflicts' end
  L[#L + 1] = ''
  for _, x in ipairs(list) do
    L[#L + 1] = string.format('%3d  %-4s box %-4s %8s km  %s%s', x.i, x.kind, x.n and tostring(x.n) or '-', x.km and string.format('%.2f', x.km) or '-', tostring(x.text), x.earlier and '  (earlier recce)' or '')
  end
  local text = table.concat(L, '\n') .. '\n'
  local pj, pt = M.reportPaths(d.stage and d.stage.id)
  local okJ = writeJson(pj, rep)
  local wf = rawget(_G, 'writeFile')
  local okT = false
  if wf then local ok, r = pcall(wf, pt, text); okT = ok and r ~= false end
  R.lastReport = { json = okJ and pj or nil, txt = okT and pt or nil, changes = #d.changes, at = now() }
  if not (okJ or okT) then return nil, 'the report could not be written to ' .. pj end
  return R.lastReport, rep, text
end

------------------------------------------------------------------------------------------------------------------
-- what the roadbook app shows
function M.state()
  if not R then return nil end
  local nb, nd = M.nearest()
  local d = R.doc
  local counts = { auto = 0, manual = 0 }
  for _, c in ipairs(d.changes) do if c.by == 'recce-auto' then counts.auto = counts.auto + 1 else counts.manual = counts.manual + 1 end end
  local P = R.pending
  local tb, thow = M.target()
  return { on = true, km = r2(R.km / 1000, 2), points = #d.driven.points, changes = #d.changes, auto = counts.auto,
    manual = counts.manual, applied = #d.applied, file = R.file, unsaved = R.dirty or nil,
    airborne = R.air and true or nil,
    nearest = nb and { id = nb.id, n = nb.n, d = math.floor(nd + 0.5), notes = nb.notes, symbols = nb.symbols, danger = nb.danger, verified = nb.verified, recce = nb.recce } or nil,
    pending = P and { mode = P.mode, id = P.id, symbols = P.symbols, danger = P.danger, notes = P.notes } or nil,
    last = R.lastEvent and (R.clock - R.lastEvent.t < 8) and R.lastEvent or nil,
    quick = M.QUICK, presets = M.PRESETS,
    target = tb and { id = tb.id, n = tb.n, km = r2(tonumber(tb.km) or 0, 2), how = thow, notes = tb.notes, verified = tb.verified, cap = tb.cap,
      d = (R.here and tb.lat and tb.lon) and math.floor(geo.dist(R.here.lat, R.here.lon, tb.lat, tb.lon) + 0.5) or nil } or nil,
    list = M.changeList(40), session = #d.changes - (R.sessionFrom or 0), preview = R.preview, report = R.lastReport }
end

------------------------------------------------------------------------------------------------------------------
-- merging into the roadbook file (the same rules as RoadbookGen.applyChanges in the stage builder)
function M.applyChanges(rb, changes)
  rb.boxes = arr(rb.boxes); rb.conflicts = arr(rb.conflicts)
  local byId = {}
  for _, b in ipairs(rb.boxes) do byId[b.id] = b end
  local applied, conflicts = 0, {}
  for _, c in ipairs(changes) do
    local b = byId[c.id]
    local function hist(box, what)
      box.rev = (tonumber(box.rev) or 1) + 1
      local h = arr(box.history); h[#h + 1] = { rev = box.rev, at = c.at, by = c.by, change = what }; box.history = h
    end
    local function addSource(box)
      local s = arr(box.sources); if #s == 0 and box.source then s = { box.source } end
      if not contains(s, c.by) then s[#s + 1] = c.by end
      box.sources = s
    end
    if c.op == 'add' then
      if b then conflicts[#conflicts + 1] = { change = c, reason = 'id exists' }
      else
        local nb = { symbols = {}, danger = 0, notes = '', features = {}, label = 'NOTE' }
        for k, v in pairs(copy(c.box or {})) do nb[k] = v end
        nb.id, nb.source, nb.sources = c.id, c.by, { c.by }
        nb.verified = c.by ~= 'recce-auto'; nb.pinned = c.by == 'recce-manual' or c.by == 'editor'
        nb.rev = 1; nb.history = { { rev = 1, at = c.at, by = c.by, change = 'added' } }
        rb.boxes[#rb.boxes + 1] = nb; byId[nb.id] = nb; applied = applied + 1
      end
    elseif not b then conflicts[#conflicts + 1] = { change = c, reason = 'no such box' }
    elseif c.baseRev and (tonumber(b.rev) or 1) > c.baseRev and b.pinned and (b.source == 'editor' or contains(arr(b.sources), 'editor')) and c.by ~= 'editor' then
      conflicts[#conflicts + 1] = { change = c, reason = 'box changed in the editor since rev ' .. tostring(c.baseRev) }
    else
      local ok = true
      if c.op == 'confirm' then b.verified = true; hist(b, 'confirmed')
      elseif c.op == 'delete' then b.deleted = true; b.pinned = true; hist(b, 'deleted')
      elseif c.op == 'move' then for _, k in ipairs({ 'lat', 'lon', 'km' }) do if c[k] ~= nil then b[k] = c[k] end end; b.verified = true; b.pinned = true; hist(b, 'moved')
      elseif c.op == 'update' then
        local keys = {}
        for k, v in pairs(c.fields or {}) do b[k] = copy(v); keys[#keys + 1] = k end
        table.sort(keys)
        b.verified = c.by ~= 'recce-auto' or b.verified; b.pinned = true; hist(b, 'updated ' .. table.concat(keys, ','))
      else ok = false; conflicts[#conflicts + 1] = { change = c, reason = 'unknown op' } end
      if ok then addSource(b); applied = applied + 1 end
    end
  end
  for _, x in ipairs(conflicts) do rb.conflicts[#rb.conflicts + 1] = x end
  rb.revision = (tonumber(rb.revision) or 1) + 1
  -- re-sort live boxes by km, deleted ones (tombstones) after, renumber
  local live, dead = {}, {}
  for _, b in ipairs(rb.boxes) do if b.deleted then dead[#dead + 1] = b else live[#live + 1] = b end end
  renumber(live)
  for _, b in ipairs(dead) do live[#live + 1] = b end
  rb.boxes = live
  return applied, conflicts
end

-- re-measure the roadbook's km from the driven line: every box near the line gets the distance driven to it (counted
-- from the first box on the line, which keeps its km); boxes off the line are spaced in proportion between those.
-- Distances in the roadbook then match what the trip meter showed on the recce drive.
function M.rescale(rb, driven, maxOffM)
  maxOffM = maxOffM or 60
  local pts = arr(driven and driven.points)
  if #pts < 2 then return 0 end
  local breaks = {}
  for _, b in ipairs(arr(driven.breaks)) do breaks[tonumber(b)] = true end
  local lat0 = math.rad(tonumber(pts[1][1]) or 0)
  local kx, ky = 111320 * math.cos(lat0), 110540
  local function onLine(lat, lon)
    local best, bd = nil, maxOffM
    local px, py = lon * kx, lat * ky
    for i = 2, #pts do
      if not breaks[i] then
        local a, b = pts[i - 1], pts[i]
        local ax, ay, bx, by = a[2] * kx, a[1] * ky, b[2] * kx, b[1] * ky
        local vx, vy = bx - ax, by - ay
        local L = vx * vx + vy * vy
        local u = L > 0 and math.max(0, math.min(1, ((px - ax) * vx + (py - ay) * vy) / L)) or 0
        local dx, dy = ax + vx * u - px, ay + vy * u - py
        local d = math.sqrt(dx * dx + dy * dy)
        if d < bd then bd = d; best = a[3] + (b[3] - a[3]) * u end
      end
    end
    return best
  end
  local live = {}
  for _, b in ipairs(arr(rb.boxes)) do if not b.deleted and tonumber(b.km) then live[#live + 1] = b end end
  table.sort(live, function(a, b) return a.km < b.km end)
  local m = {}
  local last = -1
  for i, b in ipairs(live) do
    if tonumber(b.lat) and tonumber(b.lon) then
      local k = onLine(b.lat, b.lon)
      if k and k >= last then m[i] = k; last = k end
    end
  end
  local first
  for i = 1, #live do if m[i] then first = i break end end
  if not first then return 0 end
  local base, off = live[first].km, m[first]
  local newKm, n = {}, 0
  for i = 1, #live do if m[i] then newKm[i] = base + (m[i] - off); n = n + 1 end end
  -- in between: proportional on the old km; before the first / after the last matched box: shifted
  local prev
  for i = 1, #live do
    if newKm[i] then prev = i
    else
      local nxt
      for j = i + 1, #live do if newKm[j] then nxt = j break end end
      if prev and nxt then
        local span = live[nxt].km - live[prev].km
        local u = span > 0 and (live[i].km - live[prev].km) / span or 0
        newKm[i] = newKm[prev] + (newKm[nxt] - newKm[prev]) * u
      elseif prev then newKm[i] = newKm[prev] + (live[i].km - live[prev].km)
      else newKm[i] = live[i].km end
    end
  end
  for i, b in ipairs(live) do
    local k = r2(newKm[i], 3)
    if math.abs(k - b.km) >= 0.001 then
      local h = arr(b.history); h[#h + 1] = { rev = (tonumber(b.rev) or 1), at = now(), by = 'recce', change = string.format('km %.2f -> %.2f (driven line)', b.km, k) }; b.history = h
      b.km = k
    end
  end
  renumber(live)
  local dead = {}
  for _, b in ipairs(arr(rb.boxes)) do if b.deleted then dead[#dead + 1] = b end end
  for _, b in ipairs(dead) do live[#live + 1] = b end
  rb.boxes = live
  rb.recce = { drivenKm = driven.km, matched = n, at = now() }
  return n
end

-- merge this recce into the roadbook file: backup, apply, optionally rescale, write. Returns a summary or nil, why
function M.merge(rbPath, opts)
  if not R then return nil, 'recce is off' end
  if not rbPath then return nil, 'this stage has no roadbook file (make one in the stage builder first)' end
  local rb = readJson(rbPath)
  if not rb or rb.format ~= 'rallyraid-roadbook' then return nil, 'cannot read ' .. tostring(rbPath) end
  local d = R.doc
  if #d.changes == 0 and not (opts and opts.rescale) then return nil, 'nothing to merge' end
  local backup = M.DIR .. 'backup/' .. tostring(d.stage.id) .. '.rev' .. tostring(rb.revision or 1) .. '.roadbook.json'
  writeJson(backup, rb)
  local applied, conflicts = M.applyChanges(rb, d.changes)
  local rescaled = 0
  if opts and opts.rescale then d.driven.km = r2(R.km / 1000, 3); rescaled = M.rescale(rb, d.driven) end
  if not writeJson(rbPath, rb) then return nil, 'cannot write ' .. tostring(rbPath) end
  for _, c in ipairs(d.changes) do d.applied[#d.applied + 1] = c end
  d.changes = {}
  R.sessionFrom, R.preview, R.sel = 0, nil, nil
  d.mergedInto = { revision = rb.revision, at = now(), applied = applied, conflicts = #conflicts, rescaled = rescaled, backup = backup }
  d.roadbook.revision = rb.revision
  M.save()
  return { applied = applied, conflicts = conflicts, rescaled = rescaled, revision = rb.revision, backup = backup }
end

function M._reset() R = nil end
return M
