-- rally.raid Earth: the GPS trace of a running stage (for official-event result packages; docs/EVENTS.md "Trace").
-- Adaptive: a point every `everyS` (5 s) of stage clock, plus an extra one (at most one per `minGapS`) when the car turns
-- more than `turnDeg` or its speed changes more than `speedKmh` since the last point, plus one at every waypoint.
-- Point = { t, w, lat, lon, odo, kmh }: t = stage clock (s, 0.1), w = wall clock (s after trace.epoch0: shows gaps
-- when the game was paused, closed or crashed), lat / lon (5 decimals, ~1 m), odo = distance driven in the stage (km,
-- 3 decimals), kmh = speed. Stored as arrays, columns in trace.cols, so the file stays small.
local M = {}
M.cfg = { everyS = 5, minGapS = 1, turnDeg = 30, speedKmh = 25, maxPoints = 40000 }
M.COLS = { 't', 'w', 'lat', 'lon', 'odo', 'kmh' }

local function r(x, n) local k = 10 ^ n; return math.floor(x * k + 0.5) / k end
local function angDiff(a, b) local d = math.abs((a or 0) - (b or 0)) % 360; return d > 180 and 360 - d or d end

function M.new(epoch0)
  return { v = 1, cols = M.COLS, epoch0 = math.floor(tonumber(epoch0) or os.time()), everyS = M.cfg.everyS, pts = {}, last = nil, dropped = 0 }
end

-- p: { clock, wall (epoch s), lat, lon, odoKm, kmh, heading }; force: a waypoint / start / finish point
function M.add(T, p, force)
  if not (T and p and tonumber(p.lat) and tonumber(p.lon)) then return false end
  local L = T.last
  local clock = tonumber(p.clock) or 0
  if L and not force then
    local dt = clock - L.clock
    if dt < M.cfg.minGapS then return false end
    if dt < M.cfg.everyS then
      local turn = p.heading and L.heading and angDiff(p.heading, L.heading) >= M.cfg.turnDeg
      local spd = math.abs((p.kmh or 0) - (L.kmh or 0)) >= M.cfg.speedKmh
      if not (turn or spd) then return false end
    end
  end
  if #T.pts >= M.cfg.maxPoints then T.dropped = T.dropped + 1; return false end
  T.pts[#T.pts + 1] = { r(clock, 1), math.floor((tonumber(p.wall) or os.time()) - T.epoch0), r(p.lat, 5), r(p.lon, 5),
    r(tonumber(p.odoKm) or 0, 3), math.floor((tonumber(p.kmh) or 0) + 0.5) }
  T.last = { clock = clock, heading = p.heading, kmh = p.kmh }
  return true
end

-- the trace as it goes into the result package / the game-crash save
function M.export(T)
  if not T then return nil end
  return { v = T.v, cols = T.cols, epoch0 = T.epoch0, everyS = T.everyS, pts = T.pts, dropped = T.dropped,
    rule = { everyS = M.cfg.everyS, turnDeg = M.cfg.turnDeg, speedKmh = M.cfg.speedKmh } }
end
-- back from a save: keeps adding where it stopped
function M.import(d)
  if type(d) ~= 'table' or type(d.pts) ~= 'table' then return nil end
  local T = { v = 1, cols = M.COLS, epoch0 = tonumber(d.epoch0) or os.time(), everyS = tonumber(d.everyS) or M.cfg.everyS,
    pts = {}, dropped = tonumber(d.dropped) or 0 }
  for _, q in ipairs(d.pts) do T.pts[#T.pts + 1] = q end
  local lp = T.pts[#T.pts]
  if lp then T.last = { clock = tonumber(lp[1]) or 0, kmh = tonumber(lp[6]) or 0 } end
  return T
end
return M
