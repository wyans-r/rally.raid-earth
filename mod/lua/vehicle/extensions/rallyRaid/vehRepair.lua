-- rally.raid Earth: the vehicle half of the repair system (runs in the car's own Lua VM; the game names it
-- "rallyRaid_vehRepair"). Loaded on demand by the GE half (lua/ge/extensions/rallyRaid/repair.lua), which sends the
-- part-group table from repairConfig.lua with every call, so all tunables stay in one GE file.
--
-- Written from scratch for this mod with vanilla BeamNG calls only. The idea (not code) is the one described publicly
-- by the Individual Part Repair author: to fix only some parts, remember the whole car's damage, let the game reset
-- the car to new where it stands, then put the damage back on everything except the parts being fixed.
--
--   survey(cfg, reqId)          damage per repair group (and per corner for wheels / suspension), deflated tyres,
--                               engine damage flags -> GE rallyRaid_core.repairReply({kind='survey', ...})
--   prepare(cfg, spec, reqId)   remember the damage, then ask GE to reset the car in place
--                               -> GE rallyRaid_core.repairReply({kind='ready', ...})
--   onReset / updateGFX         put the remembered damage back on everything that is not being repaired
--                               -> GE rallyRaid_core.repairReply({kind='done', ...})
--
-- spec = { parts = { {group='wheel', corner='FL'}, {group='radiator'} } }   repair just these
--      | { allExcept = { 'engine' } }                                       repair everything but these groups
--      engine = true                                                        also cure the engine damage flags
--
-- Crash resume (B11, GE rallyRaid/resume.lua) uses the same machinery:
--   resumeSnapshot(cfg, id, keep)  every 30 s: remember the damage (damaged beams, their nodes in the car's own frame),
--                                  flat tyres, fuel and engine damage under id -> GE {kind='resumeSnap', ...}
--   resumeArm(cfg, id, reqId)      the next reset puts snapshot id back (no snapshot: the car as it is now)
--                                  -> GE {kind='resumeReady', ...}; after the reset -> GE {kind='resumeDone', ...}
--   (both now serve RECOVER CAR, the one reset allowed in a stage)
--
-- Game-crash resume (GE rallyRaid/gameResume.lua: the state saved to disk, the GAME crashed / was force-quit):
--   gameCapture(cfg, reqId)        the damage as plain arrays (JSON-safe, for the save file) + damage per group
--                                  -> GE {kind='gameCar', ...}
--   gameArm(cfg, car, reqId)       the next reset puts that saved damage back (beams / nodes not on this car are skipped)
--                                  -> GE {kind='gameReady', ...}; after the reset -> GE {kind='gameDone', ...}
local M = {}

local pending      -- the remembered car while a repair runs: { reqId, phase = 'reset' | 'apply', ... }
local waitFrames = 0

------------------------------------------------------------------------------------------------------------------
-- part names -> repair groups (pure: unit tested in tests/repair_test.lua)
local function matchesAny(name, list)
  for _, p in ipairs(list or {}) do if name:find(p) then return true end end
  return false
end
function M.classify(partName, cfg)
  local name = string.lower(tostring(partName or ''))
  for _, g in ipairs(cfg.groupOrder or {}) do
    local def = cfg.groups[g]
    if def and matchesAny(name, def.match) and not matchesAny(name, def.exclude) then return g end
  end
  return 'body'
end

local function xyz(p)
  if type(p) ~= 'table' and type(p) ~= 'userdata' then return nil end
  local x, y, z = tonumber(p.x), tonumber(p.y), tonumber(p.z)
  if x then return { x = x, y = y or 0, z = z or 0 } end
end

-- the wheels: name ('FL', 'RR', ...) and centre (between the hub nodes) in the car's original jbeam coordinates
function M.wheelCentres(vdata)
  local out = {}
  for k, w in pairs(vdata.wheels or {}) do
    local n1, n2 = vdata.nodes[w.node1], vdata.nodes[w.node2]
    local a, b = n1 and xyz(n1.pos), n2 and xyz(n2.pos)
    if a and b then
      out[#out + 1] = { key = k, name = tostring(w.name or ('W' .. tostring(k))), x = (a.x + b.x) / 2, y = (a.y + b.y) / 2 }
    end
  end
  table.sort(out, function(p, q) return p.name < q.name end)
  return out
end
local function nearestWheel(wc, p)
  local best, bd
  if not p then return nil end
  for _, w in ipairs(wc) do
    local d = (w.x - p.x) ^ 2 + (w.y - p.y) ^ 2
    if not bd or d < bd then best, bd = w.name, d end
  end
  return best
end

-- every node and beam: its group and (for perCorner groups) its corner
function M.layout(vdata, cfg)
  local wc = M.wheelCentres(vdata)
  local nodes, beams = {}, {}
  for _, n in pairs(vdata.nodes or {}) do
    if n.cid then
      local g = M.classify(n.partOrigin, cfg)
      local def = cfg.groups[g]
      nodes[n.cid] = { group = g, corner = (def and def.perCorner) and nearestWheel(wc, xyz(n.pos)) or nil }
    end
  end
  for _, b in pairs(vdata.beams or {}) do
    if b.cid then
      local g = M.classify(b.partOrigin, cfg)
      local def = cfg.groups[g]
      local corner
      if def and def.perCorner then
        local a, c = vdata.nodes[b.id1], vdata.nodes[b.id2]
        local pa, pc = a and xyz(a.pos), c and xyz(c.pos)
        if pa and pc then corner = nearestWheel(wc, { x = (pa.x + pc.x) / 2, y = (pa.y + pc.y) / 2 }) end
      end
      local len
      local a, c = vdata.nodes[b.id1], vdata.nodes[b.id2]
      local pa, pc = a and xyz(a.pos), c and xyz(c.pos)
      if pa and pc then len = math.sqrt((pa.x - pc.x) ^ 2 + (pa.y - pc.y) ^ 2 + (pa.z - pc.z) ^ 2) * (tonumber(b.beamPrecompression) or 1) end
      beams[b.cid] = { group = g, corner = corner, len = len, n1 = b.id1, n2 = b.id2, normal = (b.beamType == nil or b.beamType == rawget(_G, 'BEAM_NORMAL') or b.beamType == 0),
        deformGroup = b.deformGroup }
    end
  end
  return { wheels = wc, nodes = nodes, beams = beams }
end

-- is this node / beam part of the repair?
function M.selector(spec)
  local parts, keep = {}, {}
  for _, p in ipairs(spec.parts or {}) do parts[p.group .. '|' .. tostring(p.corner or '*')] = true; parts[p.group .. '|*all'] = parts[p.group .. '|*all'] or not p.corner end
  for _, g in ipairs(spec.allExcept or {}) do keep[g] = true end
  local all = spec.allExcept ~= nil
  return function(info)
    if not info then return false end
    if all then return not keep[info.group] end
    if parts[info.group .. '|*all'] then return true end
    return parts[info.group .. '|' .. tostring(info.corner or '*')] == true
  end
end

------------------------------------------------------------------------------------------------------------------
-- game access (the tests replace obj / v / wheels / beamstate / energyStorage / damageTracker / powertrain globals)
local function G(name) return rawget(_G, name) end
local function toGE(cmd) local o = G('obj'); if o and o.queueGameEngineLua then o:queueGameEngineLua(cmd) end end
local function ser(t) local s = G('serialize'); if s then return s(t) end return 'nil' end
local function reply(data) toGE('if rallyRaid_core then rallyRaid_core.repairReply(' .. ser(data) .. ') end') end

local function deflatedWheels()
  local out = {}
  local w = G('wheels')
  for k, wd in pairs(w and w.wheels or {}) do if wd.isTireDeflated then out[#out + 1] = { key = k, name = tostring(wd.name or k) } end end
  return out
end
local function engineFlags(cfg)
  local out = {}
  local dt = G('damageTracker')
  if not (dt and dt.getDamage) then return out end
  for _, f in ipairs(cfg.engineFlags or {}) do
    local ok, v = pcall(dt.getDamage, 'engine', f)
    if ok and v and v ~= 0 then out[#out + 1] = f end
  end
  return out
end
local function fuelLevels()
  local out = {}
  local es = G('energyStorage')
  if not (es and es.getStorages) then return out end
  local ok, st = pcall(es.getStorages)
  if not ok then return out end
  for name, s in pairs(st or {}) do if type(s) == 'table' and tonumber(s.remainingVolume) then out[name] = tonumber(s.remainingVolume) end end
  return out
end

-- damage per group: share of a group's beams that are broken or have changed rest length by more than the ratio
function M.measure(lay, cfg, o)
  o = o or G('obj')
  local acc = {}
  local function bucket(g, c)
    acc[g] = acc[g] or {}
    local k = c or '*'
    acc[g][k] = acc[g][k] or { beams = 0, damaged = 0, broken = 0 }
    return acc[g][k]
  end
  local ratio = tonumber(cfg.beamDamagedRatio) or 0.02
  for cid, b in pairs(lay.beams) do
    local t = bucket(b.group, b.corner)
    t.beams = t.beams + 1
    local broken = o:beamIsBroken(cid) and true or false
    local bad = broken
    if not bad and b.normal and b.len and b.len > 0.01 then
      local rl = tonumber(o:getBeamRestLength(cid))
      if rl and math.abs(rl / b.len - 1) > ratio then bad = true end
    end
    if bad then t.damaged = t.damaged + 1 end
    if broken then t.broken = t.broken + 1 end
  end
  local out = {}
  for g, byC in pairs(acc) do
    out[g] = {}
    for c, t in pairs(byC) do out[g][c] = { damage = t.beams > 0 and t.damaged / t.beams or 0, broken = t.broken, beams = t.beams } end
  end
  return out
end

------------------------------------------------------------------------------------------------------------------
function M.survey(cfg, reqId)
  local v, o = G('v'), G('obj')
  if not (v and v.data and o) then reply({ kind = 'survey', reqId = reqId, ok = false, why = 'no vehicle data' }) return end
  local lay = M.layout(v.data, cfg)
  local groups = M.measure(lay, cfg, o)
  local corners = {}
  for _, w in ipairs(lay.wheels) do corners[#corners + 1] = w.name end
  local defl = {}
  for _, d in ipairs(deflatedWheels()) do defl[#defl + 1] = d.name end
  local data = { kind = 'survey', reqId = reqId, ok = true, corners = corners, groups = groups, deflated = defl,
    engineFlags = engineFlags(cfg) }
  reply(data)
  return data
end

function M.prepare(cfg, spec, reqId)
  local v, o = G('v'), G('obj')
  if not (v and v.data and o) then reply({ kind = 'ready', reqId = reqId, ok = false, why = 'no vehicle data' }) return end
  local lay = M.layout(v.data, cfg)
  local fix = M.selector(spec)
  local P = { reqId = reqId, phase = 'reset', spec = spec, cfg = cfg, nodes = {}, beams = {}, deflated = {},
    fuel = fuelLevels(), engineFlags = engineFlags(cfg), before = M.measure(lay, cfg, o), lay = lay }
  for cid, info in pairs(lay.nodes) do
    if not fix(info) then
      local p = o:getNodePosition(cid)
      P.nodes[cid] = { p.x, p.y, p.z }
    end
  end
  for cid, info in pairs(lay.beams) do
    if not fix(info) then
      local broken = o:beamIsBroken(cid) and true or false
      local rl = tonumber(o:getBeamRestLength(cid))
      local dr = (info.normal and info.len and info.len > 0.01 and rl) and (rl / info.len - 1) or 0
      P.beams[cid] = { rl, broken, dr }
    end
  end
  -- a deflated tyre stays flat unless its wheel is changed
  local wheelFix = {}
  for _, w in ipairs(lay.wheels) do wheelFix[w.name] = fix({ group = 'wheel', corner = w.name }) end
  for _, d in ipairs(deflatedWheels()) do if not wheelFix[d.name] then P.deflated[#P.deflated + 1] = d.key end end
  pending, waitFrames = P, 0
  reply({ kind = 'ready', reqId = reqId, ok = true })
  return P
end

-- the car was just reset to new: put the damage back on everything that is not being repaired (next frame, after
-- the game's own modules have finished resetting)
function M.onReset()
  if pending and pending.phase == 'reset' then pending.phase = 'apply'; waitFrames = 1 end
end

function M.apply(o)
  local P = pending
  if not P then return nil end
  o = o or G('obj')
  local vec = G('vec3')
  local stats = { nodesKept = 0, beamsKept = 0, rebroken = 0, deformedReplayed = 0, tyresDeflated = 0 }
  local B = P.frame and M.basis(o)
  for cid, p in pairs(P.nodes) do
    if B then p = M.fromFrame(B, p) end          -- a resume state: kept in the car's frame (it faces a new way now)
    o:setNodePosition(cid, vec and vec(p[1], p[2], p[3]) or { x = p[1], y = p[2], z = p[3] })
    stats.nodesKept = stats.nodesKept + 1
  end
  local onDeformed = G('onBeamDeformed')
  local ratio = tonumber(P.cfg.beamDamagedRatio) or 0.02
  for cid, b in pairs(P.beams) do
    if b[1] then o:setBeamLength(cid, b[1]) end
    stats.beamsKept = stats.beamsKept + 1
    if b[2] then o:breakBeam(cid); stats.rebroken = stats.rebroken + 1
    elseif math.abs(b[3] or 0) > ratio and P.lay.beams[cid] and P.lay.beams[cid].deformGroup and onDeformed then
      -- deform groups drive mechanical damage (a dented radiator leaks): let the game see the dent again
      if pcall(onDeformed, cid, b[3]) then stats.deformedReplayed = stats.deformedReplayed + 1 end
    end
  end
  if o.commitLoad then o:commitLoad() end
  local bs = G('beamstate')
  for _, k in ipairs(P.deflated) do if bs and bs.deflateTire and pcall(bs.deflateTire, k) then stats.tyresDeflated = stats.tyresDeflated + 1 end end
  -- fuel: a reset fills the tank; give back what was left
  local es = G('energyStorage')
  if es and es.getStorages then
    local ok, st = pcall(es.getStorages)
    for name, vol in pairs(P.fuel) do
      local s = ok and st and st[name]
      if s and s.setRemainingVolume then pcall(s.setRemainingVolume, s, vol) end
    end
  end
  -- engine damage the repair does not cover: what we can put back, we put back; the rest is reported
  local notRestored = {}
  if not P.spec.engine then
    for _, f in ipairs(P.engineFlags) do
      local done = false
      if f == 'engineLockedUp' then
        local pt = G('powertrain')
        local ok, devs = pcall(function() return pt.getDevicesByCategory('engine') end)
        for _, d in pairs(ok and devs or {}) do if d.lockUp and pcall(d.lockUp, d) then done = true end end
      end
      if not done then notRestored[#notRestored + 1] = f end
    end
  end
  local after = M.measure(P.lay, P.cfg, o)
  pending = nil
  local out = { kind = P.replyKind or 'done', reqId = P.reqId, ok = true, stats = stats, before = P.before, after = after,
    engineFlagsBefore = P.engineFlags, engineFlagsNotRestored = notRestored, fuel = P.fuel }
  reply(out)
  return out
end

function M.updateGFX()
  if pending and pending.phase == 'apply' then
    if waitFrames > 0 then waitFrames = waitFrames - 1 return end
    local ok, err = pcall(M.apply)
    if not ok then local id, k = pending and pending.reqId, pending and pending.replyKind; pending = nil; reply({ kind = k or 'done', reqId = id, ok = false, why = tostring(err) }) end
  end
end

------------------------------------------------------------------------------------------------------------------
-- crash resume: resume states
-- the car's frame: forward, up and right unit vectors (world-aligned when the game does not say: tests, old versions)
local function unit(x, y, z) local l = math.sqrt(x * x + y * y + z * z); if l < 1e-9 then return nil end return x / l, y / l, z / l end
function M.basis(o)
  local fx, fy, fz, ux, uy, uz
  local okF, f = pcall(function() return o:getDirectionVector() end)
  local okU, u = pcall(function() return o:getDirectionVectorUp() end)
  if okF and f and okU and u then
    fx, fy, fz = unit(tonumber(f.x) or 0, tonumber(f.y) or 0, tonumber(f.z) or 0)
    ux, uy, uz = unit(tonumber(u.x) or 0, tonumber(u.y) or 0, tonumber(u.z) or 0)
  end
  if not (fx and ux) then fx, fy, fz, ux, uy, uz = 0, 1, 0, 0, 0, 1 end
  -- right = forward x up; up again = right x forward (square to each other)
  local rx, ry, rz = unit(fy * uz - fz * uy, fz * ux - fx * uz, fx * uy - fy * ux)
  if not rx then rx, ry, rz = 1, 0, 0 end
  ux, uy, uz = ry * fz - rz * fy, rz * fx - rx * fz, rx * fy - ry * fx
  return { f = { fx, fy, fz }, u = { ux, uy, uz }, r = { rx, ry, rz } }
end
function M.toFrame(B, p)
  local x, y, z = p[1] or p.x, p[2] or p.y, p[3] or p.z
  local function dot(v) return x * v[1] + y * v[2] + z * v[3] end
  return { dot(B.r), dot(B.f), dot(B.u) }
end
function M.fromFrame(B, q)
  local a, b, c = q[1], q[2], q[3]
  return { a * B.r[1] + b * B.f[1] + c * B.u[1], a * B.r[2] + b * B.f[2] + c * B.u[2], a * B.r[3] + b * B.f[3] + c * B.u[3] }
end

local saved = {}            -- resume states by id (the newest `keep`)
local layCache, layFor      -- the part layout of this car (worked out once: it does not change while driving)
local KEEP_RATIO = 0.001    -- a beam whose rest length moved more than 0.1 % is kept (an undamaged one is new after a reset)
local function cachedLayout(vdata, cfg)
  if layFor ~= vdata then layCache, layFor = M.layout(vdata, cfg), vdata end
  return layCache
end
-- the car's damage as it is now: damaged / broken beams, the nodes on them (in the car's frame), flat tyres, fuel,
-- engine damage
function M.capture(cfg)
  local v, o = G('v'), G('obj')
  if not (v and v.data and o) then return nil, 'no vehicle data' end
  local lay = cachedLayout(v.data, cfg)
  local B = M.basis(o)
  local Sn = { beams = {}, nodes = {}, deflated = {}, fuel = fuelLevels(), engineFlags = engineFlags(cfg), lay = lay,
    upright = B.u[3], nBeams = 0, nNodes = 0 }
  for cid, info in pairs(lay.beams) do
    local broken = o:beamIsBroken(cid) and true or false
    local rl = tonumber(o:getBeamRestLength(cid))
    local dr = (info.normal and info.len and info.len > 0.01 and rl) and (rl / info.len - 1) or 0
    if broken or math.abs(dr) > KEEP_RATIO then
      Sn.beams[cid] = { rl, broken, dr }
      Sn.nBeams = Sn.nBeams + 1
      for _, n in ipairs({ info.n1, info.n2 }) do
        if n ~= nil and lay.nodes[n] and not Sn.nodes[n] then
          local p = o:getNodePosition(n)
          Sn.nodes[n] = M.toFrame(B, { p.x, p.y, p.z })
          Sn.nNodes = Sn.nNodes + 1
        end
      end
    end
  end
  for _, d in ipairs(deflatedWheels()) do Sn.deflated[#Sn.deflated + 1] = d.key end
  return Sn
end
function M.resumeSnapshot(cfg, id, keep)
  local Sn, why = M.capture(cfg)
  if not Sn then reply({ kind = 'resumeSnap', id = id, ok = false, why = why }) return nil end
  Sn.id = id
  saved[id] = Sn
  keep = tonumber(keep) or 4
  for k in pairs(saved) do if k <= id - keep then saved[k] = nil end end
  local out = { kind = 'resumeSnap', id = id, ok = true, upright = Sn.upright, beams = Sn.nBeams, nodes = Sn.nNodes }
  reply(out)
  return out
end
local function arm(Sn, cfg, reqId, readyKind, doneKind, extra)
  pending = { reqId = reqId, phase = 'reset', spec = { parts = {} }, cfg = cfg, nodes = Sn.nodes, beams = Sn.beams,
    deflated = Sn.deflated, fuel = Sn.fuel or {}, engineFlags = Sn.engineFlags or {}, lay = Sn.lay, frame = true, replyKind = doneKind }
  waitFrames = 0
  local out = { kind = readyKind, reqId = reqId, ok = true }
  for k, x in pairs(extra or {}) do out[k] = x end
  reply(out)
  return out
end
function M.resumeArm(cfg, id, reqId)
  local Sn, from = saved[id], true
  if not Sn then
    local why
    Sn, why = M.capture(cfg)
    from = false
    if not Sn then reply({ kind = 'resumeReady', reqId = reqId, ok = false, why = why }) return nil end
  end
  return arm(Sn, cfg, reqId, 'resumeReady', 'resumeDone', { fromSnapshot = from })
end

-- damage per group: the worst corner of each group (0..1), for the save file's "damage summary"
function M.damageSummary(measured)
  local out = {}
  for g, byC in pairs(measured or {}) do
    local worst = 0
    for _, e in pairs(byC) do worst = math.max(worst, tonumber(e.damage) or 0) end
    out[g] = math.floor(worst * 1000 + 0.5) / 1000
  end
  return out
end

-- game-crash resume: the damage as JSON-safe arrays (beams { cid, restLength, broken 0/1, ratio }, nodes { cid, x, y, z }
-- in the car's frame), flat tyres, fuel, engine flags, damage per group
function M.gameCapture(cfg, reqId)
  local Sn, why = M.capture(cfg)
  if not Sn then reply({ kind = 'gameCar', reqId = reqId, ok = false, why = why }) return nil end
  local beams, nodes = {}, {}
  for cid, b in pairs(Sn.beams) do beams[#beams + 1] = { cid, b[1] or 0, b[2] and 1 or 0, b[3] or 0 } end
  for cid, q in pairs(Sn.nodes) do nodes[#nodes + 1] = { cid, q[1], q[2], q[3] } end
  table.sort(beams, function(a, b) return a[1] < b[1] end)
  table.sort(nodes, function(a, b) return a[1] < b[1] end)
  local ok, m = pcall(M.measure, Sn.lay, cfg, G('obj'))
  local out = { kind = 'gameCar', reqId = reqId, ok = true, beams = beams, nodes = nodes, deflated = Sn.deflated, fuel = Sn.fuel,
    engineFlags = Sn.engineFlags, upright = Sn.upright, nBeams = Sn.nBeams, nNodes = Sn.nNodes,
    damage = ok and M.damageSummary(m) or nil }
  reply(out)
  return out
end
-- put a saved car (gameCapture's arrays, read back from the save file) on the next reset
function M.gameArm(cfg, car, reqId)
  local v = G('v')
  if not (v and v.data) then reply({ kind = 'gameReady', reqId = reqId, ok = false, why = 'no vehicle data' }) return nil end
  local lay = cachedLayout(v.data, cfg)
  car = type(car) == 'table' and car or {}
  local Sn = { beams = {}, nodes = {}, deflated = {}, fuel = {}, engineFlags = {}, lay = lay }
  local skipped = 0
  for _, b in ipairs(car.beams or {}) do
    local cid = tonumber(b[1])
    if cid and lay.beams[cid] then Sn.beams[cid] = { tonumber(b[2]), (b[3] == 1 or b[3] == true), tonumber(b[4]) or 0 }
    else skipped = skipped + 1 end
  end
  for _, q in ipairs(car.nodes or {}) do
    local cid = tonumber(q[1])
    if cid and lay.nodes[cid] then Sn.nodes[cid] = { tonumber(q[2]) or 0, tonumber(q[3]) or 0, tonumber(q[4]) or 0 }
    else skipped = skipped + 1 end
  end
  for _, k in ipairs(car.deflated or {}) do Sn.deflated[#Sn.deflated + 1] = tonumber(k) or k end
  for name, vol in pairs(type(car.fuel) == 'table' and car.fuel or {}) do Sn.fuel[name] = tonumber(vol) end
  for _, f in ipairs(car.engineFlags or {}) do Sn.engineFlags[#Sn.engineFlags + 1] = f end
  return arm(Sn, cfg, reqId, 'gameReady', 'gameDone', { skipped = skipped })
end
function M._saved() return saved end

function M.cancel() pending = nil end
function M._pending() return pending end

return M
