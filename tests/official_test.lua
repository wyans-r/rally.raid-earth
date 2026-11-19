-- Official event runs (rallyRaid/official.lua + trace.lua + sha256.lua): an event pack is checked (hashes, mod version,
-- window), loads as the official stage (planner / recce / roadbook reload refused, official rules forced), is driven, and
-- the finish writes a result package and "uploads" it (mocked HTTP). Writes tests/fixtures/events/*.json for the
-- website's end-to-end test. Run with tests/run_tests.py.
local MOD = MOD_ROOT .. '/lua/ge/extensions/'
package.path = MOD .. '?.lua;' .. package.path

local car = { lat = 0, lon = 0, speed = 0, ve = 0, vn = 0, heading = 0 }
local ui, files, notes = {}, {}, {}
guihooks = { trigger = function(n, d) ui[n] = d end }
extensions = { hook = function() end }
log = function() end
ui_message = function(t) notes[#notes + 1] = t end
jsonReadFile = function(p) return READ_JSON(p) end
jsonWriteFile = function(p, d) files[p] = d; return true end
jsonEncode = function(t) return JSON_ENCODE(t) end
jsonDecode = function(s) return DECODE_JSON(s) end
FS = { findFiles = function(self, dir) return LIST_FILES(dir) end }
beamngEarth_api = {
  version = function() return 1, 8 end, ready = function() return true end, rebasing = function() return false end,
  pose = function() return { lat = car.lat, lon = car.lon, speed = car.speed, ve = car.ve, vn = car.vn, heading = car.heading, camera = false } end,
  notify = function(t) notes[#notes + 1] = t; return true end,
  teleport = function(lat, lon) car.lat, car.lon = lat, lon; return true end,
}

local geo = require('rallyRaid/geo')
local sha = require('rallyRaid/sha256')
local traceMod = require('rallyRaid/trace')
local official = require('rallyRaid/official')
local cfg = require('rallyRaid/repairConfig')
local core = require('rallyRaid/core')

local fails, passes = 0, 0
local function check(cond, msg) if cond then passes = passes + 1 else fails = fails + 1; print('FAIL: ' .. msg) end end

-- sha256 vs Python's -------------------------------------------------------------------------------------------------
for _, s in ipairs({ '', 'abc', string.rep('a', 55), string.rep('a', 56), string.rep('a', 64), string.rep('x', 1000), 'Erg Chebbi \226\128\148 dunes' }) do
  check(sha.hex(s) == SHA256(s), 'sha256 matches python for a ' .. #s .. ' byte string')
end
check(official.versionAtLeast('0.2.0', '0.2.0') and official.versionAtLeast('0.10.0', '0.9.3') and not official.versionAtLeast('0.1.9', '0.2.0'), 'version compare')
check(official.epochOf('2026-11-20T18:00:00Z') == 1795197600 and official.epochOf('2000-02-29T00:00:00Z') == 951782400, 'ISO UTC -> epoch')

-- the fake virtual file system for official.io ------------------------------------------------------------------------
local vfs, posts = {}, {}
local NOW = official.epochOf('2026-11-21T12:00:00Z')
local clockNow = NOW
official.io.read = function(p) return vfs[p] end
official.io.write = function(p, t) vfs[p] = t; return true end
official.io.mkdir = function() end
official.io.list = function(d) local o = {} for p in pairs(vfs) do if p:sub(1, #d) == d and p:match('%.rrevent%.json$') then o[#o + 1] = p end end table.sort(o) return o end
official.io.time = function() return clockNow end
local postReply = { 200, '{"status":"pass","resultId":"r1","url":"https://stagebuilder.wyans.net/events/#/e/ev1"}' }
official.io.post = function(url, body, headers) posts[#posts + 1] = { url = url, body = body, headers = headers }; return postReply[1], postReply[2] end

local stageText = READ_TEXT('mod/rallyraid/stages/moab-sand-flats-ss1.json')
local rbText = READ_TEXT('mod/rallyraid/roadbooks/moab-sand-flats-ss1.roadbook.json')
check(stageText and rbText, 'sample stage + roadbook texts read')
local function pack(over)
  over = over or {}
  local p = {
    format = 'rallyraid-event-pack', schemaVersion = 1,
    event = { id = 'ev1', name = 'Test Rally 2026', opensAt = '2026-11-20T18:00:00Z', closesAt = '2026-11-27T18:00:00Z',
      minModVersion = over.minModVersion or '0.2.0', uploadUrl = 'http://stagebuilder.wyans.net/api/game/results', rules = {} },
    stage = { index = 1, key = 'ss1', name = 'SS1 Moab', known = true },
    files = { stage = { text = over.stageText or stageText, sha256 = SHA256(stageText) },
              roadbook = { text = over.rbText or rbText, sha256 = SHA256(rbText) } },
    entry = { id = 'en1', token = 'tok_secret_1', displayName = 'Wyans', class = 'T1 Prototype' },
  }
  return JSON_ENCODE(p)
end

-- refusals -----------------------------------------------------------------------------------------------------------
vfs['/rallyraid/events/bad-hash.rrevent.json'] = pack({ rbText = rbText:gsub('"km"', '"km" ', 1) })
local ok, errs = official.load('/rallyraid/events/bad-hash.rrevent.json')
check(ok == false and errs and tostring(errs[1]):match('roadbook file hash'), 'a changed roadbook is refused: ' .. tostring(errs and errs[1]))
vfs['/rallyraid/events/old-mod.rrevent.json'] = pack({ minModVersion = '9.0.0' })
ok, errs = official.load('/rallyraid/events/old-mod.rrevent.json')
check(ok == false and tostring(errs[1]):match('mod version'), 'too old a mod is refused')
clockNow = official.epochOf('2026-11-28T12:00:00Z')
vfs['/rallyraid/events/ev1-ss1.rrevent.json'] = pack()
ok, errs = official.load('/rallyraid/events/ev1-ss1.rrevent.json')
check(ok == false and tostring(errs[1]):match('closed'), 'a closed event is refused')
clockNow = NOW
check(cfg.gameCrashResume.useOfficialRules == false, 'refusals leave the normal rules')

-- list + load --------------------------------------------------------------------------------------------------------
local l = official.list()
check(#l == 3 and l[1].event == 'Test Rally 2026', 'packs listed: ' .. #l)
ok, errs = official.load('/rallyraid/events/ev1-ss1.rrevent.json')
check(ok == true, 'valid pack loads: ' .. tostring(errs and errs[1]))
local S = core._debug()
check(S and S.official and S.official.eventId == 'ev1', 'the stage runs as official')
check(S.stage.roadbook.boxes and #S.stage.roadbook.boxes > 10, 'the locked roadbook is loaded: ' .. tostring(#(S.stage.roadbook.boxes or {})))
check(cfg.gameCrashResume.useOfficialRules == true and cfg.gameCrashResumeOfficial.firstPenaltyS == 0 and cfg.gameCrashResumeOfficial.maxPerRally == 3,
  'official rules forced: resume limits on, no game-crash time penalty')
local pr = core.plannerCall('list', '')
check(type(pr) == 'table' and pr.error and pr.error:match('official'), 'planner refused in an official run')
local nNotes = #notes
core.cmd('reloadRoadbook'); core.cmd('recceStart')
check(#notes >= nNotes + 2 and notes[#notes]:match('not in an official run'), 'roadbook reload + recce refused')

-- drive it -----------------------------------------------------------------------------------------------------------
local function step(dt) core.onUpdate(dt, dt) end
local function driveTo(lat, lon, kmh)
  local v = kmh / 3.6
  for _ = 1, 100000 do
    local d = geo.dist(car.lat, car.lon, lat, lon)
    if d < 0.5 then break end
    local b = geo.bearing(car.lat, car.lon, lat, lon)
    local move = math.min(d, v * 0.1)
    car.lat = car.lat + move * math.cos(math.rad(b)) / 111195
    car.lon = car.lon + move * math.sin(math.rad(b)) / (111195 * math.cos(math.rad(car.lat)))
    car.speed, car.heading = v, b
    car.ve, car.vn = v * math.sin(math.rad(b)), v * math.cos(math.rad(b))
    step(0.1)
    clockNow = clockNow + 0.1
  end
end
local raw = DECODE_JSON(stageText)
local dss = S.stage.waypoints[1]
car.lat, car.lon = dss.lat + 0.005, dss.lon
step(0.1)
driveTo(dss.lat, dss.lon, 40)
for _, leg in ipairs(raw.route.legs) do
  for i = 2, #leg.points do driveTo(leg.points[i][1], leg.points[i][2], leg.from == 'dz1' and 38 or 75) end
end
for _ = 1, 10 do step(0.1) end            -- the upload waits half a second
S = core._debug()
check(S.phase == 'finished', 'official stage finished: ' .. tostring(S.phase))
local pkgPath
for p in pairs(vfs) do if p:match('^/rallyraid/results/official/.*%.rrresult%.json$') then pkgPath = p end end
check(pkgPath ~= nil, 'result package file written')
local pkg = pkgPath and DECODE_JSON(vfs[pkgPath])
if pkg then
  check(pkg.format == 'rallyraid-result-package' and pkg.modVersion == '0.3.2', 'package format + mod version')
  check(pkg.hashes.stage == SHA256(stageText) and pkg.hashes.roadbook == SHA256(rbText), 'package carries the verified hashes')
  check(pkg.event.id == 'ev1' and pkg.entry.id == 'en1' and pkg.entry.token == nil, 'package names event + entry, never the key')
  check(pkg.result.totalTime == pkg.result.stageTime + pkg.result.penaltyTime and #pkg.result.waypoints == #S.stage.waypoints, 'result inside')
  check(pkg.result.gameCrashResume and pkg.result.carRecovery, 'resume / recovery fields inside')
  local pts = pkg.trace.pts
  local maxDt, nWp = 0, 0
  for i = 2, #pts do maxDt = math.max(maxDt, pts[i][1] - pts[i - 1][1]) end
  check(#pts > pkg.result.stageTime / 5 * 0.9 and maxDt <= 5.15, string.format('trace: %d points over %.0f s, largest step %.1f s', #pts, pkg.result.stageTime, maxDt))
  check(math.abs(pts[#pts][5] - pkg.result.distanceDriven) < 0.05, 'trace odometer ends at the distance driven')
  print(string.format('  official run: %.0f s, %d trace points, package %d bytes', pkg.result.stageTime, #pts, #vfs[pkgPath]))
  check(#posts == 1 and posts[1].url == 'http://stagebuilder.wyans.net/api/game/results' and posts[1].headers.Authorization == 'Bearer tok_secret_1', 'uploaded with the entry key')
  check(official.state().last.status == 'uploaded', 'upload status shown')
  WRITE_JSON('tests/fixtures/events/moab_official_package.json', pkg)
  WRITE_JSON('tests/fixtures/events/moab_event_pack_meta.json', { stageSha = SHA256(stageText), roadbookSha = SHA256(rbText) })
end
-- the upload fails: the file stays for the website, retry works
postReply = { nil, 'connection refused' }
official.doUpload({ url = 'http://x/api/game/results', body = '{}', token = 't' })
check(official.state().last.status == 'saved' and official.state().msg:match('Upload failed'), 'failed upload keeps the file + says so')
postReply = { 200, '{"status":"flagged"}' }
check(official.retryUpload() == true, 'retry queued'); step(0.1)
check(official.state().last.status == 'uploaded', 'retry uploads')

-- another stage: official mode off, rules back -------------------------------------------------------------------------
core.loadStage('/rallyraid/stages/moab-sand-flats-ss1.json')
check(core._debug().official == nil and cfg.gameCrashResume.useOfficialRules == false and cfg.gameCrashResumeOfficial.firstPenaltyS == 15 * 60,
  'normal stage: official off, rules restored')

-- trace sizes for a short / medium / long stage (adaptive 5 s) -------------------------------------------------------------
local sizes = {}
math.randomseed(7)
for _, km in ipairs({ 20, 80, 150, 250 }) do
  local T = traceMod.new(1795716000)
  local lat, lon, hdg, kmh, odo, t = 23.5, 45.0, 0, 70, 0, 0
  local target = 70
  while odo < km do
    -- a piste: long straights, bends now and then, speed 30-120 km/h, a slow village / dune section sometimes
    if math.random() < 0.01 then target = 30 + math.random() * 90 end
    kmh = kmh + (target - kmh) * 0.05
    if math.random() < 0.02 then hdg = hdg + (math.random() - 0.5) * 120 else hdg = hdg + (math.random() - 0.5) * 3 end
    local m = kmh / 3.6 * 0.5
    lat = lat + m * math.cos(math.rad(hdg)) / 111195
    lon = lon + m * math.sin(math.rad(hdg)) / 102000
    odo, t = odo + m / 1000, t + 0.5
    traceMod.add(T, { clock = t, wall = 1795716000 + t, lat = lat, lon = lon, odoKm = odo, kmh = kmh, heading = hdg % 360 })
  end
  local txt = JSON_ENCODE(traceMod.export(T))
  sizes[#sizes + 1] = { km = km, minutes = math.floor(t / 60), points = #T.pts, bytes = #txt }
  print(string.format('  trace %3d km (%d min): %d points, %d KB JSON', km, t / 60, #T.pts, math.floor(#txt / 1024 + 0.5)))
end
WRITE_JSON('tests/fixtures/events/trace_sizes.json', sizes)

print(passes .. ' passed, ' .. fails .. ' failed')
return fails
