-- Rally Raid for BeamNG.Earth: pure geodesy helpers (no game calls, unit-testable outside the game).
-- Everything works in WGS84 latitude / longitude degrees, never in game coordinates (BeamNG.Earth moves the
-- world's origin as you drive, so game x / y go stale; lat / lon never do).
local M = {}

local R = 6371008.8            -- mean Earth radius, metres
local rad, deg = math.rad, math.deg
local sin, cos, atan2, sqrt, asin = math.sin, math.cos, math.atan2, math.sqrt, math.asin

-- great-circle distance in metres (haversine)
function M.dist(lat1, lon1, lat2, lon2)
  local p1, p2 = rad(lat1), rad(lat2)
  local dp, dl = p2 - p1, rad(lon2 - lon1)
  local h = sin(dp / 2) ^ 2 + cos(p1) * cos(p2) * sin(dl / 2) ^ 2
  return 2 * R * asin(math.min(1, sqrt(h)))
end

-- initial bearing from point 1 to point 2, degrees clockwise from true north, 0..360
function M.bearing(lat1, lon1, lat2, lon2)
  local p1, p2, dl = rad(lat1), rad(lat2), rad(lon2 - lon1)
  local y = sin(dl) * cos(p2)
  local x = cos(p1) * sin(p2) - sin(p1) * cos(p2) * cos(dl)
  return (deg(atan2(y, x)) + 360) % 360
end

-- course over ground from east / north velocity (m/s), degrees; nil when too slow to be meaningful
function M.course(ve, vn, minSpeed)
  ve, vn = ve or 0, vn or 0
  if sqrt(ve * ve + vn * vn) < (minSpeed or 1.0) then return nil end
  return (deg(atan2(ve, vn)) + 360) % 360
end

-- signed smallest difference a - b in degrees, -180..180
function M.angleDiff(a, b)
  return ((a - b + 540) % 360) - 180
end

return M
