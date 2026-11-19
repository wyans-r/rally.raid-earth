# Repairs, the bivouac, recover car, game-crash resume and resets (rally.raid Earth v1)

> 18 Nov 2026: there is no separate Repair app any more. Everything below that says "Repair app" is the **REPAIR panel in the GPS app** (MENU > REPAIR): the same buttons, the same Lua.

How car repairs work in a rally.raid Earth stage, what they cost, how to get the car back on the route when it's stuck or
rolled (**Recover car**), how to carry on after the **game** crashes (**Game-crash resume**), and what happens if the
car is reset some other way.
Every number here is set in one file, `mod/lua/ge/extensions/rallyRaid/repairConfig.lua`, and is copied into each
result file so penalties can be checked later.

## Setup

1. Esc > **UI Apps** > **Add app** > **rally.raid Earth Repair** (category "rally.raid Earth"). Put it anywhere. It shows a thin
   bar (**REPAIR / BIVOUAC**, spare wheels left, recoveries / resets used, **HELD** and **REVIEW** after a game-crash
   resume) and opens into the menu.
2. Click the bar to open or close the menu, or press **MENU** > **REPAIR** in the GPS app. There is no default key
   (since 17 Nov: only the driving keys have one); you can bind one in Options > Controls > Bindings: search for
   "rally.raid Earth: repair menu". The bar then shows it.
3. **Recover car** (below): **MENU** > **RECOVER** in the GPS app, or **RECOVER CAR** in this menu. Bindable as
   "rally.raid Earth: recover car".
4. Resuming a stage saved before the game crashed (below): **MENU** > **RESUME** in the GPS app, or this app. Bindable
   as "rally.raid Earth: resume saved stage (after a game crash)".

## In a stage: roadside repairs

Stop the car (under 1 km/h), open the menu, tick what to fix, then press **REPAIR**. The car is fixed straight
away, and the time is added to your stage as a **repair** penalty.

| repair | time | limits |
|---|---|---|
| Change wheel (FL / FR / RL / RR) | 2 min each | 2 spare wheels per stage. A changed wheel also gets a fresh tyre. |
| Suspension, one corner (light) | 18 min | Fixes that corner's arms, springs, shocks, hub and axle parts. The frame is not fixed. |
| Radiator | 12 min | |

- The menu shows a damage bar for each item and **FLAT** for a flat tyre, so you can see what needs fixing.
- Everything you don't pick keeps its damage: dents, broken parts, flat tyres, the fuel you have left, and a seized
  engine.
- Engine, gearbox, fuel tank, frame and body damage **can't be fixed in a stage**. They wait for the bivouac.

## The bivouac: between stages

The bivouac opens when you cross the ASS (and also if the stage was retired), and closes when the next stage's clock
starts. You get **3 hours of service time**, counted by the repair menu, not by the clock on the wall.

| bivouac job | service time | extra |
|---|---|---|
| Whole-car repair (everything except the engine) | 10 min, plus time for each damaged area. Worse damage takes longer. | |
| Engine change | 90 min | **plus a 2 h time penalty** on the next stage |

The whole-car repair time comes from this table. A damaged area costs between 30% and 100% of its time, depending
on how badly it is damaged.

| area | full time |
|---|---|
| wheel | 2 min each |
| suspension | 20 min per corner |
| steering | 25 min |
| radiator | 30 min |
| body panels | 15 min |
| lights / glass | 5 min |
| gearbox / drivetrain | 90 min |
| fuel tank | 60 min |
| frame | 120 min |

- **Over the 3 h:** each minute over adds **1 minute** of penalty to the next stage.
- **More than 60 minutes over:** you are **retired from the rally**. Your next stage still runs, but its result is
  marked unofficial.
- The whole-car repair doesn't cure engine damage such as a blown head gasket. Only an engine change does. Anything
  the repair couldn't keep is listed in the log.

## Recover car: back on the route when the car is stuck or rolled

Rolled into a ravine, stuck on a rock, or lost far off the route? **Recover car** puts the car back on the stage
route for a time penalty. It is the **one reset allowed in a stage**: BeamNG's own reset keys stay switched off.
Since 18 Nov there is **no limit**: as many recoveries as you need, anywhere on the stage (also within 1 km of the
ASS), and **every one costs its penalty** (Wyans: "let's allow unlimited recoveries, keeping the time penalty for each
one").

1. Stop the car (under 10 km/h) and press **MENU** > **RECOVER** in the GPS app, or **RECOVER CAR** in the repair menu.
2. The GPS app's REPAIR panel (MENU > REPAIR; and, in short, the GPS app's menu) shows what it will cost before anything happens:
   - the penalty, **+15 min** for your first recovery of the rally and **+30 min** for each one after that (the same
     penalty as a reset the app didn't make, and they share one count);
   - how many recoveries / resets you have used in the rally and on this stage, and the penalty they have cost so far
     (the GPS bar shows it as `RESETS 2 +45 MIN`);
   - where the car goes: back on the route, 30 m behind where it got stuck, at the roadbook km shown;
   - that the damage stays: the car keeps every dent, broken part and flat tyre it has now.
3. Press **CONFIRM RECOVERY** (REPAIR panel), or **CONFIRM** in the GPS app's menu within 15 seconds. **CANCEL** leaves everything as it is.
4. The stage clock stops. The car is set down on the route, upright and facing the way the route goes, and the trip
   meter jumps to that place's roadbook km. Two seconds later the clock runs again and the penalty is added to your
   stage time.

**Recovery does not repair anything** (changed 18 Nov, after the in-game test "Recover fully repaired the vehicle").
Near the car, the car is only lifted, set upright and put back on the route: no reset, so every dent, broken part,
flat tyre, the fuel and a seized engine stay exactly as they were. This is the game's own "recover upright" call
(`spawn.safeTeleport` with `resetVehicle = false`, as in BeamNG's `core/recoveryPrompt.lua`, and as BeamNG.Earth's
edge guard uses it), followed by stopping the car.

While you drive, the game still keeps a *recovery state* every 30 seconds of stage time, but now only for **where**
to put the car (your place on the route, the waypoints passed). Its damage is not used.

- A state isn't "good" if the car was tipped over or more than 300 m from the route when it was saved.
- **Far from the route** (below) is the exception: BeamNG.Earth's teleport resets the car on its own, so the damage
  is captured when you press CONFIRM and put back after the teleport, with the same code as the roadside repair.
  That is close to the car you had, not exact (see Known limits).

**When you can't recover.** The app tells you why, and nothing is counted:

| situation | what happens |
|---|---|
| moving faster than 10 km/h | refused: stop first |
| no stage clock running, a repair or a game-crash resume running, no position from BeamNG.Earth | refused |
| switched off for the event (`carRecovery.enabled = false`) | refused; the button is greyed out |

An event can still set the old limits in `repairConfig.lua` (`resume.maxPerRally = 3`, `maxPerStage = 1`,
`noResumeNearFinishM = 1000`); then going over one is refused with **RETIRE STAGE** offered. They are off by default.

RETIRE STAGE asks "Really retire?" first, then ends the stage there. The bivouac still opens afterwards.

If the car doesn't answer, or can't be set down, the recovery is called off. No penalty is charged, nothing is counted,
and the clock runs again.

**Far from the route** (more than 1.5 km, or where BeamNG.Earth hasn't loaded the world), BeamNG.Earth's own teleport
takes the car there first, then it is set down on the route. This doesn't mark the run unofficial.

## Game-crash resume: carry on after the game crashed

If **the game itself** crashes or is force-quit mid-stage (a crash to desktop, a BeamNG error, a frozen game you had to
kill), you don't lose the stage.

**While you drive**, the stage is saved to disk:
- every **30 seconds** of stage time, and at once whenever something changes your result: a waypoint or checkpoint
  passed or missed, a penalty, a roadside repair, a car recovery, the start;
- in `<BeamNG user folder>/current/settings/rallyraid/resume/<rally id>_<stage id>.json`. The newest 3 saves are kept
  (`.json`, `.1.json`, `.2.json`). Each one is written to a temporary file first, read back and checked, and only then
  renamed over the old save, so a crash halfway through a write can't leave you with nothing;
- a tiny "still alive" file is written every 5 seconds, so after a crash the game knows roughly how much driving
  happened after the last save;
- closing the game normally mid-stage (or leaving the level) writes one last save too.

The repair menu shows "saved to disk N s ago" under RECOVER CAR.

**After the relaunch**, load the same stage (the GPS app's stage list or the planner). The GPS app's REPAIR panel shows
**SAVED STAGE FOUND (GAME CRASH)** with *"Resume from last save (1:15:21 elapsed, saved 12 min ago)"*, what was saved
(waypoints passed, penalties, spares, recoveries) and roughly how much driving after the save was lost.
- **RESUME** (or, in the GPS app's menu, which opens by itself when a save is found, **RESUME** then **CONFIRM RESUME**): if another car is out, the saved car (same model and part config) is
  spawned first. The car is put back exactly where it was saved, facing the same way (BeamNG.Earth's teleport first if
  that part of the world isn't loaded), with its saved damage, flat tyres and fuel. The stage clock, waypoints,
  penalties, spares, repairs, recoveries / resets and the trip meter all come back as saved.
- The **clock is held** at the saved time (**HELD** in the bar) until you drive off, or press **GO** (the REPAIR panel
  or the GPS app's menu).
- **DISCARD** (asks "Really discard?") deletes the save. Drive to the DSS to run the stage again from scratch. Starting
  the stage without resuming discards the save as well.
- If the newest save is damaged, the one before it is used (the app says so). If none is good, nothing is offered and
  the app says why.

**The rules** (Wyans, 2026-11-16): **no time penalty**, no limit on how many, but **every resume is flagged for
organizer review**: **REVIEW** shows in the bar, and the stage result and the rally file get a review entry. A restart
from scratch after discarding a save is flagged too. All of this is in `repairConfig.lua`, `gameCrashResume`, and
official events can switch on the original rules with one line (`useOfficialRules = true`): +15 min for the first,
+30 min after that, counted together with car recoveries / resets, 3 per rally and 1 per stage, none from a save
within 1 km of the ASS; going over a limit retires the stage with the saved state.

**The review entry** (`gameCrashResume.resumes[]` in the result) holds:
- when it was resumed (real time, UTC) and when the save was written, and which save was used (newest or older);
- the gap: wall-clock time between the save and the resume, and the stage time lost after the save (from the "still
  alive" file: the game stopped within 5 s after `lastAlive`);
- the **saved** and the **resumed** state side by side: position, heading, stage clock, waypoints passed and missed,
  penalties, spares, repairs, recoveries, damage per area, car model; and their differences (`diff`: metres apart,
  damage difference, ...);
- whether the game was closed normally (`cleanExit`), whether the car had to be respawned, any penalty, and a
  one-line summary for the organizer.

## Resets: R, Insert, Ctrl+R, Home


During a stage, and in the bivouac while a stage is loaded, BeamNG's own reset, recover, reload and home keys are
switched off. Use the repair menu, or **Recover car** (GPS app **MENU** > **RECOVER**), instead.

Any other reset still gets noticed, for example from the radial menu, the console or another mod:

- **In a stage**, it counts like a **Recover car**: **15 min** for the first one in the rally and **30 min** for
  each one after that, from the same count (no limit), but the car stays wherever the reset put it. Unlike Recover
  car, such a reset repairs the car, so it is logged in the result as a reset the app didn't make.
- Only if an event set the old limits is your stage retired instead (second on the stage, over 3 in the rally, or
  within 1 km of the ASS).
- **In the bivouac**, a reset isn't charged, but it is written into the next stage's result.

**Start a new rally** (the "rally.raid Earth: start a new rally" binding, unbound by default) sets the recovery / reset
count back to 0 and drops any open bivouac. Game-crash saves belong to their rally: a new rally doesn't offer them.

**Individual Part Repair mod:** if it is loaded when a stage starts, the run is marked unofficial. Its free save, load
and repair buttons can't be policed.

## What is logged

Each **result file** includes:
- every repair, with what was picked, its minutes and penalty, where it happened (km and lat / lon), and the damage
  before and after;
- every reset the app didn't make, with its outcome;
- every car recovery (`resumes.log`, kind `carRecovery`, and `carRecovery`): where the car got stuck, where it was
  set down (route km, how far back), the saved state used and how old it was, the damage after it, how long the clock
  was stopped, and the penalty;
- every car recovery that was refused, failed or ended in RETIRE STAGE, with the reason;
- how many recovery states were saved, and the rule values used;
- the recovery / reset counts;
- every game-crash resume (`gameCrashResume`): the review entries above, a `review` list of one-line summaries, any
  earlier save of this stage that was discarded, how many saves were written (and failed), and the rule values used.
  `reviewRequired: true` at the top of the result means an organizer should look at it;
- the bivouac that closed at this stage's start (time used, overrun, engine changes);
- the rally id;
- the rule values used.

The rally itself is kept in `<BeamNG user folder>/current/rallyraid/rally/current.json`, including `gameResumes` and
`gameResumeDiscards` (written the moment they happen, so they survive even if the stage is never finished). The
fields are listed in `docs/STAGE_FORMAT.md` under "Results file".

**Console lines** (the in-game console, `~`, and `<BeamNG user folder>/current/beamng.log`), each starting with
`[rally.raid Earth]`:
- a repair: `repair N requested (...)`, `car report (before repair N)`, `repair N ready: wheels changed ..., flat
  tyres before ...; kept for after the reset: ...`, `repair N: reset in place with ...`, `repair N done (...)`,
  `car report (after repair N)`, and one second later `repair N, 1 s later: flat tyres ..., a changed tyre flat
  again: ..., broken beams in the repaired parts: ...` (a warning, and a note on screen, if a new tyre went flat);
- a recovery: `car recovery requested ...`, `car report (before recovery N)`, `car recovery: spawn.safeTeleport(...,
  resetVehicle = false) ok`, `car recovery N done: ... landed ... m, ... deg`, `car report (after recovery)`;
- any failure is logged with `FAILED` or as an error line.

## How it works (for the curious)

To fix only some parts, the app does four things:
1. It records the whole car's damage: every node position, every beam's length and whether it's broken, flat tyres,
   fuel, and engine damage.
2. It resets the car to new where it stands.
3. On the next frame, it puts the damage back on everything that wasn't picked.
   Since 18 Nov it leaves alone: every node of a repaired part, both ends of every repaired beam, and a changed
   wheel's hub nodes (so a new tyre is not pulled onto the old, bent spot and torn flat again); every hydro and tyre
   pressure beam (a steering rack frozen at its old length is what broke the steering after a suspension repair);
   and dents that pull on a renewed node. Broken parts that weren't picked are broken again. Kept node positions are
   stored relative to the car.
4. It hands back the fuel you had left.

This is our own code, using only standard BeamNG functions. The idea comes from the Individual Part Repair mod's
author, who described it publicly; credit to him. None of that mod's code is used.

Parts are sorted into groups by their part names (`repairConfig.lua`, `groups`), and wheels and suspension are split
by the nearest wheel.

### Recover car and game-crash resume, under the hood

- Positions are stored as latitude / longitude from BeamNG.Earth (`beamngEarth_api.pose()`), never as game x / y,
  because BeamNG.Earth moves the world's origin as you drive. They are turned into game coordinates
  (`beamngEarth_api.toGame`) only at the moment the car is set down.
- The car keeps its own part of the recovery state: the damaged and broken beams, and the positions of their nodes,
  stored relative to the car itself so they still fit when the car faces a new way. For a game-crash save the car
  sends the same data as plain lists (`vehRepair.gameCapture`) and it goes into the save file; on resume it is sent
  back to the car (`vehRepair.gameArm`).
- Recover car near the car: `spawn.safeTeleport(veh, pos, rot, nil, nil, false, nil, false)`: the last `false` is
  `resetVehicle`, so the car is moved and set upright without a reset (its damage stays), then
  `veh:applyClusterVelocityScaleAdd(-1, 0, 0, 0, 0)` stops it. Without `spawn`, `veh:setPositionRotation` (no reset).
- Far recover and game-crash resume: the car is reset (BeamNG.Earth's teleport, or `spawn.safeTeleport` with
  `resetVehicle = true`). The next frame, the captured damage, flat tyres, fuel and seized engine are put back with
  the same code the roadside repair uses.
- That reset is the app's own, so it isn't counted again as "a reset the app didn't make".
- All the numbers are in `repairConfig.lua`: the rules in `resume`, the recovery mechanics in `carRecovery` (every
  30 s, 4 states kept, at least 5 s old, 300 m off route, 30 m back, under 10 km/h, 2 s settle, 1.5 km teleport limit,
  `enabled`), and the game-crash save in `gameCrashResume` (folder, every 30 s + events, 3 saves kept, 5 s heartbeat,
  3 km/h to start the held clock, the policy switches) with the official values in `gameCrashResumeOfficial`.
- The game-crash save file (`format: "rallyraid-gamesave"`, `schemaVersion: 1`) holds `pos` (lat / lon / alt /
  heading), `vehicle` (model, part config), `car` (damage lists, flat tyres, fuel, engine flags, damage per area),
  `stage` (clock, each waypoint's status / time / trip, penalties, speed-zone state, flags, repairs and spares, the
  bivouac that closed at the start, recoveries / resets and their logs, game-crash resumes so far, the odometers),
  `summary`, and when / why it was saved. A save is only offered for the same rally, the same stage id and the same
  number of waypoints.

## Known limits (v1, to be checked in the game)

- A repaired part can sit slightly out of line if the frame next to it is badly bent. This is the same limit
  per-part repair has in every mod. Repairs on flat ground work best.
- The part-name lists are first guesses. Some cars may put a part in the wrong group. Tell us the car and part.
- Engine damage the app can put back after a repair is a seized engine. Other engine damage (head gasket, rod
  bearings, overheating) is cured by any repair, but it is logged as "not restored" so it can be audited.
- If you unload the stage while a bivouac is open, the keys are free again. A reset then is still logged, but isn't
  charged.
- Recover car: the set-down (`spawn.safeTeleport`), the car's direction vectors and the ground ray are standard
  BeamNG calls that BeamNG.Earth already uses, but they have only been tested outside the game. If the car comes down
  facing the wrong way, or the damage looks twisted, tell us. The result file records `headingOffDeg` and
  `landedOffM` for this.
- Recover car far from the route (BeamNG.Earth teleport) and game-crash resume reset the car, so their damage comes
  back approximately (see the list below); only the near recover keeps the damage exactly.
- Recover car near the car: an upside-down car is turned over by moving all of it at once. A badly bent car can
  land a little off; the console line "car recovery N done" says how far and how many degrees.
- Game-crash resume, what **can't be restored exactly**:
  - the car is set down **at rest** (no speed, no spinning wheels), on the ground under the saved spot, upright on its
    saved heading: a save taken mid-air, mid-slide or tipped over comes back standing still and upright;
  - damage comes back as the damaged / broken beams and the positions of their nodes. Bent metal that didn't change a
    beam's length by more than 0.1 % comes back straight; broken-off parts come back as broken beams (a detached
    panel is broken again where it hangs, not lying on the road where it fell);
  - engine damage: a seized engine is put back; a blown head gasket, damaged rod bearings, piston rings,
    overheating / overrev damage and oil leaks **can't be put back** and are listed in the review entry
    (`engineFlagsNotRestored`);
  - tyre wear and temperature, brake and engine temperatures, oil level, the gear and engine on/off state, lights,
    dirt and scratches (paint) are not saved: the car comes back with fresh values;
  - fuel is put back per tank (every energy storage that has a volume);
  - the damage is the car's as of its last answer: normally the moment of the save, at most 3 s older (`carAgeS`), or
    the save before if the car didn't answer;
  - if the car's parts changed since the save (another config), beams / nodes that don't exist on it are skipped and
    counted (`carSkipped`);
  - BeamNG.Earth traffic, weather and time of day are not part of the save.
- Game-crash resume: renaming files uses `FS:renameFile`, and writing uses `writeFile` / `readFile` / `jsonEncode` on
  the game's virtual file system. They were tested with real files outside the game; if the game can't rename, the
  save is copied and read back instead. `saveFails` in the result counts saves that couldn't be written.
