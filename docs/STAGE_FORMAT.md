# rally.raid Earth stage format (schema version 1)

One stage is one UTF-8 JSON file (`<id>.json`). The stage builder writes it, the game mod reads it, and the future
roadbook tool reads it too. It is meant to be shared: send the file, the other player drops it in their stages folder.

**Golden rule: positions are WGS84 latitude / longitude in decimal degrees, never game coordinates.** BeamNG.Earth
moves the game world's origin (a "rebase") about every 15 km, so a game x / y goes stale; a lat / lon never does.
The mod converts nothing: it compares the player's `beamngEarth_api.pose()` lat / lon with the file's.

## Top level

| field | type | required | meaning |
|---|---|---|---|
| `format` | string | yes | always `"rallyraid-stage"` |
| `schemaVersion` | int | yes | `1`. A reader refuses a file with a higher number than it knows. Additions that old readers can ignore keep `1`; changes that break them raise it |
| `id` | string | yes | short unique name, `[a-z0-9-]`, at most 60 characters, also the file name (`moab-sand-flats-ss1`). The builder's "Generate name and description" sets it from the start and finish places (`abteh-to-msied`, `tan-tan-loop`; accents dropped; a region, then the start coordinates when no place name is found; `-2`, `-3` when an example already uses it) |
| `name` | string | yes | what the HUD shows (`SS1 Moab Sand Flats`) |
| `region`, `author`, `description`, `vehicleClass` | string | no | shown to players |
| `created`, `modified` | ISO 8601 UTC | no | |
| `generator` | string | no | the tool and version that wrote the file |
| `dataSource` | string | no | `OpenStreetMap contributors (ODbL), routed with OSRM` |
| `lengthKm` | number | no | stage length along the route, DSS to ASS |
| `start` | `{lat, lon}` | no | where "TP TO DSS" puts the car (default: the DSS itself) |
| `rules` | object | no | rule overrides, see below. Missing values take the FIM 2026 defaults |
| `waypoints` | array | yes | the GPS waypoints, in the order they must be taken, see below |
| `roadbook` | object | no | the roadbook boxes, see below |
| `route` | object | no | the plotted route geometry (for the builder, a roadbook tool, a map); the game does not need it |
| `builder` | object | no | builder-only data; readers ignore it. `builder.stagegen.chain` (B10) is on stages Stage-Gen built as a chain of parts (special stages over ~185 km, stage-builder/stage-chain.js): `{version, layout: {junctions, ratio}, seed, segments: [{k, inputs, km, option, dataHash, stats}]}`. Such a stage is an ordinary stage file: one DSS, one ASS, continuous km, each junction between parts a `WPV` waypoint named `Junction k` |

## `waypoints[]`

The first must be `DSS`, the last `ASS`. A `DZ` must be followed (later) by an `FZ` before another `DZ` or the `ASS`.

| field | type | required | meaning |
|---|---|---|---|
| `id` | string | yes | stable id (the roadbook links to it) |
| `n` | int | no | number shown on the GPS (`WPM 4`). Builder: DSS = 0, then 1, 2, ..., ASS = last |
| `type` | string | yes | `DSS`, `WPV`, `WPE`, `WPM`, `WPN`, `WPS`, `WPC`, `WPP`, `DZ`, `FZ`, `ASS` |
| `lat`, `lon` | number | yes | WGS84 degrees (6 decimals = ~0.1 m) |
| `km` | number | no | roadbook distance from the DSS along the route. Missing: straight-line sum. The trip odometer is set to this when the waypoint is validated (`rules.tripSnapToWaypoint`) |
| `cap` | int | no | heading (degrees true) leaving this point along the route |
| `name` | string | no | |
| `speedLimit` | number | DZ only | km/h for the zone that starts here |
| `validate` | number | no | this waypoint's own validation radius (m), overrides the type's |
| `revealRadius` | number | no | this waypoint's own opening radius (m) |
| `reveal` | string | no | this waypoint's own reveal mode |
| `penalty` | number | no | seconds when missed, overrides the type's |
| `box` | int | no | the roadbook box `n` for this waypoint |

## `rules`

Anything left out takes the default. Defaults = 2026 FIM World Rally-Raid Championship sporting regulations,
Art. 11.2 (waypoints) and Art. 16 (speed control zones).

```json
"rules": {
  "preset": "FIM-2026",
  "waypoints": {
    "DSS": {"reveal": "prev",         "radius": 1000, "validate": 200},
    "WPV": {"reveal": "always",                       "validate": 200, "penalty": 900},
    "WPE": {"reveal": "prev",         "radius": 1000, "validate": 90,  "penalty": 900},
    "WPM": {"reveal": "radius",       "radius": 800,  "validate": 90,  "penalty": 900},
    "WPN": {"reveal": "radius",       "radius": 800,  "validate": 200, "penalty": 3600},
    "WPS": {"reveal": "radius",       "radius": 1000, "validate": 30,  "penalty": 900},
    "WPC": {"reveal": "never",                        "validate": 300, "penalty": 900},
    "WPP": {"reveal": "radius",       "radius": 100,  "validate": 20,  "penalty": 120},
    "DZ":  {"reveal": "radiusOrPrev", "radius": 1000, "validate": 90,  "penalty": 900},
    "FZ":  {"reveal": "prev",         "radius": 1000, "validate": 90,  "penalty": 900},
    "ASS": {"reveal": "radius",       "radius": 800,  "validate": 90}
  },
  "speedZone": {"tolerance": 90, "warnBefore": 90, "alertMargin": 5, "impulseDistance": 150, "impulseTime": 10,
    "bands": [{"upTo": 5, "penalty": 10}, {"upTo": 15, "penalty": 60}, {"upTo": 40, "penalty": 120}, {"upTo": null, "penalty": 360}]},
  "globalMaxKmh": null, "globalImpulsePenalty": 60,
  "lookahead": 5, "tripSnapToWaypoint": true,
  "startMode": "auto", "countdown": 5, "falseStartPenalty": 60
}
```

Reveal modes (when the GPS shows distance DTW and heading CTW to the waypoint; before that only its type and number):

| mode | shown |
|---|---|
| `always` | all the time |
| `never` | never (WPC: only its number) |
| `radius` | within `radius` m |
| `prev` | once the previous waypoint is validated; within `radius` m if it was missed |
| `radiusOrPrev` | within `radius` m, or at once when the validated previous waypoint is less than `radius` m away |

Penalties are seconds. `DSS` / `ASS` have none: the clock starts at the DSS and stops at the ASS.

Speed zones: the zone is live from leaving the DZ's `tolerance` circle to entering the FZ's. While over the limit by
1 km/h or more, an "impulse" is recorded at once and then every `impulseDistance` m or `impulseTime` s, each charged by
`bands` (km/h over -> seconds). `globalMaxKmh`: a category limit everywhere; impulses from the second on cost
`globalImpulsePenalty` s each.

Other: `lookahead` = how many waypoints past the current one can be validated (taking a later one marks the skipped
ones missed). `startMode` `auto` starts the clock when the car leaves the DSS circle; `countdown` only via START.

## `roadbook`

```json
"roadbook": {
  "file": null,
  "boxes": [
    {"n": 1, "id": "dss", "km": 0.0, "partial": 0.0, "cap": 211, "waypoint": "dss", "label": "DSS",
     "lat": 38.567602, "lon": -109.531389}
  ]
}
```

The stage's `roadbook.boxes` only say **where** the boxes for the stage's own points are (each waypoint and each
roadbook-only NOTE point). The roadbook itself (notes, symbols, tulips, danger, all the boxes in between) lives in a
separate file made in the roadbook editor, `<stage id>.roadbook.json` (docs/ROADBOOK_FORMAT.md), so there is one
place for roadbook text and nothing to keep in step.

| field | meaning |
|---|---|
| `n` | box number, 1..N in route order |
| `id` | stable id |
| `km` | cumulative roadbook distance from the DSS (what the trip odometer should read at the box) |
| `partial` | km since the previous box |
| `cap` | heading leaving the box (degrees true) |
| `waypoint` | the `waypoints[].id` at this box, or null for a plain navigation box |
| `label` | `WPM 4`, `NOTE` ... |
| `lat`, `lon` | where the box is (handy for a roadbook editor; never shown to the driver) |
| `notes` | **deprecated** (stage files made before the roadbook editor): instruction text. Still read: the roadbook generator moves it into the roadbook as a pinned, editor-source box at that point, and the game shows it only when the stage has no `.roadbook.json`. The builder no longer edits it; it passes text from an older file through unchanged and writes nothing for new points |
| `danger` | **deprecated**, as `notes`: 0-3 (`!`, `!!`, `!!!`) |
| `tulip` | **deprecated / unused**: tulips are in the roadbook file |
| `file` | optional: the roadbook file for this stage (a path; without a leading `/`, relative to `rallyraid/roadbooks/`). Without it the game looks for `rallyraid/roadbooks/<stage id>.roadbook.json`, then `<stage file name>.roadbook.json` next to the stage |

The roadbook project can add fields to a box; readers must ignore fields they do not know.

## `route`

```json
"route": {"legs": [{"from": "dss", "to": "dz1", "mode": "road", "km": 1.557, "points": [[38.5676, -109.5313], ...]}]}
```

`mode`: `road` (routed on OpenStreetMap roads with OSRM's car profile, which skips most small tracks), `direct` (off-piste: straight, or, with `planned: true`, the roadbook planner's driven line through several points, see ROADBOOK_FORMAT.md), `track`
(along a track: in the web builder, "tracks & paths" = small OpenStreetMap ways (highway=track, unclassified, unpaved service / lanes, path and bridleway at a higher cost since BeamNG.Earth does not build them, and since 18 Nov 2026 (track-router 1.1.0) village streets, residential, tertiary and secondary roads at a higher cost still, only to link track networks (track-router 1.1.1: only where unpaved or with no surface tag, which keeps the query small in towns); primary and bigger never) found through Overpass,
or, with `"via": "gpx"`, "my loaded GPX track" = along an imported GPX track; in the in-game planner, the driven line). One leg per consecutive pair of points, roadbook-only boxes included.

Optional leg fields written by the builder (readers ignore them; older files without them still load, and an older `track` leg keeps its saved points until one of its ends moves):
`via: "gpx"` (followed the loaded GPX track), and on a "tracks & paths" leg `cover: {"onKm": 6.52, "straightKm": 0.77, "gaps": [[201, 203]]}`:
how much of it is on mapped ways, how much is drawn straight (short hops to reach a way, and gaps where no mapped way connects), and the gaps as `[from, to]` indexes into `points`.
Since 18 Nov 2026 a `track` or `road` leg may also carry `off: [[from, to], ...]`: the off-piste runs of the leg as indexes into `points` (on a road leg the hop from the waypoint onto the road and off it at the end, which used to be hidden in the first / last road segment; on a track leg the same as `cover.gaps` once planned). A run of one segment is a straight hop; a longer run was planned round obstacles by the builder (the roadbook keeps it as drawn).

## Roadbook sync (the game side)

The rally computer exposes its state so a roadbook (in-game app or outside program) can follow it.

**Which boxes the game uses.** When a stage is loaded the mod looks for its roadbook file (see `roadbook.file`
above). Found and valid (format `rallyraid-roadbook`, made for this stage id): its live boxes (deleted ones dropped,
sorted by km, renumbered) are the roadbook, and every waypoint's `km` is taken from its waypoint box, so the trip
snaps to the distances printed in the roadbook. If the roadbook's recorded stage length differs from the stage by
more than 200 m, a warning says it should be re-synced in the editor. Not found: the stage's own `roadbook.boxes`
(with any deprecated `notes`) are used as before. `cmd('reloadRoadbook')` re-reads the file during a stage.

1. **UI event** `RallyRaidRoadbook`, about 10 a second, for a UI app (`scope.$on('RallyRaidRoadbook', ...)`):

   ```json
   {"schema": 1, "stageId": "moab-sand-flats-ss1", "phase": "running", "trip": 7.84, "partial": 1.21, "total": 34.7,
    "countDown": false, "cap": 87.4, "speed": 92.3, "clock": 754.3, "boxIndex": 4, "box": 4, "nextBox": 5,
    "toNextBox": 1.16, "lastWaypoint": {"n": 3, "type": "WPV", "km": 6.004}, "lat": 38.58, "lon": -109.47,
    "boxCount": 139, "viewIndex": 4, "manual": false, "roadbookFile": "/rallyraid/roadbooks/moab-sand-flats-ss1.roadbook.json",
    "view": [{"n": 4, "km": 6.0, "partial": 0.8, "cap": 87, "label": "WPV 3", "notes": "...", "danger": 1,
              "symbols": ["crest"], "tulip": {"entry": {"track": "track"}, "exit": {"angle": 30, "track": "track"}, "branches": []},
              "offPiste": false, "current": true}, "... the next 3 boxes"]}
   ```
   `box` = the last box whose `km` is at or below the trip, `toNextBox` = km to the next one. `view` = the boxes on
   the roadbook display: from the current box on, or from where the driver scrolled to (`manual: true`, box up /
   down). Scrolling never changes the trip; any trip change (adjust, reset, set, sync) or driving up to the
   scrolled-to box returns the display to the odometer.
2. **Game hooks** for another Lua extension (define the function, it is called): `onRallyRaidTick(state)` (the same
   table, 10 a second), `onRallyRaidStageLoaded`, `onRallyRaidStageStart`, `onRallyRaidWaypoint({index, n, type,
   status = 'ok'|'missed', clock, trip, km})`, `onRallyRaidSpeedImpulse`, `onRallyRaidTripChanged({trip, reason})`,
   `onRallyRaidStageFinish(result)`.
3. **Commands** to the computer: `rallyRaid_core.cmd(name, arg)` with `tripPlus`, `tripMinus` (arg: metres),
   `tripReset`, `tripSet` (km), `partialReset`, `countDown`, `syncBox` (box `n`: sets the trip to that box's `km`,
   the "I'm at box 37" correction), `boxNext` / `boxPrev` (scroll the roadbook display one box), `boxSync` (trip :=
   the km of the box at the top of the display), `reloadRoadbook`, `wPlus`, `wMinus`, `start`, `abort`, `load` (path),
   `teleport`, `unload`. Keys: Ctrl+Shift+Up / Down trip +/-, Ctrl+Shift+PgUp / PgDn box up / down, Ctrl+Shift+End
   box sync, Ctrl+Shift+P partial reset, Ctrl+Shift+Left / Right W- / W+, Ctrl+Shift+Home start (the only default keys;
   `keys` pushes guihook `RallyRaidKeys` = { keys = { action = 'Ctrl+Shift+End', ... } }, the player's actual bindings).
   Recce mode (docs/ROADBOOK_FORMAT.md *Recce*): `recce` (on / off), `recceNew`, `recceDrop`, `reccePick` ({symbol |
   danger | notes}), `recceSave`, `recceCancel`, `recceConfirm` / `recceMove` / `recceRetag` / `recceDelete` (nearest
   box, or arg = box id), `recceUndo`, `recceMerge` (arg `'rescale'`). No default keys (the Planner app's RECCE panel has
   the buttons; it was in the Roadbook app until 18 Nov); a player can bind the rallyRaid_recce* actions. `roadbookState().recce` carries the recce panel's data.
   In-game planner (`docs/INGAME_PLANNER.md`): `plannerMenu`, `plannerOpen`, `plannerClose`, `plannerWaypoint`,
   `plannerBox`, `plannerRec`, `plannerAppHere`; the app's own calls go through
   `rallyRaid_core.plannerCall(name, argsJson, text)`. No default keys (the Planner app's buttons, and PLANNER in
   the GPS app's MENU); a player can bind the rallyRaid_planner* actions. Stages saved by the planner are this format; `generator` ends in
   `rallyraid-ingame-planner <version>`.
   `rallyRaid_core.roadbookState()` and `rallyRaid_core.getState()` return the current tables.
4. **Outside the game** (a tablet / second screen): turn on `liveFile` (`rallyRaid_core.cmd('liveFile')`, kept in
   `<user>/current/settings/rallyRaid.json`) and the mod writes the same table to `<user>/current/rallyraid/live.json`
   twice a second. BeamNG.Earth's companion feed (`http://127.0.0.1:47615/v1/pose`, `/v1/stream`) already gives the
   position and speed to programs beside the game; a roadbook program can combine both. A small HTTP bridge is a
   possible next step.

## Results file

Written at the ASS to `<user>/current/rallyraid/results/<id>_<YYYYmmdd_HHMMSS>.json`:
`format: "rallyraid-result"`, `schemaVersion: 1`, `stageId`, `stageName`, `startedAt`, `finishedAt` (UTC),
`stageTime`, `penaltyTime`, `totalTime` (s), `penalties[] {kind, seconds, detail, t}`, `waypoints[] {n, type, status,
time, km, trip}`, `speedImpulses`, `distanceDriven` (km), `vehicle`, `flags {teleported, positionJump}` and
`official` (false after a teleport or position jump during the stage, with the Individual Part Repair mod loaded, or
after retiring from the rally).

Repair fields (docs/REPAIR.md): `repairs[]` (each mid-stage repair: `label`, `items[] {id, minutes, damage, flat}`,
`minutes`, `penaltyS`, `sparesUsed`, `t`, `km`, `lat` / `lon`, the part `spec`, `damageBefore` / `damageAfter` per
group, `engineFlagsNotRestored`), `repairTime` (s), `sparesUsed`, `resets[]` (resets the app did not make: `kind`,
`t`, `km`, `lat` / `lon`, `distToFinishM`, `stageCount`, `rallyCount`, `penaltyS`, `outcome` penalty | retired,
`reason`), `resumes {stage, rally, maxPerRally, maxPerStage, log[]}`, `bivouac` (the bivouac closed when this stage
started: `afterStage`, `usedMin`, `budgetMin`, `overMin`, `overrunPenaltyS`, `engineChanges`, `engineChangePenaltyS`,
`retired`, `log[]`, `resets[]`), `rally {id, retired}`, `retired` (why the stage was retired, if it was) and
`repairRules` (the values used). Penalty kinds added: `repair`, `resume`, `carRecovery`, `gameCrashResume` (only with the official rules switched on),
`bivouacOverrun`, `engineChange`. Flags added: `unauthorizedReset` (count), `bivouacResets`, `ipr`, `rallyRetired`,
`retired`, `gameCrashResume` (count), `reviewRequired`, `restartedAfterGameCrash` (count). Top level:
`reviewRequired: true` when an organizer should look at the result (a game-crash resume or a restart after one).

Recover car fields (docs/REPAIR.md "Recover car"; called "crash resume" before 2026-11-16): each recovery is in
`resumes.log[]` with `kind: "carRecovery"` and a `resume` object: `from` (where the car got stuck: `lat` / `lon`, `d` m
along the route, `offRouteM`), `to` (`lat` / `lon`, `heading`, `d`, `km`, `backM`, `fromCarM`), `snapshot` (the
recovery state used: `id`, `clock`, `ageS`, `lat` / `lon`, `routeD`, `trip`, `progress {target, lastOk, states[]}`;
none if there was none yet), `damageFrom` (`snapshot` | `now`), `damageAfter` per group, `stats`, `fuel`,
`engineFlagsNotRestored`, `far` (BeamNG.Earth's teleport used first), `pausedS` (how long the clock was stopped),
`headingOffDeg`, `landedOffM`, `tripKmBefore`. `carRecovery {attempts[], snapshotsTaken, lastSnapshots[], rules}`:
every attempt (`kind` resumed | refused | failed | retiredByDriver, `reason`, `t`, `at`, ...), how many recovery states
were taken, the last ones kept (`id`, `clock`, `good`, `why`, `km`, `offRouteM`) and the `carRecovery` values from
repairConfig.lua.

Game-crash resume fields (docs/REPAIR.md "Game-crash resume"): `gameCrashResume {resumes[], count, flagged, review[],
discardedBefore[], savesWritten, saveFails, lastSaveAt, rules}`. Each entry of `resumes[]` (`kind: "gameCrashResume"`,
or `"gameCrashResumeRetired"` when the official limits retired the stage) has `review`, `resumedAt` / `resumedEpoch`
(real time, UTC), `savedAt` / `savedEpoch`, `saveReason` (start | timer | event | resumed | quit | level left),
`saveSeq`, `saveUsed` (1 = newest save, 2 / 3 = older ones after a corrupt file) and `savesSkipped[] {file, why}`,
`wallGapS` (save to resume), `lastAlive {at, epoch, clock}` + `stageTimeLostS` + `crashWithinS` + `wallGapSinceAliveS`
(from the heartbeat file), `cleanExit` (the game was closed, not crashed), `rallyCount`, `stageCount`, `penaltyS`,
`saved` and `resumed` (`clock`, `target`, `validated`, `missed`, `penaltyTotal`, `penalties`, `sparesUsed`,
`repairTimeS`, `repairs`, `recoveries`, `gameResumes`, `trip`, `lat` / `lon`, `heading`, `damage` per group,
`vehicle`), `diff` (`positionM`, `headingDeg`, `clockS`, `penaltyS`, `validated`, `sparesUsed`, `damageMaxDiff`,
`sameVehicle`), `damageRestored`, `carDataAgeS`, `carSkipped`, `engineFlagsNotRestored`, `stats`, `far`, `respawned
{from, to}`, `clockReleasedBy` (drove off | confirmed), `heldRealS`, `rules` and a one-line `summary`.

The game-crash save itself is `<user>/current/settings/rallyraid/resume/<rallyId>_<stageId>.json` (+ `.1.json`,
`.2.json`, `.beat.json`), `format: "rallyraid-gamesave"`, `schemaVersion: 1`: `seq`, `reason`, `savedAt`,
`savedEpoch`, `rallyId`, `stageId`, `stageName`, `stagePath`, `wpCount`, `pos {lat, lon, alt, heading, speedKmh}`,
`vehicle {model, config, vehId}`, `car {beams[[cid, restLength, broken 0/1, ratio]], nodes[[cid, x, y, z]] (car
frame), deflated[], fuel {tank: litres}, engineFlags[], upright, damage {group: 0..1}, nBeams, nNodes, epoch}`,
`carFresh`, `carAgeS`, `stage {phase, clock, target, wps[{s, t, trip}], penalties[], penaltyTotal, impulses,
globalImpulses, zone, flags, startedAt, totalAtStart, repair {spares, timeS, log[], resets[], resumes, resumesLog[],
bivouac}, carRecoveryLog[], gameResumeLog[], odo {trip, partial, total, countDown}}`, `bivouac`, `summary`.

The rally ledger `<user>/current/rallyraid/rally/current.json` (`format: "rallyraid-rally"`) holds what spans stages:
`id`, `resumes[]`, `stages[]`, the open `bivouac`, closed `bivouacs[]`, `retired`, `gameResumes[]` (each game-crash
resume: `at`, `stageId`, `savedAt`, `savedClock`, `wallGapS`, `stageTimeLostS`, `penaltyS`, `summary`) and
`gameResumeDiscards[]` (saves discarded or replaced by a fresh start).
