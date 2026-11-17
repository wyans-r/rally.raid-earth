# The in-game planner (Rally Raid Planner app)

Build and edit a stage and its roadbook **inside BeamNG**, using the car as the pen: drive to a place, press a key,
and a waypoint or a roadbook box is put there. Save, and load the stage straight into the rally computer. The files
are the website's own (stage builder and roadbook editor on stagebuilder.wyans.net), in both directions.

## What it is made of, and why

| part | where | job |
|---|---|---|
| UI app "Rally Raid Planner" | `mod/ui/modules/apps/RallyRaidPlanner/` (`app.js`, `app.css`, `app.json`) | everything you see and every edit |
| `planner-core.js` | same folder | the stage document: the website builder's import / export / km / problems logic, plus the edits (add, insert, move, delete, leg modes, boxes at the car, offline roadbook) |
| `roadbook-gen.js` | same folder | **a byte-for-byte copy** of `stage-builder/roadbook-gen.js` (the website's roadbook generator, merge and change records); a test fails if the two differ |
| `roadbook-render.js` | loaded from the Roadbook app folder (already the website's copy) | draws the boxes, tulips and symbols |
| `rallyRaid/planner.lua` | `mod/lua/ge/extensions/rallyRaid/` | what only the game has: the car's position as lat / lon, the driven line, reading / writing files, loading a stage, keys |

**Why most of it is JavaScript in a UI app, not Lua.** The stage and roadbook files are made by the website's
JavaScript. Running *the same code* in the game's UI (BeamNG's UI is a Chromium browser, CEF) is the only way to be
sure a file saved in the game is exactly what the website would write, and that the website reads it back with no
"stage changed" warnings (the roadbook carries a SHA-256 hash of the stage, computed the website's way). Rewriting
the builder, generator, merge and hash in Lua would be a second copy to keep in step forever. Lua does only what a
UI page cannot: ask BeamNG.Earth where the car is, record the line every frame even with the UI closed, touch the
user folder, and load the stage into the rally computer.

**Positions are always lat / lon** (`beamngEarth_api.pose()`), never game x / y / z: BeamNG.Earth moves the world
under you as you drive (rebasing), so game coordinates are not stable. Heights come with the pose (the driven line
is `[lat, lon, alt]`).

**Reused from the mod:** the stage loader and its checks (`rallyRaid_core.loadStage`, the same as the stage picker),
the teleport to the start, `reloadRoadbook`, and the recce quick-pick symbol list (`recce.lua` `M.QUICK`). Recce
mode is untouched: it is still the way to *drive and verify* an existing roadbook; the planner is the way to *make*
one. Repair v1 is not touched.

## Offline vs internet

The game's UI may or may not reach the internet (it depends on the BeamNG build and your firewall; unknown until
tried). The planner checks (one map tile, 6 s timeout) and says "internet: yes / no" on the ROADBOOK tab.

| works with no internet | needs internet (in the game, or do it on the website) |
|---|---|
| new stage, points at the car (ADD / INSERT / MOVE HERE), types, names, DZ limits, order, delete, undo | **ROAD legs** (routing along roads, OSRM server). Offline the leg falls back to a straight line and says so |
| **driven legs** (REC on: the leg follows the line you drove) and straight legs | the **full roadbook**: elevation tiles, OpenStreetMap junctions / fords / gates / villages, landmarks, land cover, the planned off-piste line |
| an **offline roadbook**: a box per waypoint, the tulip from the route's turns, and climbs / descents / crests from the heights you drove (`partial: "driven-heights"`); with no driven heights, route-only (`partial: "route-only"`) | |
| adding / moving / deleting boxes at the car, notes, danger, symbols, tulip angle | |
| save, open, drafts, load into the game | |

Online, GENERATE runs the website's full generator in the game (the roadbook is the same as the website's for the
same stage). **REGEN, KEEP EDITS** regenerates and keeps every box you edited (the website's merge). A good habit
when the game has no internet: build and drive the stage in the game, save, open the stage on the website, make the
full roadbook there (Roadbook button), save the `.roadbook.json` into the game's `rallyraid/roadbooks/` folder, then
fine-tune boxes in the game.

## Files

Written to the BeamNG user folder (`<user>/current/rallyraid/...`), the folders the mod already reads:

| file | what |
|---|---|
| `stages/<id>.json` | the stage, exactly the website builder's format (`docs/STAGE_FORMAT.md`). `generator` gets `; rallyraid-ingame-planner 0.1.0` appended |
| `roadbooks/<id>.roadbook.json` | the roadbook, the website editor's format (`docs/ROADBOOK_FORMAT.md`), with `ingame: {mode, at, by, offlineReason}` when the planner generated it. Box edits are change records with `by: "editor"`, `note: "in-game planner"`, so the website editor shows them as edited and keeps them on regenerate |
| `planner/drive/<id>.drive.json` | the heights you drove (`{format: "rallyraid-planner-drive", schemaVersion: 1, stage, points: [[lat, lon, alt], ...]}`), for offline roadbooks later. The website ignores it |
| `planner/drafts/<id>.draft.json` | unsaved work, written 4 s after each change (`{format: "rallyraid-planner-draft", stage, roadbook, drive}`); FILES > RESTORE |
| `planner/backup/<name>.<YYYYmmdd_HHMMSS>.json` | a copy of any file the planner overwrites |

Lua only writes `.json` files under `/rallyraid/`, checks that the text is valid JSON before writing, and moves text
across in 30 000-character pieces with non-ASCII characters escaped (`\uXXXX`), which the website reads the same.
Fields the planner does not know (from newer website versions) are kept as they were. A website stage opened and
saved without changes in the planner comes back identical apart from `generator` and `modified` (tested on all 30
shipped stages, and in the browser test).

## Keys and commands

| key | action | command |
|---|---|---|
| Ctrl+Shift+J | open / close the planner (or click its bar) | `rallyRaid_core.cmd('plannerMenu')` |
| Ctrl+Shift+W | add the next point where the car is (the type in the ROUTE tab's list; after the DSS a WPV; after an ASS the old ASS becomes a WPV) | `cmd('plannerWaypoint')` |
| Ctrl+Shift+B | a roadbook box where the car is on the route (within 300 m) | `cmd('plannerBox')` |
| Ctrl+Shift+K | record the driven line on / off | `cmd('plannerRec')` |

The keys need the app on the HUD (without it the game says so); W and B open the panel if it is closed, K works
with it closed. Rebind them in Options > Controls (category
gameplay, "Rally Raid: planner ..."). Other commands: `plannerOpen`, `plannerClose`, `plannerAppHere` (the app says
it is on screen). The app talks to Lua with `rallyRaid_core.plannerCall(name, argsJson, text)` (`pose`, `mark`,
`rec`, `list`, `exists`, `readOpen` / `readChunk`, `writeBegin` / `writeChunk` / `writeCommit`, `load`,
`reloadRoadbook`, `state`); Lua sends the UI events `RallyRaidPlanner` (state: pose, recording, the loaded stage,
4 a second while open) and `RallyRaidPlannerKey` (`{key: "waypoint" | "box"}`).

## Rules of thumb built in

- A leg is **driven** (follows your recorded line) when REC was on since the previous point and the line starts
  within 300 m of it; otherwise **straight**. Change any leg to ROAD (needs internet) or STRAIGHT in the point editor.
- MOVE HERE more than 150 m straightens the legs either side (the old driven line no longer fits); re-drive or ROAD.
- INSERT HERE puts the point on the nearest leg (within 200 m), splitting a driven line where you are.
- A teleport or a reset more than 250 m away breaks the recorded line (no straight line across the jump).
- Waypoint boxes cannot be deleted (delete the waypoint in ROUTE instead).
- "SAVE + LOAD IN GAME" refuses a stage with errors (the list under ROUTE says what), and asks before replacing a
  stage that is running.

## Only checkable in the real game

The browser test (`tests/browser/planner_app_test.js`) runs the real app against a fake game, and
`tests/planner_test.lua` runs the real Lua against a fake BeamNG. Not checkable outside the game:

1. Whether the game's UI has internet (tiles, OSM, OSRM), or blocks it.
2. Whether `crypto.subtle` exists in BeamNG's UI (if not, the app's own SHA-256 is used: tested to give the same hash).
3. `readFile` / `writeFile` / `FS:getUserPath` / `FS:findFiles` behaving as in the shipped BeamNG Lua.
4. `bngApi.engineLua` returning 30 000-character answers, and the long-string quoting through it.
5. Whether typing in the app's text boxes also triggers game keys (BeamNG normally blocks this while a text box has
   focus); key clashes with your own bindings.
6. Speed of the full roadbook generation inside the game (a long stage can take tens of seconds; the bar fills).
7. The app's size and scaling on your screen; the map is drawn without tiles (lines and points only).
8. BeamNG.Earth's `pose()` heights being ground height (they are used for climbs / crests offline).
