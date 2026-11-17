-- rally.raid Earth: waypoint and speed-zone rules.
-- Defaults follow the 2026 FIM World Rally-Raid Championship sporting regulations (Art. 11.2 waypoint table and
-- Art. 16 speed control zones). A stage file can override any value in its "rules" block (docs/STAGE_FORMAT.md),
-- because organisers (and the FIA / ASO for the Dakar) change radii from year to year.
local M = {}

-- reveal modes:
--   always        shown on the GPS all the time (WPV)
--   never         never shows distance / heading, only its number (WPC)
--   radius        shown once within `radius` metres
--   prev          shown once the previous waypoint is validated, or within `radius` if that one was missed
--   radiusOrPrev  shown within `radius`, or straight away when the previous waypoint (validated) is closer than
--                 `radius` to this one ("1000 m (Prev)" in the FIM table, used for DZ)
-- validate: validation radius in metres. penalty: seconds added when missed (nil = stage start / finish).
M.FIM2026 = {
  preset = 'FIM-2026',
  waypoints = {
    DSS = { reveal = 'prev',         radius = 1000, validate = 200, penalty = nil },
    WPV = { reveal = 'always',                      validate = 200, penalty = 900 },
    WPE = { reveal = 'prev',         radius = 1000, validate = 90,  penalty = 900 },
    WPM = { reveal = 'radius',       radius = 800,  validate = 90,  penalty = 900 },
    WPN = { reveal = 'radius',       radius = 800,  validate = 200, penalty = 3600 },
    WPS = { reveal = 'radius',       radius = 1000, validate = 30,  penalty = 900 },
    WPC = { reveal = 'never',                       validate = 300, penalty = 900 },
    WPP = { reveal = 'radius',       radius = 100,  validate = 20,  penalty = 120 },
    DZ  = { reveal = 'radiusOrPrev', radius = 1000, validate = 90,  penalty = 900 },
    FZ  = { reveal = 'prev',         radius = 1000, validate = 90,  penalty = 900 },
    ASS = { reveal = 'radius',       radius = 800,  validate = 90,  penalty = nil },
  },
  speedZone = {
    tolerance = 90,            -- m after DZ / before FZ where speed is not checked (deceleration / acceleration)
    warnBefore = 90,           -- m before DZ: "speed zone ahead" warning
    alertMargin = 5,           -- km/h under the limit where the GPS starts flashing (FIM: alert at 5 km/h before)
    impulseDistance = 150,     -- while speeding, one impulse every 150 m ...
    impulseTime = 10,          -- ... or every 10 s, whichever comes first
    bands = {                  -- km/h over the limit -> seconds per impulse
      { upTo = 5,  penalty = 10 },
      { upTo = 15, penalty = 60 },
      { upTo = 40, penalty = 120 },
      { upTo = nil, penalty = 360 },
    },
  },
  globalMaxKmh = nil,          -- category maximum (FIM: 160 RallyGP / Rally2, 130 Rally3 / quads); nil = none
  globalImpulsePenalty = 60,   -- s per impulse over globalMaxKmh, from the second impulse on
  lookahead = 5,               -- how many waypoints ahead are checked (taking a later one marks the skipped ones missed)
  tripSnapToWaypoint = true,   -- set the trip to the waypoint's roadbook km when it is validated
  startMode = 'auto',          -- 'auto': clock starts when you leave the DSS circle; 'countdown': only after START
  countdown = 5,               -- s, START button countdown
  falseStartPenalty = 60,      -- s, moving out of the DSS circle during the countdown
}

local function copy(t)
  if type(t) ~= 'table' then return t end
  local o = {}
  for k, v in pairs(t) do o[k] = copy(v) end
  return o
end
M.copy = copy

local function merge(dst, src)
  if type(src) ~= 'table' then return dst end
  for k, v in pairs(src) do
    if type(v) == 'table' and type(dst[k]) == 'table' and #v == 0 then merge(dst[k], v)
    else dst[k] = copy(v) end
  end
  return dst
end

-- the stage's rules: the FIM defaults with the stage file's overrides on top
function M.build(stageRules)
  return merge(copy(M.FIM2026), stageRules)
end

-- the rule for one waypoint: its type's rule, with per-waypoint overrides (validate / radius / penalty / reveal)
function M.forWaypoint(rules, wp)
  local base = rules.waypoints[wp.type] or rules.waypoints.WPV
  -- (tonumber everywhere: a JSON null may arrive as nil or as a decoder's null marker)
  local r = { reveal = type(base.reveal) == 'string' and base.reveal or 'radius', radius = tonumber(base.radius),
    validate = tonumber(base.validate) or 90, penalty = tonumber(base.penalty) }
  if type(wp.reveal) == 'string' then r.reveal = wp.reveal end
  if tonumber(wp.revealRadius) then r.radius = tonumber(wp.revealRadius) end
  if tonumber(wp.validate) then r.validate = tonumber(wp.validate) end
  if tonumber(wp.penalty) then r.penalty = tonumber(wp.penalty) end
  return r
end

-- seconds for one speed impulse `over` km/h over the limit (FIM Art. 16)
function M.impulsePenalty(rules, over)
  over = math.floor(over or 0)
  if over < 1 then return 0 end
  for _, b in ipairs(rules.speedZone.bands) do
    local upTo = tonumber(b.upTo)
    if upTo == nil or over <= upTo then return tonumber(b.penalty) or 0 end
  end
  return 0
end

return M
