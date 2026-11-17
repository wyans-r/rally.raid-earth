-- Loads every stage in mod/rallyraid/stages with the mod's own loader and drives a fake car along each route:
-- every waypoint must validate in order and the stage must finish. Run with tests/run_all_stages.py.
package.path = MOD_ROOT .. '/lua/ge/extensions/?.lua;' .. package.path
local car = { lat = 0, lon = 0, speed = 0, ve = 0, vn = 0, heading = 0 }
local ui, files = {}, {}
guihooks = { trigger = function(n, d) ui[n] = d end }
extensions = { hook = function() end }
log = function() end
jsonReadFile = function(p) return READ_JSON(p) end
jsonWriteFile = function(p, d) files[p] = d; return true end
FS = { findFiles = function(self, dir) return LIST_FILES(dir) end }
beamngEarth_api = { version = function() return 1, 8 end, ready = function() return true end, rebasing = function() return false end,
  pose = function() return { lat = car.lat, lon = car.lon, speed = car.speed, ve = car.ve, vn = car.vn, heading = car.heading, camera = false } end,
  notify = function() return true end, teleport = function() return true end }
local geo = require('rallyRaid/geo')
local core = require('rallyRaid/core')
local fails = 0
local function driveTo(lat, lon, kmh)
  local v = kmh / 3.6
  for _ = 1, 200000 do
    local d = geo.dist(car.lat, car.lon, lat, lon)
    if d < 0.5 then break end
    local b = geo.bearing(car.lat, car.lon, lat, lon)
    local move = math.min(d, v * 0.1)
    car.lat = car.lat + move * math.cos(math.rad(b)) / 111195
    car.lon = car.lon + move * math.sin(math.rad(b)) / (111195 * math.cos(math.rad(car.lat)))
    car.speed, car.heading, car.ve, car.vn = v, b, v * math.sin(math.rad(b)), v * math.cos(math.rad(b))
    core.onUpdate(0.1, 0.1)
  end
end
for _, st in ipairs(core.listStages()) do
  if not st.ok then print('INVALID ' .. st.file .. ': ' .. tostring(st.error)); fails = fails + 1
  else
    core._reset(); files = {}
    core.loadStage(st.path)
    local S = core._debug()
    local raw = READ_JSON(st.path)
    car.lat, car.lon = S.stage.waypoints[1].lat, S.stage.waypoints[1].lon
    core.onUpdate(0.1, 0.1)
    if S.rules.startMode == 'countdown' then core.cmd('start'); for _ = 1, 60 do core.onUpdate(0.1, 0.1) end end
    -- 25 km/h: under every speed-zone limit
    for _, leg in ipairs(raw.route.legs) do
      for i = 2, #leg.points do driveTo(leg.points[i][1], leg.points[i][2], 25) end
    end
    local missed, res = 0, nil
    for i = 1, #S.stage.waypoints do if S.state[i] ~= 'ok' then missed = missed + 1 end end
    -- the rally ledger is written too; table iteration order is not the order of writes
    for _, d in pairs(files) do if d.format == 'rallyraid-result' then res = d end end
    -- the ready-made roadbook in rallyraid/roadbooks/ is used, sorted, with the notes moved in from the old stage file
    local rb = S.stage.roadbook
    local rbOk = rb.source ~= nil and #rb.boxes > #S.stage.waypoints
    local pinnedText = 0
    for i, b in ipairs(rb.boxes) do
      if i > 1 and b.km < rb.boxes[i - 1].km then rbOk = false end
      if b.n ~= i then rbOk = false end
      if b.notes and b.notes ~= '' then pinnedText = pinnedText + 1 end
    end
    if pinnedText == 0 then rbOk = false end
    if not rbOk then print('ROADBOOK FAIL ' .. st.file .. ' source=' .. tostring(rb.source and rb.source.path) .. ' boxes=' .. #rb.boxes .. ' notes=' .. pinnedText) end
    local ok = rbOk and S.phase == 'finished' and missed == 0 and res and res.penaltyTime == 0
    if not ok then fails = fails + 1 end
    print(string.format('%s %-40s %6.1f km  %2d WP %3d boxes  phase=%s missed=%d penalties=%s driven=%.1f km', ok and 'OK  ' or 'FAIL',
      st.file, st.km, st.waypoints, #rb.boxes, S.phase, missed, res and res.penaltyTime or '-', res and res.distanceDriven or 0))
  end
end
return fails
