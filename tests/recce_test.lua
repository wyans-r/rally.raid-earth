-- Recce mode (mod/lua/ge/extensions/rallyRaid/recce.lua) with simulated telemetry: a car driven 1.4 km east from the
-- Moab sample's DSS over a scripted terrain (a kicker jump, a dip, a crest, a climb and a descent, soft sand, a side
-- slope), 60 frames a second, plus the driver's own boxes and edits, saving, resuming, undo and the merge into the
-- roadbook file (with and without re-measured km). Run with tests/run_tests.py (LuaJIT through lupa).
local MOD = MOD_ROOT .. '/lua/ge/extensions/'
package.path = MOD .. '?.lua;' .. package.path
local car = { lat = 0, lon = 0, speed = 0, ve = 0, vn = 0, heading = 90 }
local ui, files, notes = {}, {}, {}
guihooks = { trigger = function(n, d) ui[n] = d end }
extensions = { hook = function() end }
log = function() end
jsonReadFile = function(p) if files[p] then return files[p] end return READ_JSON(p) end
jsonWriteFile = function(p, d) files[p] = d; return true end
FS = { findFiles = function(self, dir) return LIST_FILES(dir) end }
beamngEarth_api = { version = function() return 1, 8 end, ready = function() return true end, rebasing = function() return false end,
  pose = function() return { lat = car.lat, lon = car.lon, speed = car.speed, ve = car.ve, vn = car.vn, heading = car.heading, camera = false } end,
  notify = function(t) notes[#notes + 1] = t; return true end, teleport = function() return true end }
local geo = require('rallyRaid/geo')
local core = require('rallyRaid/core')
local recce = require('rallyRaid/recce')
local fails, passes = 0, 0
local function check(c, m) if c then passes = passes + 1 else fails = fails + 1; print('FAIL: ' .. m) end end

-- the terrain: slope (rise per metre along the drive) as smooth pieces, the ground height integrated from it --------
local function smooth(x, a, b) if x <= a then return 0 elseif x >= b then return 1 end local u = (x - a) / (b - a); return u * u * (3 - 2 * u) end
local function slopeAt(x)
  local s = 0
  s = s + 0.30 * smooth(x, 180, 200) * (x < 208 and 1 or 0)                  -- kicker: 20 m blend up to 30 %, ends at 208 m (drops away)
  if x >= 392 and x <= 408 then s = s + 0.5 * math.pi / 16 * -math.sin(2 * math.pi * (x - 392) / 16) end  -- dip 0.5 m deep, 16 m long
  s = s + 0.12 * (smooth(x, 555, 565) - smooth(x, 590, 610) - smooth(x, 590, 610) + smooth(x, 635, 645))   -- crest: +12 % then -12 %
  s = s + 0.30 * (smooth(x, 795, 805) - smooth(x, 895, 905))                -- climb 30 %, 100 m
  s = s - 0.30 * (smooth(x, 955, 965) - smooth(x, 995, 1005))               -- descent 30 %, 40 m
  return s
end
local DX = 0.05
local H = { [0] = 0 }
for i = 1, math.floor(1500 / DX) do local x = i * DX; H[i] = H[i - 1] + slopeAt(x - DX / 2) * DX end
local function ground(x) local i = math.max(0, math.min(#H - 1, math.floor(x / DX))); local u = x / DX - i; return (H[i] + (H[i + 1] - H[i]) * u) - (x >= 208 and 2.4 or 0) * 0 end
-- the kicker's lip: the ground under the ramp is raised, after 208 m it is back down (the car flies)
local LIP = ground(208)
local function groundAt(x) if x >= 208 then return ground(x) - LIP end return ground(x) end
local function rollAt(x) return x >= 1245 and x <= 1305 and 20 * smooth(x, 1245, 1250) * (1 - smooth(x, 1300, 1305)) or 0 end
local function speedAt(x)
  local function lerp(a, b, x0, x1) return a + (b - a) * smooth(x, x0, x1) end
  if x < 190 then return lerp(15, 20, 120, 170) elseif x < 480 then return 20 elseif x < 560 then return lerp(20, 15, 470, 540)
  elseif x < 700 then return 15 elseif x < 780 then return lerp(15, 8, 690, 770) elseif x < 1065 then return 8
  elseif x < 1100 then return lerp(8, 4, 1060, 1090) elseif x < 1165 then return 4 else return lerp(4, 8, 1160, 1200) end
end

-- the car ----------------------------------------------------------------------------------------------------------
local LAT0, LON0 = 38.567602, -109.531389          -- the DSS of moab-sand-flats-ss1
local KX = 111320 * math.cos(math.rad(LAT0))
local sim = { x = 0, z = 0, vz = 0, air = false, dir = { 1, 0, 0 }, airtime = 0 }
local function sample()
  local x, v = sim.x, speedAt(sim.x)
  local f = sim.dir
  local roll = math.rad(rollAt(x))
  -- right vector rolled up by `roll` (right side up), up = right x forward
  local rx, ry, rz = 0, -math.cos(roll), math.sin(roll)
  local ux, uy, uz = ry * f[3] - rz * f[2], rz * f[1] - rx * f[3], rx * f[2] - ry * f[1]
  local n = math.sqrt(ux * ux + uy * uy + uz * uz)
  return { x = x, y = 0, z = sim.z, vx = v, vy = 0, vz = sim.vz, dx = f[1], dy = f[2], dz = f[3], ux = ux / n, uy = uy / n, uz = uz / n }
end
recce.sampler = sample
recce.probe = nil                                   -- slopes from the car's attitude (the in-game probe is untested here)
recce.askVehicle = function() local v = speedAt(sim.x); local sand = sim.x > 1095 and sim.x < 1165; core.recceVeh(v * (sand and 2.2 or 1.02), (sim.x > 1095 and sim.x < 1165) and 0.8 or 0.3) end
local DT = 1 / 60
local function step()
  local v = speedAt(sim.x)
  local x1 = sim.x + v * DT
  if sim.air then
    sim.vz = sim.vz - 9.81 * DT
    sim.z = sim.z + sim.vz * DT
    sim.airtime = sim.airtime + DT
    if sim.z <= groundAt(x1) then sim.air = false; sim.z = groundAt(x1); sim.vz = 0 end
  else
    local z1 = groundAt(x1)
    if sim.x < 208 and x1 >= 208 then                -- off the lip
      sim.air = true; sim.vz = slopeAt(207.9) * v; sim.z = sim.z + sim.vz * DT
    else sim.vz = (z1 - sim.z) / DT; sim.z = z1 end
    local s = sim.air and sim.dir[3] / math.max(0.01, sim.dir[1]) or slopeAt(x1)
    local n = math.sqrt(1 + s * s); sim.dir = { 1 / n, 0, s / n }
  end
  sim.x = x1
  car.lat, car.lon, car.speed, car.ve, car.vn = LAT0, LON0 + sim.x / KX, v, v, 0
  core.onUpdate(DT, DT)
end
local function driveTo(x, each) while sim.x < x do step(); if each then each() end end end

-- load the stage, recce on -----------------------------------------------------------------------------------------
local list = core.listStages()
local moab
for _, s in ipairs(list) do if s.path:find('moab') then moab = s end end
core.loadStage(moab.path)
local S = core._debug()
car.lat, car.lon = LAT0, LON0
core.onUpdate(0.1, 0.1)
check(S.stage.roadbook.source ~= nil, 'moab roadbook loaded')
local boxes0 = #S.stage.roadbook.boxes
check(S.stage.roadbook.boxes[1].lat ~= nil and S.stage.roadbook.boxes[1].rev ~= nil, 'boxes carry lat / lon / rev for recce')
core.cmd('recceDrop')
check(notes[#notes]:find('recce is off'), 'recce commands need recce on')
core.cmd('recce')
check(recce.active() and notes[#notes]:find('RECCE ON'), 'recce on')
check(core.roadbookState().recce and core.roadbookState().recce.on, 'roadbook state carries the recce panel')

-- the driver's boxes: drop + quick-pick, confirm, retag, move, delete, undo
driveTo(50)
core.cmd('recceDrop')
check(core.roadbookState().recce.pending and core.roadbookState().recce.pending.mode == 'add', 'drop opens the quick-pick')
core.cmd('reccePick', { symbol = 'rocks' }); core.cmd('reccePick', { symbol = 'danger' }); core.cmd('reccePick', { symbol = 'danger' })
core.cmd('reccePick', { danger = 2 }); core.cmd('reccePick', { notes = 'big rocks left' })
core.cmd('recceSave')
local R = recce.get()
local c1 = R.doc.changes[1]
check(c1 and c1.op == 'add' and c1.by == 'recce-manual' and c1.box.notes == 'BIG ROCKS LEFT' and c1.box.danger == 2 and #c1.box.symbols == 1 and c1.box.symbols[1] == 'rocks', 'manual box: symbol toggles, danger, notes in capitals')
check(math.abs(geo.dist(c1.box.lat, c1.box.lon, LAT0, LON0 + 50 / KX)) < 3 and math.abs(c1.box.km - core.roadbookState().trip) < 0.01, 'manual box at the car (lat / lon) and the trip km')
check(#S.stage.roadbook.boxes == boxes0 + 1, 'new box shows on the roadbook display at once')
local nb = recce.nearest()
check(nb and nb.id == c1.id, 'nearest box is the one just dropped')
core.cmd('recceDrop'); core.cmd('recceDrop')            -- a second press saves the plain box
check(#R.doc.changes == 2 and R.doc.changes[2].box.symbols and #R.doc.changes[2].box.symbols == 0, 'second press saves a plain box')
core.cmd('recceUndo')
check(#R.doc.changes == 1 and #S.stage.roadbook.boxes == boxes0 + 1, 'undo takes the last change back (display rebuilt)')
-- edits on the real roadbook boxes near the start
local before = {}
for _, b in ipairs(S.stage.roadbook.boxes) do before[b.id] = b end
-- the first three generated boxes of the moab roadbook (ids depend on the generator version)
local autoIds = {}
for _, b in ipairs(S.stage.roadbook.boxes) do if not b.waypoint and not b.pinned and b.id:match('^rb%-') and b.source ~= 'recce-manual' then autoIds[#autoIds + 1] = b.id end end
local J16, J32, J44 = autoIds[1], autoIds[2], autoIds[3]
check(J16 and J32 and J44, 'moab roadbook has generated boxes to work on')
core.cmd('recceConfirm', J16)
check(R.doc.changes[2].op == 'confirm' and R.doc.changes[2].baseRev == 1 and before[J16].verified, 'confirm (baseRev = box rev)')
core.cmd('recceRetag', J16)
core.cmd('reccePick', { symbol = 'keep_left' }); core.cmd('reccePick', { danger = 1 })
core.cmd('recceSave')
local cu = R.doc.changes[3]
check(cu.op == 'update' and cu.baseRev == 2 and cu.fields.danger == 1 and #cu.fields.symbols >= 1, 'retag: update with the box\'s current rev (2 after the confirm)')
core.cmd('recceMove', J32)
local cm = R.doc.changes[4]
check(cm.op == 'move' and math.abs(geo.dist(cm.lat, cm.lon, car.lat, car.lon)) < 1, 'move here: the car\'s position')
core.cmd('recceDelete', J44)
local gone = true
for _, b in ipairs(S.stage.roadbook.boxes) do if b.id == J44 then gone = false end end
check(R.doc.changes[5].op == 'delete' and gone, 'delete: off the display, recorded as a change')
check(files[recce.path('moab-sand-flats-ss1')] and #files[recce.path('moab-sand-flats-ss1')].changes == 5, 'every change saved to rallyraid/recce/<stage>.recce.json')

-- drive the terrain: automatic boxes -----------------------------------------------------------------------------
local maxAir = 0
driveTo(1400, function() if sim.air then maxAir = math.max(maxAir, sim.airtime) end end)
local auto = {}
for _, c in ipairs(R.doc.changes) do if c.by == 'recce-auto' then local k = c.box.features[1].kind; auto[k] = auto[k] or {}; table.insert(auto[k], c) end end
local function at(c) return (c.box.lon - LON0) * KX end
local kinds = {}
for k, l in pairs(auto) do kinds[#kinds + 1] = k .. ' x' .. #l .. ' @' .. table.concat((function() local o = {} for _, c in ipairs(l) do o[#o + 1] = math.floor(at(c)) end return o end)(), ',') end
table.sort(kinds)
print('  automatic boxes: ' .. table.concat(kinds, '; '))
local j = auto.jump and auto.jump[1]
check(auto.jump and #auto.jump == 1, 'one jump')
if j then
  local f = j.box.features[1]
  check(math.abs(f.airtime - maxAir) < 0.15 and f.length > 25 and f.length < 40 and j.box.danger == 3, string.format('jump: airtime %.2f s (sim %.2f), %.1f m long, height %.1f m, danger 3', f.airtime, maxAir, f.length, f.height))
  check(at(j) > 195 and at(j) < 215, 'jump box at the take-off (' .. math.floor(at(j)) .. ' m)')
  check(j.box.notes:find('^JUMP') ~= nil, 'jump notes: ' .. j.box.notes)
end
local cp = auto.compression and auto.compression[1]
check(auto.compression and #auto.compression == 1 and at(cp) > 385 and at(cp) < 410 and cp.box.features[1].g >= 2.4, 'one compression, in the dip, not at the jump landing' .. (cp and string.format(' (%.1f g @ %d m)', cp.box.features[1].g, at(cp)) or ''))
local cr = auto.crest and auto.crest[1]
check(auto.crest and #auto.crest == 1 and at(cr) > 570 and at(cr) < 610, 'one crest, at the top' .. (cr and (' @' .. math.floor(at(cr))) or ''))
check(auto.climb and #auto.climb == 1 and at(auto.climb[1]) > 790 and at(auto.climb[1]) < 815 and auto.climb[1].box.features[1].grade >= 28 and auto.climb[1].box.features[1].len >= 80, 'climb: 30 %, ~100 m' .. (auto.climb and (' ' .. auto.climb[1].box.notes) or ''))
check(auto.descent and #auto.descent == 1 and at(auto.descent[1]) > 950 and at(auto.descent[1]) < 975, 'descent' .. (auto.descent and (' ' .. auto.descent[1].box.notes) or ''))
check(auto.soft_sand and #auto.soft_sand == 1 and at(auto.soft_sand[1]) > 1090 and at(auto.soft_sand[1]) < 1130 and auto.soft_sand[1].box.danger == 1 and auto.soft_sand[1].box.notes:find('WHEELSPIN'), 'soft sand (slow + wheelspin; 14 km/h is not bogging)' .. (auto.soft_sand and (' @' .. math.floor(at(auto.soft_sand[1]))) or ''))
check(auto.sideslope and #auto.sideslope == 1 and auto.sideslope[1].box.notes:find('FALLS LEFT') and at(auto.sideslope[1]) > 1240, 'side slope, right side up = falls left' .. (auto.sideslope and (' ' .. auto.sideslope[1].box.notes) or ''))
local nAuto = 0; for _ in pairs(auto) do nAuto = nAuto + 1 end
check(nAuto == 7, 'nothing else detected (' .. nAuto .. ' kinds)')
for _, c in ipairs(R.doc.changes) do if c.by == 'recce-auto' then check(c.box.km and c.box.drivenKm and c.box.lat and c.box.lon and #c.box.symbols == 1, 'auto box complete ' .. c.id) end end
-- the driven line
local d = R.doc
check(#d.driven.points >= 120 and #d.driven.points <= 142, 'driven line: a point every 10-12 m (' .. #d.driven.points .. ')')
check(math.abs(d.driven.points[#d.driven.points][3] - 1.4) < 0.02, 'driven km ~1.40 (' .. d.driven.points[#d.driven.points][3] .. ')')
check(math.abs(core.roadbookState().recce.km - 1.4) < 0.02, 'panel shows the driven km')
-- teleport: a gap in the line, not distance
car.lon = car.lon + 2000 / KX; core.onUpdate(0.1, 0.1)
check(#d.driven.breaks == 1 and math.abs(d.driven.points[#d.driven.points][3] - 1.4) < 0.02, 'teleport: line break, no distance')
-- rebasing frames are skipped (no frame samples while BeamNG.Earth moves the world)
local rebasing = true
beamngEarth_api.rebasing = function() return rebasing end
local acc0 = R.acc; recce.sampler = function() error('sampled while rebasing') end
core.onUpdate(DT, DT)
check(true, 'no sample while rebasing')
rebasing = false; recce.sampler = sample

-- stop, resume ------------------------------------------------------------------------------------------------------
local nChanges = #d.changes
core.cmd('recce')
check(not recce.active() and notes[#notes]:find('recce off'), 'recce off, saved')
local saved = files[recce.path('moab-sand-flats-ss1')]
check(saved.format == 'rallyraid-recce' and saved.stage.id == 'moab-sand-flats-ss1' and saved.stage.hash and saved.roadbook.revision and #saved.changes == nChanges and saved.driven.km > 1.39, 'recce file: format, stage id + hash, roadbook revision, changes, driven line')
core.loadStage(moab.path); S = core._debug()
local plain = #S.stage.roadbook.boxes
core.cmd('recce')
check(#recce.get().doc.changes == nChanges and #S.stage.roadbook.boxes ~= plain, 'resumed recce shows its changes on the display again')
check(#recce.get().doc.driven.breaks >= 2, 'resumed line starts a new piece')

-- merge into the roadbook ------------------------------------------------------------------------------------------
local rbPath = S.stage.roadbook.source.path
local orig = READ_JSON(rbPath)
-- someone edited rb-junction-16 in the editor after this recce read it: our update on it must become a conflict
for _, b in ipairs(orig.boxes) do if b.id == J16 then b.rev = 5; b.pinned = true; b.source = 'editor'; b.sources = { 'auto-osm', 'editor' }; b.notes = 'DESK EDIT' end end
files[rbPath] = orig
local rev0 = orig.revision
-- fixtures for the node test (the editor's applyChanges must agree) and the editor's recce import test
if WRITE_JSON then
  WRITE_JSON('tests/fixtures/recce/moab-sand-flats-ss1.recce.json', files[recce.path('moab-sand-flats-ss1')])
  WRITE_JSON('tests/fixtures/recce/moab-desk-edited.roadbook.json', orig)
end
core.cmd('recceMerge')
local merged = files[rbPath]
check(merged.revision == rev0 + 1, 'merge: revision + 1')
check(files[recce.DIR .. 'backup/moab-sand-flats-ss1.rev' .. rev0 .. '.roadbook.json'] ~= nil, 'merge: backup of the roadbook first')
local byId = {}
for _, b in ipairs(merged.boxes) do byId[b.id] = b end
check(byId[c1.id] and byId[c1.id].source == 'recce-manual' and byId[c1.id].pinned and byId[c1.id].verified, 'merged manual box: pinned + verified')
check(j and byId[j.id] and byId[j.id].source == 'recce-auto' and not byId[j.id].verified, 'merged auto box: not verified until someone confirms')
check(byId[J44].deleted and byId[J44].pinned, 'merged delete: tombstone')
check(byId[J32].pinned and byId[J32].history[#byId[J32].history].change == 'moved', 'merged move')
check(byId[J16].notes == 'DESK EDIT' and #merged.conflicts >= 2, 'desk edit wins: confirm + retag on it became conflicts')
local okOrder = true
local live = 0
for i, b in ipairs(merged.boxes) do if not b.deleted then live = live + 1; if b.n ~= live or (i > 1 and not merged.boxes[i - 1].deleted and b.km < merged.boxes[i - 1].km) then okOrder = false end end end
check(okOrder, 'merged boxes sorted and renumbered')
check(#recce.get().doc.changes == 0 and #recce.get().doc.applied == nChanges and recce.get().doc.mergedInto.revision == merged.revision, 'recce file: changes moved to applied')
check(notes[#notes]:find('merged') and notes[#notes]:find('conflicts'), 'merge reported: ' .. notes[#notes])
if WRITE_JSON then WRITE_JSON('tests/fixtures/recce/moab-merged-in-game.roadbook.json', merged) end
local nb2 = 0; for _, b in ipairs(S.stage.roadbook.boxes) do if b.id == c1.id then nb2 = nb2 + 1 end end
check(nb2 == 1 and S.stage.roadbook.source.revision == merged.revision, 'display reloaded from the merged file')
core.cmd('recceMerge')
check(notes[#notes]:find('nothing to merge'), 'merging twice: nothing to do')

-- km from the driven line (rescale) --------------------------------------------------------------------------------
local rb = { format = 'rallyraid-roadbook', revision = 1, boxes = {} }
local drv = { points = {}, breaks = {} }
for i = 0, 100 do drv.points[#drv.points + 1] = { LAT0, LON0 + i * 20 / KX, i * 0.02 * 1.1 } end   -- the car's trip read 10 % more
for i = 0, 10 do rb.boxes[#rb.boxes + 1] = { id = 'b' .. i, km = i * 0.2, lat = LAT0 + (i == 5 and 0.01 or 0), lon = LON0 + i * 200 / KX } end
local n = recce.rescale(rb, drv)
check(n == 10, 'rescale: 10 boxes on the line, 1 off it (' .. n .. ')')
check(math.abs(rb.boxes[11].km - 2.2) < 0.005 and math.abs(rb.boxes[3].km - 0.44) < 0.005, 'rescale: km = driven distance')
check(math.abs(rb.boxes[6].km - 1.1) < 0.005, 'rescale: the box off the line is placed in proportion (' .. rb.boxes[6].km .. ')')
check(rb.recce and rb.recce.matched == 10 and rb.boxes[11].history and #rb.boxes[11].history == 1, 'rescale noted in the file and box history')

-- merge with rescale through the command
core.cmd('recceDrop'); core.cmd('recceSave')
core.cmd('recceMerge', 'rescale')
check(notes[#notes]:find('re%-measured'), 'merge + rescale: ' .. notes[#notes])
core.cmd('recce')

-- the UI's data stays JSON-friendly
local st = core.roadbookState()
check(st.recce == nil, 'recce off: no panel data')

print(string.format('%d passed, %d failed', passes, fails))
return fails
