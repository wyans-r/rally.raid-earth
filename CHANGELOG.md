# Changelog

All notable changes to rally.raid Earth: the BeamNG mod (released on [GitHub Releases](https://github.com/wyans-r/rally.raid-earth/releases)) and the free stage builder website [rrearth.wyans.net](https://rrearth.wyans.net).

- **Mod versions** (like `0.3.0`) are downloads: put the new `rallyraid_earth.zip` in your mods folder.
- **Website updates** need no download: they are live on rrearth.wyans.net the day they are listed.
- Newest first. Dates are US Eastern time (ET). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
- **Unreleased** lists changes that are in the code on GitHub but not in a mod download yet.

## [Unreleased]

### Added
- **Changelog tab** on the website, on desktop and mobile, after the Guide tab. It reads this file, so each deploy updates it with no extra step. It goes out with the next public deploy of the site.
  - Technical: `stage-builder/changelog.js`, `CHANGELOG.md` copied by `deploy.sh`.
- **Rally viewer** (preview): a page that shows a whole rally on one map — every special stage and the prologue, the liaisons, transfers (the 590 km sea crossing is drawn as a dashed teleport), bivouacs, the rest day and marathon flags. Click a day to highlight it and zoom in, or open that stage in the builder. Load a bundled rally with `?rally=`, or drop in a `.rally.json` file. Atlantic to Atlas 2027 is bundled on the preview. A short share link (`/r/<id>`) can store the compiled rally file (preview lines, not full stage tracks); the 256 KB cap is enough (this rally is about 43 KB compressed). The event stays hidden on the live builder until it is validated.
  - Technical: `/rally.html`, `rally-view.js`; worker `kind=rally`; `EXAMPLE_FLAGS.rallyEvents` stays false.
- **In a dune field, the roadbook path is a recce line, not a weave around every dune.** It stays on the heading between boxes, or follows a broad trough between dunes only when one really runs along that heading for a long stretch. Big dune ridges and steep faces get caution notes (DNX, difficulty L1–L3, CROSS CORDON, STEEP FACE / STEEP DROP) instead of the line dodging them; the competitor picks their own line. Off-piste headings are written as calculated CAP (C). Inside dunes the usual 300 m minimum and box density are relaxed, so gaps between boxes can be long. When the builder suggests a waypoint type on a dune leg, it offers a navigation waypoint (WPN); a type you already set is left alone. Distances in the book are along this recce line.
  - Technical: roadbook-gen 0.6.0 (`planLegRecce`, OSM `natural=sand`/`dune` plus the height-reversal test). Preview only until this is put live; the Planner copy updates with the next mod release.
  - A dune field is OpenStreetMap sand or dune polygons, or the same up-and-down height test used for DNX notes. A single isolated ridge is still crossed at its saddle.

### Fixed
- **The roadbook progress bar no longer empties or jumps back while it works, and the page no longer freezes in dune fields.** The bar now only moves forward, names each step (Dune fields, Planning the line, Reading the terrain, OpenStreetMap, Landmarks, Building boxes) and keeps creeping while a map server is slow. Dune stages are much faster: the Erg er Raoui stage took about 24 s of computer time with the page frozen for up to 10 s; it now takes about 2 s. Roadbooks come out exactly the same.
  - Technical: roadbook-gen 0.6.1. Progress events carry `frac` (0..1, monotonic); `yieldUI()` between the long steps; the sand index prepares each polygon once (latitude-banded edges) instead of copying the whole ring on every point test; landmark grid limited to the cells the boxes use; landmark polygons checked against their bounding box first; the optional sand query gives up after one round of mirrors.

### Changed (mod)
- The in-game Planner app's roadbook generator now matches the website's (0.6.0): it goes round forest and woods, ESA WorldCover tree cover and open water, treats heavy vegetation as practically impassable, and in dune fields it writes a recce line with caution notes instead of weaving. This reaches players with the next mod release.
  - Technical: `mod/ui/modules/apps/RallyRaidPlanner/roadbook-gen.js` = `stage-builder/roadbook-gen.js` 0.6.1.

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
