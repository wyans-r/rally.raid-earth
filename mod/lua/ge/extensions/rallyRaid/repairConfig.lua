-- rally.raid Earth: every tunable number of the repair system, in one place.
-- Approved by Wyans 2026-11-16 (docs/REPAIR.md explains them to players, docs/REPAIR_SPIKE.md has the background).
-- Times are minutes unless the name says otherwise. Change a value here and rebuild the mod zip; nothing else needs
-- editing. The values are copied into every result file ("repairRules") so a penalty can always be checked later.
local M = {}

M.version = 1

------------------------------------------------------------------------------------------------------------------
-- mid-stage repairs (the car must be standing still; the time is added to the stage as a 'repair' penalty)
M.stage = {
  wheelChangeMin = 2,          -- one wheel and tyre swapped for a spare
  sparesPerStage = 2,          -- spare wheels carried on each stage
  suspensionMin = 18,          -- light suspension repair at one corner (approved range 15-20)
  radiatorMin = 12,            -- radiator patched / replaced
  maxStoppedKmh = 1.0,         -- "standing still": a repair is refused above this speed
}

------------------------------------------------------------------------------------------------------------------
-- the bivouac (between stages: after an ASS, until the next stage's clock starts)
M.bivouac = {
  budgetMin = 180,             -- 3 h of service time
  penaltyPerMinLate = 60,      -- seconds of penalty per minute over the budget (1 min per min)
  retireAfterMinOver = 60,     -- more than this many minutes over = retired from the rally
  serviceMin = 10,             -- a whole-car repair always costs at least this (checks, fluids)
  engineChangeMin = 90,        -- bivouac time an engine change uses ...
  engineChangePenaltyS = 7200, -- ... plus this time penalty (2 h), added to the next stage
  -- whole-car repair: minutes per damaged group, scaled by how badly it is damaged:
  --   minutes = base * (scaleMin + (1 - scaleMin) * damage), damage 0..1, only for groups above damageThreshold
  scaleMin = 0.3,
  damageThreshold = 0.02,
  groupMin = {
    wheel = 2,                 -- per wheel (corner)
    suspension = 20,           -- per corner
    steering = 25,
    radiator = 30,
    body = 15,
    lights = 5,
    drivetrain = 90,           -- gearbox, transfer case, diffs, driveshafts
    fueltank = 60,
    frame = 120,
  },
}

------------------------------------------------------------------------------------------------------------------
-- RALLY MODE (rallyRaid/rally.lua, EXPERIMENTAL, B10): a multi-day rally file (docs/RALLY_FORMAT.md). Liaisons (bivouac ->
-- DSS, ASS -> bivouac) are the player's choice: DRIVE them against a time allowance, or TELEPORT (the whole allowance
-- counts as used). Allowance not used on the day's liaisons is added to that evening's bivouac budget (M.bivouac).
-- Defaults proposed in B10 (17 Nov 2026), for Wyans to confirm.
M.rally = {
  liaisonKmh = 60,             -- allowance = published liaison km at this speed ...
  liaisonExtraMin = 30,        -- ... plus this ...
  liaisonRoundMin = 5,         -- ... rounded UP to this (the rally file already carries the result; used if it does not)
  teleportUsesAllowance = true,-- a teleported liaison counts its full allowance as elapsed time (no leftover)
  leftoverToBivouac = true,    -- unused allowance (driven liaisons) is added to the evening bivouac budget
  maxLeftoverMin = 240,        -- at most this much leftover is added per day
  latePenaltyPerMinS = 60,     -- arriving after the allowance: this many seconds per started minute late
  arriveRadiusM = 300,         -- a driven liaison to a DSS ends inside this radius (or when the stage clock starts)
  bivouacRadiusM = 1500,       -- ... and to a bivouac (town) inside this radius
  driveStartMaxKm = 5,         -- DRIVE first teleports the car to the start bivouac when it is farther away than this
  restDayBonusMin = 300,       -- a rest day adds this much service time to the open bivouac
  marathon = {                 -- the night at a 'marathon' (refuge) bivouac: no assistance
    budgetMin = 45,            -- the crew's own work only: a short budget instead of M.bivouac.budgetMin
    addLeftover = false,       -- unused liaison allowance does not help (no mechanics there)
    engineChange = false,      -- no engine change at a refuge
  },
}

------------------------------------------------------------------------------------------------------------------
-- the resume / reset budget: resets our app did not make (unauthorized) and RECOVER CAR share these rules and penalties
M.resume = {
  maxPerRally = 3,
  maxPerStage = 1,             -- a second one on the same stage retires the stage
  firstPenaltyS = 15 * 60,     -- the first resume of the rally
  laterPenaltyS = 30 * 60,     -- every later one
  noResumeNearFinishM = 1000,  -- within this distance of the ASS a resume is not allowed (the stage is retired)
  expectResetS = 5,            -- how long after our own repair starts a reset counts as ours
}

------------------------------------------------------------------------------------------------------------------
-- RECOVER CAR (rallyRaid/resume.lua): the one reset allowed in a stage (Wyans 2026-11-16). The car is stuck, rolled or
-- lost off the route while the game runs: the driver asks for it (RECOVER in the GPS app or RECOVER CAR in the Repair app), it
-- costs the M.resume penalty above (15 min first, then 30 min) and counts in the same resume / reset log and limits
-- (3 per rally, 1 per stage, none within 1 km of the ASS). These are the mechanics. BeamNG's own reset keys stay
-- blocked in stages. docs/REPAIR.md "Recover car" explains it to players.
M.carRecovery = {
  enabled = true,              -- false: RECOVER CAR is refused ("switched off"); resets then only count as unauthorized
  snapshotEveryS = 30,         -- a recovery state (position, heading, damage, fuel, stage progress) every 30 s of stage clock
  firstSnapshotAfterS = 2,     -- the first one this long after the start (the car fresh out of the bivouac)
  keepSnapshots = 4,           -- how many are kept in memory (the car keeps the damage, the game the rest)
  minSnapshotAgeS = 5,         -- a newer one may already hold the crash: the latest one at least this old is used
  maxOffRouteM = 300,          -- a snapshot taken farther than this from the route is not "good"
  minUprightZ = 0.7,           -- ... nor one taken with the car tipped over (its up vector's z under this)
  maxCallKmh = 10,             -- a recovery is refused above this speed ("stop first")
  backOffM = 30,               -- the car is set down this far back along the route from where it got stuck
  searchBackM = 2000,          -- the route is searched this far back ...
  searchAheadM = 5000,         -- ... and this far ahead of the snapshot's place on it (a route that crosses itself)
  liftM = 0.5,                 -- set down this high over the ground
  localMoveMaxM = 1500,        -- farther than this from the car: BeamNG.Earth's teleport first (it loads the world there)
  teleportTimeoutS = 45,       -- how long to wait for that teleport
  answerTimeoutS = 8,          -- the car must answer within this (else nothing is charged and the clock runs again)
  resetFallbackS = 1.0,        -- the set-down did not reset the car within this: reset it in place
  settleS = 2,                 -- the clock stays paused this long after the car is back (it settles on its wheels)
  confirmS = 15,               -- a second RECOVER press (button or key) within this confirms the recovery shown
  headingWarnDeg = 45,         -- the car faces more than this off the route afterwards: logged as a warning
}

------------------------------------------------------------------------------------------------------------------
-- GAME-CRASH RESUME (rallyRaid/gameResume.lua): the GAME crashed or was force-quit (CTD, BeamNG error) mid-stage. The
-- stage state is saved to disk (atomically: temp file, then rename) every 30 s of stage clock and at every CP / WP,
-- penalty, repair or recovery; after a relaunch, loading the stage offers "Resume from last save" or "Discard".
-- Wyans 2026-11-16: no time penalty, but every resume is flagged for organizer review in the stage result; the limits
-- are off, with a switch for official events (useOfficialRules, values in M.gameCrashResumeOfficial below).
M.gameCrashResume = {
  enabled = true,
  dir = '/settings/rallyraid/resume/',   -- under the BeamNG user folder: <rallyId>_<stageId>.json (+ .1 / .2 older)
  saveEveryS = 30,             -- a save every 30 s of stage clock ...
  saveOnEvents = true,         -- ... and at once after a CP / WP, a penalty, a repair, a car recovery, the start
  keepSaves = 3,               -- the newest 3 saves are kept: a corrupt or half-written one falls back to the one before
  heartbeatEveryS = 5,         -- a tiny "still alive" file (stage clock + time): estimates the stage time lost in a crash
  carAnswerS = 3,              -- the car's damage must come back within this, else the save keeps the last damage it had
  releaseKmh = 3,              -- after a resume the clock is held at the saved time until the car goes faster than this
  confirmS = 15,               -- a second RESUME press (button or key) within this resumes the save shown
  spawnTimeoutS = 30,          -- the saved car model has to be spawned first: wait this long for it
  maxSaveAgeH = nil,           -- older saves are not offered (nil: no age limit)
  flagForReview = true,        -- every resume is flagged in the result for organizer review (with the gap and saved vs resumed state)
  useOfficialRules = false,    -- true: the values in M.gameCrashResumeOfficial replace the ones below (official events)
  firstPenaltyS = 0,           -- penalty for the first game-crash resume of the rally (original rule: 15 * 60)
  laterPenaltyS = 0,           -- ... and every later one (original rule: 30 * 60)
  maxPerRally = nil,           -- nil = no limit (original rule: 3)
  maxPerStage = nil,           -- nil = no limit (original rule: 1)
  retireOverLimit = true,      -- over a limit: the stage is retired with the saved state (else the resume is only refused)
  noResumeNearFinishM = nil,   -- nil = off; e.g. 1000: no resume within 1 km of the ASS (the stage is retired)
  shareRecoveryBudget = false, -- true: counts together with car recoveries / unauthorized resets for the limits and the 15 / 30 min
}
-- the original rules (one switch: M.gameCrashResume.useOfficialRules = true)
M.gameCrashResumeOfficial = {
  firstPenaltyS = 15 * 60, laterPenaltyS = 30 * 60, maxPerRally = 3, maxPerStage = 1, retireOverLimit = true,
  noResumeNearFinishM = 1000, shareRecoveryBudget = true,
}

------------------------------------------------------------------------------------------------------------------
-- key blocking in official runs (BeamNG's input action filter); every name is tried, unknown ones are ignored
M.block = {
  filterName = 'rallyRaidOfficial',
  useCompetitiveTemplate = true,   -- also block BeamNG's own "competitive" action template
  actions = { 'reset_physics', 'reset_all_physics', 'reload_vehicle', 'reload_all_vehicles', 'recover_vehicle',
    'recover_vehicle_alt', 'recover_to_last_road', 'loadHome', 'saveHome', 'dropPlayerAtCamera',
    'dropPlayerAtCameraNoReset', 'goto_checkpoint', 'parts_selector', 'vehicle_selector', 'nodegrabberGrab',
    'nodegrabberAction' },
}

------------------------------------------------------------------------------------------------------------------
-- which vehicle parts belong to which repair group: Lua patterns matched against the lower-case part name a node /
-- beam came from (its jbeam "partOrigin"). 'exclude' wins over 'match'. Groups marked perCorner are split by the
-- nearest wheel (FL, FR, RL, RR, ...). Checked against the published class list cars in game: see docs/REPAIR.md.
M.groups = {
  wheel      = { perCorner = true, match = { 'wheel', 'tire', 'tyre', 'rim', 'hubcap' },
                 exclude = { 'steer', 'wheelhouse', 'wheelwell', 'wheelarch', 'wheel_arch', 'spare' } },
  suspension = { perCorner = true, match = { 'suspension', 'shock', 'spring', 'coilover', 'strut', 'damper', 'arm',
                 'hub', 'knuckle', 'upright', 'axle', 'leaf', 'sway', 'swaybar', 'link', 'trailing', 'spindle',
                 'halfshaft', 'tierod' }, exclude = { 'armrest', 'alarm', 'mirror', 'engine', 'frame', 'body' } },
  radiator   = { match = { 'radiator' } },
  steering   = { match = { 'steering', 'rack' }, exclude = { 'steering_wheel', 'steer_wheel' } },
  engine     = { match = { 'engine', 'intake', 'exhaust_manifold', 'turbo', 'supercharger', 'oilpan' },
                 exclude = { 'enginemount', 'engine_mount', 'hood' } },
  drivetrain = { match = { 'transmission', 'gearbox', 'transfer', 'differential', 'diff_', 'driveshaft' } },
  fueltank   = { match = { 'fueltank', 'fuel_tank', 'fuelcell', 'fuel_cell' } },
  lights     = { match = { 'light', 'lamp', 'glass', 'windshield', 'window' } },
  frame      = { match = { 'frame', 'chassis', 'subframe', 'rollcage', 'cage' } },
  -- 'body' is everything else (panels, bumpers, doors, skid plates ...)
}
-- the order groups are tried in (the first match wins), so 'frame' beats 'body' and 'wheel' beats 'suspension'
M.groupOrder = { 'wheel', 'radiator', 'steering', 'engine', 'drivetrain', 'fueltank', 'suspension', 'lights', 'frame' }
M.beamDamagedRatio = 0.02      -- a beam whose rest length moved more than 2 % from new counts as damaged

-- engine damage flags (vehicle damageTracker 'engine' group) an engine change cures; a whole-car repair keeps them
M.engineFlags = { 'engineLockedUp', 'engineHydrolocked', 'headGasketDamaged', 'pistonRingsDamaged',
  'rodBearingsDamaged', 'engineDisabled', 'mildOverrevDamage', 'catastrophicOverrevDamage', 'blockMelted',
  'cylinderWallsMelted', 'oilpanLeak', 'oilStarvation' }

return M
