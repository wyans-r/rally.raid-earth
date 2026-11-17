# Repair build status

> 17 Nov 2026: the repair / recover / crash-resume keys below (Ctrl+Shift+F / G / H) were taken out of the defaults; they are buttons now (GPS app MENU, Repair app). Only the 9 driving keys keep a default. The notes below are the build history.

v1 built 2026-11-16 (America/Chicago), after the roadbook quality work. Nothing is deployed: the mod zip was rebuilt
at `/workspace/rallyraid/rallyraid_mod.zip` only, not copied to `stage-builder/download/`.

## Done (v1)
- **Rules, as approved by Wyans (decisions relayed by Urf 2 on 11-16):**
  - Mid-stage: wheel change 2 min (2 spares per stage), light suspension 18 min per corner, radiator 12 min. The car
    must be stopped, and the time is added as a `repair` penalty.
  - Bivouac: whole-car repair and engine change (90 min of bivouac time plus a 2 h penalty), from a 3 h budget. Each
    minute over costs 1 min of penalty; more than 60 min over retires you from the rally.
  - Free reset keys are blocked in official runs. A reset the app did not make counts as a crash resume (15 / 30 min,
    max 3 per rally and 1 per stage, none within 1 km of the ASS), or retires the stage.
  - IPR loaded at stage start: the run is marked unofficial.
- **Code (our own, no IPR code):**
  - `mod/lua/ge/extensions/rallyRaid/repairConfig.lua`: every tunable in one place.
  - `mod/lua/ge/extensions/rallyRaid/repair.lua`: GE side. Rules, menu state, rally ledger, reset detection, key
    blocking, result fields, and `countResume()` for the crash-resume feature to reuse.
  - `mod/lua/vehicle/extensions/rallyRaid/vehRepair.lua`: vehicle side. Damage survey, snapshot, reset in place,
    re-apply everything that wasn't picked, then fuel, flat tyres and a seized engine.
  - `core.lua` hooks: stage start, finish, retire, `onVehicleResetted`, results, commands `repair*` and `rallyNew`, and
    TP to DSS marked as ours.
  - UI app `mod/ui/modules/apps/RallyRaidRepair/`, opened with Ctrl+Shift+F (action `rallyRaid_repairMenu`), plus the
    unbound action `rallyRaid_rallyNew`.
- **Tests:**
  - `tests/repair_test.lua` (122 checks, run by default by `tests/run_tests.py`).
  - `tests/browser/repair_app_test.js` with `tests/repair_app_preview.html`, screenshot `repair_app.png`.
- **Docs:**
  - `docs/REPAIR.md` (players);
  - the results fields in `docs/STAGE_FORMAT.md`;
  - README keys and app.

## Only checkable in BeamNG
- The reset in place: GE `veh:requestReset(RESET_PHYSICS)`, or the car's own `obj:requestReset` as a fallback. Check
  that the car stays where it stood and isn't moved to its spawn or a road.
- The vehicle calls used: `v.data.nodes/beams/wheels` fields (`partOrigin`, `pos`, `node1/2`, `name`),
  `obj:getBeamRestLength`, `obj:beamIsBroken`, `setBeamLength`, `breakBeam`, `get/setNodePosition`, `commitLoad`,
  `wheels.wheels[].isTireDeflated`, `beamstate.deflateTire`, `energyStorage` volumes, `damageTracker.getDamage`, the
  engine's `lockUp`, and the global `onBeamDeformed` replay of dented radiators.
- Whether the vehicle extension loads by name (`rallyRaid_vehRepair`) and gets `onReset` / `updateGFX`.
- `core_input_actionFilter` really blocking R / Insert / Ctrl+R / Home, and the names in `repairConfig.block.actions`.
- Part-name groups on the published class cars, and the beam-ratio damage measure (precompressed suspension beams may
  read as "damaged").
- Repair quality on slopes and bent frames.

## B11 crash resume (built 2026-11-16, America/Chicago; not deployed)
- `mod/lua/ge/extensions/rallyRaid/resume.lua` (new): resume states every 30 s of stage clock, the route as one line
  (nearest place, km, heading), the confirm / refuse / retire flow, the set-down, the clock pause, the result fields.
  Charges through `repair.countResume('crashResume', ...)`, so the 15 / 30 min, 3 per rally, 1 per stage and 1 km
  rules are repair v1's, unchanged.
- `vehRepair.lua`: `resumeSnapshot`, `resumeArm`, the car frame (`basis`, `toFrame`, `fromFrame`); `apply` puts
  frame-relative node positions back and answers `resumeDone`. Repair v1's own path is unchanged.
- `repairConfig.lua`: new `crashResume` table. The three pending v1 values aren't touched.
- `repair.lua`: exports `vehCfg`, refuses a repair while a resume runs. `core.lua`: clock pause, no waypoint checks or
  position-jump flag while the car is moved, resume teleport not flagged, reset routing, `resume*` commands,
  `crashResume` in results, `paused` in the HUD state.
- Key Ctrl+Shift+G (action `rallyRaid_crashResume`). UI in the rally.raid Earth Repair app.
- Tests: `tests/resume_test.lua` (run by default), `tests/browser/resume_app_test.js` + `tests/resume_app_preview.html`,
  screenshot `resume_app.png`.

## B11 rework (2026-11-16 late, America/Chicago; not deployed, zip not rebuilt)
Wyans' correction: B11 was meant for the GAME crashing (CTD, BeamNG error, force-quit), not the car. Decisions: no
penalty for a game-crash resume but every one flagged for organizer review; limits off with a switch for official
events; the car respawn merged into the Repair app now as RECOVER CAR, the one reset allowed in a stage, with the
unauthorized-reset penalty; saves every 30 s plus every CP / WP.
- `resume.lua` is now RECOVER CAR: kind / penalty `carRecovery`, UI hook `RallyRaidRecover`, commands `recover*`
  (`resume*` still accepted), result field `carRecovery`, config `carRecovery` (renamed from `crashResume`, with
  `enabled = true`), hook `onRallyRaidCarRecovery`, `stageResumed()` after a game-crash resume.
- `gameResume.lua` (new): atomic saves to `/settings/rallyraid/resume/<rallyId>_<stageId>.json` (3 kept, heartbeat),
  the offer on stage load, resume (respawn the saved model, teleport, set down, damage back, stage state back, clock
  held), discard, policy (`gameCrashResume`, `gameCrashResumeOfficial`), review entries in the result and the ledger.
- `vehRepair.lua`: `gameCapture` / `gameArm` (JSON-safe damage lists), `damageSummary`; `apply` skips unknown beams.
- `core.lua`: `captureStage` / `restoreStage`, save / clear hooks (start, finish, abort, unload, another stage),
  `gameResume*` commands, `onExit` / `onClientEndMission` last save, `held` in the HUD state, `reviewRequired`.
- `repair.lua`: ledger `gameResumes[]` / `gameResumeDiscards[]`; texts say recovery / reset.
- Keys: Ctrl+Shift+G = `rallyRaid_recoverCar`, Ctrl+Shift+H = `rallyRaid_gameResume` (new).
- Repair app: RECOVER CAR texts, the saved-stage offer (RESUME / DISCARD), HELD + GO, REVIEW, "saved to disk" line.
- Tests: `tests/resume_test.lua` 207 checks (kill + reload, corrupt fallback, ...), `resume_app_test.js` 55 checks.

## Next
- In-game test with Wyans: repair v1, the planner, RECOVER CAR and the game-crash resume (kill BeamNG mid-stage from
  the task manager, relaunch, load the stage).
