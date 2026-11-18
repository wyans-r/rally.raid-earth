# Retest: 17 Nov bug batch (test zip `rallyraid_earth_fix1117_test.zip`)

Test build, not a release. Remove the old rally.raid Earth zip from `mods/`, put this one in, and start the game.
Each item takes under 5 minutes. Before you start, open the console (`~`) and type `rallyRaid` in its filter box. Every line
from this mod starts with **`[rally.raid Earth]`**.

**Screenshot rule:** if a step fails, take one screenshot of the screen (apps visible) and one of the `~` console
(the last 20 lines with `[rally.raid Earth]`, and any red lines).

## 0. Start (1 min)

1. Load a BeamNG.Earth map, free roam.
2. Console: look for `[rally.raid Earth] rally.raid Earth 0.2.0 loaded (rally mode in this build, ...)`, then
   `rally ledger: ...` and `crash saves on disk ...: N`.
3. In the GPS app: press **MENU** > **RALLY LAYOUT**. The screen should switch to a layout with GPS, Roadbook, Repair and Rally.
   - Console: `cmd appsRally (gps)`, `app layout -> rallyRaidEarth`, then `app on screen: repair` (and `rally`).
   - Screenshot this layout either way.
   - **MY LAYOUT** takes you back to your own layout.

## C. GPS MENU buttons, Repair app (4 min)

1. In the GPS: **MENU** > **REPAIR**. The Repair app should open its panel ("NO REPAIRS HERE ..." outside a stage).
   - Console: `UI gps: MENU REPAIR pressed (Repair app on screen)`, `cmd repairOpen (gps)`, `repair menu opened`.
2. The Repair app is not blank when closed. It shows a **REPAIR** button plus a short line saying when repairs open. Press its
   button to open it and **CLOSE** to close it.
3. **MENU** > **PLANNER**. The Planner app opens (use PLANNER LAYOUT if the Planner app is not on screen).
   - With an app not on screen, the GPS shows "The X app is not on your screen. Add it with ... or press ... LAYOUT".
     It must not silently do nothing.
4. In a running stage: **MENU** > **RECOVER** shows the penalty, then **CONFIRM** recovers the car. Outside a stage
   RECOVER is greyed out, as designed.
   - Screenshot: the open MENU, and the console lines.

## D. Planner (4 min)

1. **MENU** > **PLANNER LAYOUT** (GPS, Roadbook, Planner).
2. In the Planner, with no stage loaded, press **PLANNER**. You should see a start panel with **NEW STAGE HERE** and **OPEN A FILE**.
   Press **NEW STAGE HERE**: a stage with a DSS at the car appears. Drive about 300 m and press **ADD HERE**: a waypoint is added.
3. Load a stage in the GPS (**STAGES** > pick > LOAD). The Planner bar says `game: <stage name>`. Open the planner and press
   **EDIT LOADED STAGE: <name>**: the stage's waypoints show.
   - Console: `UI planner: app init`, `app on screen: planner`, `cmd plannerOpen (planner)`, `UI planner: NEW STAGE HERE`.
   - Screenshot: the start panel, and the planner with the loaded stage.
4. Recce (only look): read `docs/RECCE_REVIEW.md` and say which items you want. No recce changes in this build.

## F. Crash resume (5 min)

1. Load a stage, **TP TO DSS**, **START**, and drive at least 45 s past the start (the first save is at 30 s of stage time).
   - Console: `crash save 1 written: ...json (timer, stage clock 0:00:30, ...)`. **If this line never shows**, stop and
     screenshot the console. Look for `crash save FAILED` or `crash save (...) not possible now: ...`.
2. Force close the game (Task Manager > End task) while the stage is running.
3. Start the game again, same map, free roam.
   - Console: `crash saves on disk (...): 1, newest: <stage> saved ... ago`.
4. GPS **MENU**: a **CRASH SAVE** row with the stage name and a **LOAD** button. Press **LOAD** (or load the stage
   from STAGES as you did on 17 Nov).
   - Console: `crash save: looking for ...`, then `crash save OFFERED: ...`.
   - The GPS MENU opens with **RESUME?** Press **RESUME**, then **CONFIRM RESUME**. The car goes back to the saved place,
     and the clock is held until **GO**.
   - Screenshot: the RESUME offer, and the console from "crash saves on disk" to "OFFERED" (or "crash save: none ...").

## E. Rally mode (quick, 3 min)

1. In the RALLY LAYOUT, the Rally app shows "RALLY no rally loaded EXPERIMENTAL" and a list of rallies (REFRESH if it is empty).
2. Tap **Atlantic to Atlas** in the list. Day 1 and its first liaison show. Press **DRIVE** (or TELEPORT), then **LOAD STAGE** and **TP TO DSS** when the app offers them.
   - Console: `cmd rallyLoad "/rallyraid/rallies/atlantic-to-atlas-2027.rally.json" (rally)` and more `cmd rally... (rally)` lines, with no red errors.
   - Screenshot the Rally app after LOAD.

## Send back

For each of C, D, F and E: OK / not OK. Include the screenshots of anything that was not OK, plus the `~` console
lines starting with `[rally.raid Earth]`.
