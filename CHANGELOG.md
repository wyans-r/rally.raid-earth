# Changelog

All notable changes to rally.raid Earth: the BeamNG mod (released on [GitHub Releases](https://github.com/wyans-r/rally.raid-earth/releases)) and the free stage builder website [rrearth.wyans.net](https://rrearth.wyans.net).

- **Mod versions** (like `0.3.0`) are downloads: put the new `rallyraid_earth.zip` in your mods folder.
- **Website updates** need no download: they are live on rrearth.wyans.net the day they are listed.
- Newest first. Dates are US Eastern time (ET). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
- **Unreleased** lists changes that are in the code on GitHub but not in a mod download yet.

## [Unreleased]

No unreleased changes at the moment.

## [0.3.1] - 2026-11-19

### Changed
- The in-game Planner app makes the same roadbooks as the website (roadbook 0.6.2): the drivable line round dunes with distances along it, dune fields only where the map shows sand, and the steady progress bar. It also goes round forest, woods and open water. The Roadbook app draws calculated headings with a C, like the website.
  - Technical: `mod/ui/modules/apps/RallyRaidPlanner/roadbook-gen.js` and `mod/ui/modules/apps/RallyRaidRoadbook/roadbook-render.js` = the website's files byte for byte; the Planner's bar uses the generator's `frac`; mod `VERSION` 0.3.1.

## Website update - 2026-11-19: dune roadbooks, Changelog tab

### Added
- **Dune roadbooks that drive like a real crew.** In a dune field the route goes the way a car really drives: between and round the big dunes and steep slip faces, crossing the ridges (cordons) at their lower saddles. Every distance in the book is measured along that driven line, so the kilometres are realistic (on the Erg er Raoui test stage, 112.8 km instead of 106.7 km on the straight line). The book stays easy to read: boxes only where the instruction changes, never one per dune dodged. It opens with DNX (dunes ahead, difficulty L1 to L3), warns of each big ridge (CROSS CORDON) and steep drop, and closes with END DUNES. Headings in the dunes are calculated CAPs (marked C) from box to box. When the builder suggests a waypoint type on a dune leg it offers a navigation waypoint (WPN); a type you set yourself is kept.
  - Technical: roadbook-gen 0.6.2. `planLegRecce` gives the sparse heading line and the boxes; `planLegDuneDrive` (A* on 30 m terrain cells: slope cost, slip faces over 60 % blocked, climbs cost more than descents, a light pull to the heading) gives the route and the distances; box CAPs come from the heading line (`ptNavCap`). Wider cordon check on the driven line.
- **Dune fields come from the map only.** A stretch counts as dunes only on, or within 500 m of, sand, dune or desert areas mapped in OpenStreetMap. The up-and-down height scan still sizes the dunes (L1 to L3) but never decides on its own, so hills and rough ground are no longer taken for dunes.
  - Technical: `duneNeedsSand`, `duneNearM` 500; OSM `natural=sand|dune|desert`, `landcover=sand`.
- **Changelog tab** on the website, on desktop and mobile, after the Guide tab. It shows this page.
  - Technical: `stage-builder/changelog.js` reads `CHANGELOG.md`, copied by `deploy.sh`.

### Fixed
- **The roadbook progress bar stays on screen and keeps moving.** It no longer empties or jumps back, it names each step (Dune fields, Planning the line, Reading the terrain, OpenStreetMap, Landmarks, Building boxes), and it keeps creeping while a map server is slow. The page no longer freezes in big dune fields: the dune check that took about 24 s of computer time on the Erg er Raoui stage now takes about 2 s.
  - Technical: progress events carry `frac` (0..1, only forward); `yieldUI()` between long steps; sand areas prepared once for fast inside / outside checks; landmark grid limited to cells the boxes use.

## Website update - 2026-11-19: Auto routing, switchbacks, vegetation

### Added
- **New routing menu for each leg**: Auto (the default), Primary Piste (roads), Piste (tracks), Traces (trails and two-track), Off-piste, and Follow my GPX (greyed out until you load a GPX file). Auto looks at what the straight line between two points runs along and routes on that, and the leg shows what it chose and why, e.g. "Auto → Traces (58% of the straight line runs along trails and two-track)". You can still pick a type for any leg yourself.
  - Technical: track-router 1.5.0 (`tierOf`, `classifyLine`, `autoOrder`, tier profiles); legs store `tier`, `auto`, `autoCov`, `autoTried` (docs/STAGE_FORMAT.md).
- **Auto never draws a straight off-piste line through trees, water, cliffs or ground steeper than 60 %.** It plans the line round them, and if there's no clear way round it takes a route on roads or tracks instead.
  - Technical: roadbook-gen 0.5.3 `checkLine` / `lineHazards` (OSM obstacles, ESA WorldCover, terrain tiles); forest costs 400x in the off-piste planner (was 6x), scrub 40x.
- Stages made with the ⚡ Auto stage generator have their legs marked Auto.

### Changed
- A route counts as a detour only when it is more than **2x** the straight line, and switchbacks no longer count against it: the route is measured at 50 m steps, and a stack of hairpins counts as the straight line through it.
  - Technical: track-router 1.6.0 `detourLen`; `roadDetourMax` 2x on that measure.
- Older stage files keep their routing. Their "tracks & paths" legs show as "Piste + Traces (older stage)".

### Fixed
- Trails with tight switchbacks connect: the router no longer cuts straight across the hairpins of the trail it starts on, snaps to the wrong side of a hairpin, or rejects winding mountain roads as detours. In tests, 96 of 100 switchback routes now connect (was 81), with about half the off-piste distance.
  - Technical: track-router 1.4.0 (same-network jumps cost 2x, ways that cross without a shared node are joined, one snap per pass of a way).

## Website update - 2026-11-19: trails and small roads

### Changed
- Tracks & paths routing prefers trails and tracks with switchbacks over cutting straight across: an off-piste stretch longer than 300 m now costs much more (e.g. the 3.8 km path above Ourika in the High Atlas routes fully).
  - Technical: track-router 1.2.0 (gaps over 300 m cost 3.0/m).
- Small roads, paved or not, are used instead of off-piste unless they double back or make a big detour. Primary and secondary roads are a last resort, and motorways are never used.
  - Technical: track-router 1.3.0.

## Website update - 2026-11-19: short share links

### Added
- **Short share links**: Share link in the stage builder and the roadbook editor copies a link like `https://rrearth.wyans.net/s/0bwpoqjWlsW5sZiYYHTxof` (about 50 characters instead of 10,000+), short enough for Discord and text messages.
- **Copy long link** still makes the old kind of link. Old long links open exactly as before, and Share falls back to a long link if a short one can't be made.
  - Technical: `/api/share` + `/s/<id>` Worker, KV `rrearth-shares`, 256 KB cap, per-IP rate limit (docs/SHORT_LINKS.md).

## [0.3.0] - 2026-11-19 (pre-release, not tested in game)

The mod download for this version is a **pre-release**: the repair fixes, the GPS app's RALLY mode, RECCE editing in the Planner app and unlimited recovers have not been tested in game yet. The website's download links still give v0.2.0. The roadbook and routing changes below went live on the website the same day.

### Changed
- **Three HUD apps instead of five**: GPS (its MENU now has REPAIR, Recover car, crash resume and RALLY mode), Planner (build a stage by driving it, plus the RECCE panel to fix a roadbook as you drive) and Roadbook (the reader only). Remove the old Repair and Rally apps from your HUD layout.
- **Recover car**: unlimited, allowed anywhere (the rule about the 1 km before the finish, the ASS, is gone). Each costs 15 min the first time in a rally and 30 min after that. The resets bar shows the count and the total penalty.
- **Bivouac**: an engine change takes 90 min of bivouac time plus a 2 h time penalty on the next stage.
- **Roadbooks** (generator 0.4.0 to 0.5.2, on the website too):
  - Notes match what BeamNG.Earth builds: rock notes (in dune fields too), valley, wadi and landmark notes, "FOLLOW TRACES" for minor tracks, and no phantom bumps or bridges.
  - At least 300 m between boxes. Closer notes are merged into one box ("AT 180 CROSS WADI"). Danger notes, junctions and speed zones are never dropped, and waypoints keep their own box.
  - Off-piste stretches inside track and road legs (the hop onto the road, gaps, the tail after it ends) go round obstacles and steep ground instead of straight across.
  - Lines can follow the ground between boxes, and the note says what to follow ("FOLLOW VALLEY FLOOR 2.1 KM", "SKIRT HIGH GROUND ON R"). Along a valley the line keeps to the valley centre unless it gets too steep.
- **Website**: "Generate name and description" also sets the stage id from the start and finish places (e.g. `abteh-to-msied`). Map-data requests in towns are smaller.
- In-mod links point to rrearth.wyans.net.

### Fixed
- Repairs: a wheel change sticks, no instant re-puncture after a wheel change, steering works after a suspension repair, and Recover only rights the car (no free repair).
- In-game bugs from 17 Nov: the GPS MENU, Repair and Planner apps, crash resume, and logging. Recce can fix an existing roadbook while you drive it.
- Roadbook tulip drawings with crossing ticks no longer fail.
- Website: stages whose longitudes had wrapped round the world (the map panned past 180°, e.g. lon -371) are corrected on load and re-routed, so road and track routing work again.
  - Technical: track-router 1.1.0 to 1.1.2.

## Website update - 2026-11-17: new address

### Changed
- The stage builder moved to **https://rrearth.wyans.net**. The old stagebuilder.wyans.net address redirects there and carries your saved work over once.

## [0.2.0] - 2026-11-17

First public release.

### Added
- Dakar-style rally raid for BeamNG.drive with BeamNG.Earth: a rally GPS with CAP and odometer that follows the FIM reveal rules, a scrolling roadbook, timed stages with penalties, and repairs.
- The GPS and Roadbook apps (driven on a full stage in game), with 9 default keys (Ctrl+Shift) for driving and buttons for the rest.
- 15 example stages with auto-generated roadbooks.
- The free stage builder and roadbook editor website (no login), with the examples grouped by place. The mod download is hosted on GitHub Releases, and the website's /mod and download links point there.
- EXPERIMENTAL / not tested in game: Repair, Recover car, crash resume, the Planner app, the GPS MENU, recce mode, and rally mode (the Rally app for multi-day rallies).
