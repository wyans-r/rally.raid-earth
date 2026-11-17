# Repair spike: Individual Part Repair Menu (IPR) vs. our own rally repair app

Research only. Nothing in the mod was changed. Written 2026-11-16 (America/Chicago).

**Labels used below**
- **[CODE]**: verified by reading the real IPR v4.78 code. File paths are inside the IPR zip.
- **[DOCS]**: from public API docs (rls.studio / rlsstudios.dev BeamNG API reference) or BeamNG pages. Not run in game.
- **[OURS]**: verified in our own code (`/workspace/rallyraid`, `/workspace/beamng.earth`).
- **[INFERRED]**: my reading or judgement. Check it in game before relying on it.

---

## 1. TL;DR

- **We got the real mod code.** The plain `/download` link needs a login (HTTP 403). The versioned link on the resource page, `https://www.beamng.com/resources/individual-part-repair-menu.35878/download?version=74451`, returned the v4.78 zip (6.0 MB, `IndividualPartRepair.zip`, sha256 `5d1a942e…6cca2b`) with no login. I unpacked it on the box at `/tmp/ipr` for study only. It is not copied into our project and must not be redistributed.
- **How IPR repairs a part [CODE].** It saves the whole car's damage to a file, resets the car to brand new in place, then puts the damage back onto every beam and node except the ones belonging to the parts you picked. It is a clever "reset, then re-dent everything else" trick, not a true per-part repair.
- **Money (career and RLS) [CODE].** It charges 50% of each picked part's catalogue value through the career payment module (`career_modules_payment.canPay` / `pay`), and Undo refunds it. For RLS it overwrites RLS's damage save/load functions with its own.
- **Built-in rally mode [CODE].** If `gameplay_rallyLoop` is loaded, it adds a "recovery" entry to the rally event log with a time penalty of `120 s × repairCost / (10% of the car's value)`.
- **Recommendation: (C) build our own rally repair app.** We would use the same vanilla engine calls IPR uses, written from scratch, plus input blocking and reset detection. IPR as a required dependency (B) can't be made tamper-proof: in free roam it shows Save/Load/Auto-save/Refuel buttons and free repair modes. It also has no licence, updates every few weeks, and only knows BeamNG's rally loop, not our stages.
- **Estimate for C: about 3.5–5 working days**, or about 2–3 days for a smaller first version (see section 8).

---

## 2. Sources

| What | Link |
|---|---|
| IPR resource page (v4.78, Nov 2 2026, 206,849 downloads, unique ID `MVSO61EBL`) | https://www.beamng.com/resources/individual-part-repair-menu.35878/ |
| IPR versioned download (worked without login) | https://www.beamng.com/resources/individual-part-repair-menu.35878/download?version=74451 |
| IPR changelog | https://www.beamng.com/resources/individual-part-repair-menu.35878/updates |
| IPR version history (20 releases since Sep 2025) | https://www.beamng.com/resources/individual-part-repair-menu.35878/historyImproved |
| IPR forum thread | https://www.beamng.com/threads/individual-part-repair-menu.106103/ |
| Rally loop API (`gameplay_rallyLoop`) | https://rls.studio/docs/api/ge/gameplay/rallyLoop |
| Rally loop manager (event log, penalties, clock) | https://rls.studio/docs/api/ge/gameplay/rally/loop/rallyLoopManager |
| Vehicle `beamstate` (save/load, damage, part damage) | https://rls.studio/docs/api/ve/beamstate |
| Vehicle `partCondition` (snapshots, init, reset) | https://rls.studio/docs/api/ve/partCondition |
| Vehicle `recovery` (rewind, home, recoverInPlace) | https://rls.studio/docs/api/ve/recovery |
| Vehicle `damageTracker` (engine/tyre/brake damage flags) | https://rls.studio/docs/api/ve/damageTracker |
| Input action filter (blocking actions) | https://www.rlsstudios.dev/docs/api/ge/core/input/actionFilter |
| Career recovery prompt (radial-menu recover/repair buttons) | https://rls.studio/docs/api/ge/core/recoveryPrompt |
| Reset / recover key meanings and action ids | https://keymap.io/guides/beamng-drive-reset-recovery-controls/ |
| RLS Career Overhaul source (damageManager use in inventory) | https://github.com/RLS-Modding/rls_career_overhaul/blob/ed5bc0de/lua/ge/extensions/overrides/career/modules/inventory.lua |
| RLS issue showing damage-restore fragility after a game update | https://github.com/RLS-Modding/rls_career_overhaul/issues/544 |

I found no public GitHub mirror of IPR. I didn't need one because the zip downloaded directly.

---

## 3. What is in the IPR zip [CODE]

```
lua/ge/extensions/partRepairMenu.lua         138  GE helper: highlight parts, paint sync, "cheats" UI toggles
lua/ge/extensions/rally/rallyRepair.lua       39  built-in rally loop time penalty
lua/ge/extensions/career/modules/careerrepair.lua 322  career / RLS integration (damage persistence, overrides)
lua/ge/extensions/walkingRepairs.lua         252  on-foot repairs (spot regen, grab/attach/repair/detach)
lua/ge/extensions/partRemove.lua             220  remove parts by changing the config
lua/ge/extensions/core/input/actions/carryRepair.json  key bindings for walking repairs
lua/vehicle/extensions/partrepair.lua        648  the repair engine (free roam)
lua/vehicle/extensions/careerpartrepair.lua  707  same engine, career variant
lua/vehicle/extensions/partregenerate.lua    270  "Regenerate" mode (slowly restores beams)
ui/modules/apps/careerRepairApp/*            current UI app "Individual Part Repair"
ui/modules/apps/partTestApp/*                old UI app "Individual Part Repair (Old)"
doc.txt                                      author's technical notes
```

**There is no licence file and no licence text** in the zip, on the resource page or in the thread (searched for "licen", "copyright" and "permission").

### 3.1 How a repair actually works [CODE]

`lua/vehicle/extensions/partrepair.lua`

1. **`fixPart(parts, dtype, aggressive, safer, attach)`** (line 416) calls `save(v.data.vehicleDirectory .. "/vehicle.repair.json")`. The save stores each node's position and its original relative position (`obj:getNodePosition`, `obj:getOriginalNodePositionRelative`), plus each beam's rest length, broken flag, deformation and length. Beams are keyed by node names, beam type, precompression and ref length rather than by index, so a save survives part changes. It also stores `partCondition.getConditions()`, `energyStorage.onSerialize()` (fuel) and hydros. It then sets `taskArgs.active = true` and asks GE to `vehicleSetPositionRotation(...)` at the same spot, **which resets the vehicle to pristine**, followed by `resetBrokenFlexMesh()`.
2. **`onReset()`** (line 379) runs on that reset. It caches the beam precompression values and calls **`loadSecondStage(save, parts, dtype, aggressive)`** (line 134). That function walks every beam and node and re-applies the saved damage (`obj:setBeamLength`, `obj:breakBeam`, `obj:setNodePosition`, `obj:setNodeMass`), **skipping anything whose part path matches a picked part**. "Deep" also skips child parts. If any suspension sub-part is picked, the whole suspension assembly is skipped (line 163–170). Finally it calls `obj:commitLoad()`.
3. **`updateGFX`** (line 313), on the next frame, re-inits part conditions (`partCondition.initConditions`) without the repaired parts, replays the queued beam breaks and deformations through `onBeamBroke` / `onBeamDeformed` (glass, lights and other visual damage), resets door latches, and optionally runs `spawn.safeTeleport` ("Safe Reset", which can flip the car upright).
4. **`undo()`** (line 527) reloads the pre-repair `vehicle.repair.json`.

The author says the same thing in `doc.txt`: *"The basic 'Repair' mode will simply apply deformation to all parts except ones selected for repair… Damage is loaded relative to vehicle refnodes… deformed refnodes will cause parts to be misaligned."* He also notes that wheels only repair properly together with their whole suspension assembly.

Other modes, chosen in the UI in `careerRepairApp/app.js` `repairSelected()`:
- **Remove** (`partRemove.removeParts`) changes the config, then reapplies the damage.
- **Regenerate** (`partregenerate.regenerate`) slowly moves beams back toward their original lengths.
- **Attach** (`fixBeams`) mends only the connecting beams.
- **Detach** (`detachPart`) breaks beams and uncouples couplers.

### 3.2 Hook (a): career money, vanilla career and RLS Career Overhaul [CODE]

**Price.** In `careerRepairApp/app.js` `getPartRepairCost()` the cost is `partInfo.information.value * 0.5`. The damage scaling is commented out (`return baseValue * 0.5; // * damage;`). So repairing a lightly scratched part costs the same as a destroyed one.

**Payment in Repair mode.** Career repairs go through the vanilla career payment API:
```js
career_modules_payment.canPay({money={amount=X}})
career_modules_payment.pay({money={amount=X}}, {tags={"repair"},label="Repair Costs"})
career_modules_inventory.updatePartConditionsOfSpawnedVehicles()
activeObjectLua(`extensions.careerpartrepair.fixPart(...)`)
```

**Refund on Undo.** Undo calls `career_modules_playerAttributes.addAttributes({money=X}, {tags={"repair"},label="Refunded Repair"})`.

**Regenerate pricing.** `lua/vehicle/extensions/partregenerate.lua` line 204–239 charges `(restored fraction) × part value × 3`. It pays through `career_modules_payment.pay` from vehicle Lua with `obj:queueGameEngineLua`, and refunds the same way on undo.

**Career persistence and overrides.** In `lua/ge/extensions/career/modules/careerrepair.lua`, `onInit()` **monkey-patches** (replaces at run time) other modules' functions:
```lua
career_modules_painting.apply = <wrapper that re-applies part paints 1 s later>
career_modules_valueCalculator.partConditionsNeedRepair = function() return false end
career_modules_valueCalculator.getBrokenPartsThreshold  = function() return 0 end
if career_modules_damageManager ~= nil then -- RLS Fix
  career_modules_damageManager.loadDamageState = nop
  career_modules_damageManager.saveDamageState = saveDamageState   -- only deletes the vehicle object
end
```
**The RLS link is exactly this:** RLS's `damageManager` (which saves `career/vehicles/damage/<id>_damageState.json`, see the RLS inventory source above) is switched off. IPR keeps its own per-vehicle files instead:
- `<save>/career/vehicles/damage/<id>.damage.save.json`
- `.damage.cache.json`
- `.damage.shopcache.json`

These are written on `onSaveFinished`, `onComputerMenuOpened` and `onMissionStartWithFade`, and reloaded on spawn (`onSpawnCCallback` → `onUpdate` → `careerpartrepair.load`). They are also re-merged after part shopping (`loadParts` with the shopping cart) and cleared on `onRepairInGarage`, `onVehicleAdded` and `onVehicleRemoved`.

IPR never adds money of its own except refunds. It reuses the game's career money system, which RLS keeps.

### 3.3 Hook (b): BeamNG's built-in rally mode [CODE]

All of it is in `lua/ge/extensions/rally/rallyRepair.lua` (39 lines):
```lua
local function isRally()            -- true if extension "gameplay_rallyLoop" is loaded at all
  for k, v in pairs(extensions) do if k == "gameplay_rallyLoop" then return true end end
end
local function rallyRepairPenalty(penalty)
  local manager = extensions.gameplay_rallyloop.getManager()
  local currentEvent = manager.events and manager.events[manager.nextEventIndex] or nil
  manager.eventLog:addItem(currentEvent, manager.clock, 'recovery',
    {position = {...}, penaltyAmount = penalty, hitBudget = false})
end
local function handleRepairCost(repairCost)
  if isRally() then
    local vehicleCost = sum of information.value over vdata.activePartsData
    local penalty = 120 * repairCost / (vehicleCost * 0.1)
    rallyRepairPenalty(math.floor(penalty))
  end
end
```

**Who calls it.** The UI calls `extensions.rally_rallyRepair.handleRepairCost(totalPrice)` after a **non-career Repair** (`app.js` ~line 391). Regenerate also calls it from vehicle Lua (`partregenerate.lua` line 236).

**In plain terms.** The penalty is 2 minutes for every 10% of the car's value spent on repairs. Since repair cost is half the part value, repairing parts worth 20% of the car costs 120 s. The penalty is logged as a "recovery" in the rally loop's event log with `hitBudget = false`, so it doesn't use up the rally's reset allowance. The rally loop manager then adds it to the total through `getTotalPenalty()` [DOCS].

**What it does NOT do [CODE]:**
- It has no notion of stage vs. road section vs. service park.
- It doesn't decide which parts may be repaired.
- It has no time-at-service budget.
- Undo doesn't remove the penalty.
- Remove, Attach and Detach, plus walking "Repair Held Parts" and "Attach Held Parts" (`walkingRepairs.lua` → `partrepair.carryRepair`), **never call it, so they are free**.

**[INFERRED] possible bug.** The check uses `gameplay_rallyLoop`, but the call uses `extensions.gameplay_rallyloop` (lower-case L). The changelog says rally-loop support works (v4.22, Jul 30 2026), so the lookup probably tolerates this. I did not test it.

### 3.4 Integrity holes that matter for official events [CODE]

In free roam the app sets `scope.isCheats = !isCareer`, so cheats are on. Then:
- **💾 Save / 📂 Load buttons** (`app.html` line 81–82, `ng-show="isCheats"`). Loading a clean save is a free full repair.
- **"Auto Save/Load" toggle** (line 86). It saves every 3 s and reloads that save after any reset (`partrepair.lua` updateGFX/onReset), so a Recover keeps no record of the damage it undid.
- **Refuel** (`partTestApp`).
- **The "Old" app** (`partTestApp`) has no pricing or penalty at all.
- Remove, Attach and Detach modes, and the walking repairs, are free (see above).
- **Any part can be repaired, including engine, fuel tank and frame.** "Regenerate" is even advertised for fixing the frame.

---

## 4. How BeamNG itself repairs, resets and restores damage (for C and for crash resume)

| Need | API | Where it runs | Status |
|---|---|---|---|
| Save / restore the whole damage state | `beamstate.save(file)` / `beamstate.load(file)`. Serialises every node and beam in order (by index), so it is only valid for the **same config**. | vehicle Lua (`veh:queueLuaCommand(...)` from GE) | [DOCS] + [OURS]: BeamNG.Earth already uses it for far-away cars (`beamng.earth/.../farcars.lua` line 125 save, line 253 load, 1 s after spawn) |
| Part wear / integrity snapshot | `partCondition.getConditions()`, `initConditions(...)`, `createConditionSnapshot(key)` / `applyConditionSnapshot(key)`, `setResetSnapshotKey(key)` + `reset()` | vehicle Lua | [DOCS]; IPR uses `getConditions`, `initConditions`, `setResetSnapshotKey` and `reset` [CODE] |
| Fuel and other energy | `energyStorage.onSerialize()`, `getStorage(name):setRemainingVolume(v)` | vehicle Lua | [CODE] (IPR `save` / `loadSecondStage`) |
| Per-part damage numbers (for pricing) | `beamstate.getPartDamageData()` (damage coefficient per part), `beamstate.damage`, `beamstate.monetaryDamage` | vehicle Lua | [DOCS]; the IPR UI reads `beamstate.getPartDamageData()` [CODE] |
| Mechanical damage flags (radiator leak, oil pan, tyre, brake, engine locked) | `damageTracker.getDamage(group, name)` | vehicle Lua | [DOCS] |
| Low-level per-beam / per-node repair | `obj:setBeamLength`, `obj:breakBeam`, `obj:beamIsBroken`, `obj:getBeamDeformation`, `obj:getBeamRestLength`, `obj:setNodePosition`, `obj:getOriginalNodePositionRelative`, `obj:commitLoad()` | vehicle Lua | [CODE] (IPR) |
| Reset in place | GE `vehicleSetPositionRotation(id, x, y, z, qx, qy, qz, qw)` (resets the car) then `veh:resetBrokenFlexMesh()`; or `spawn.safeTeleport(veh, pos, rot, ..., resetVehicle)` | GE | [CODE] (IPR) + [OURS] (BNGE `core.lua` line 1015 comment: safeTeleport with reset resets and zeroes velocity) |
| Vanilla Recover / Home | vehicle `recovery.startRecovering`, `stopRecovering`, `recoverInPlace`, `loadHome` (all repair the car) | vehicle Lua | [DOCS] |
| "Something reset the car" | GE hook `onVehicleResetted(vehId)`, vehicle-side `onReset()` | both | [OURS] `core.lua` line 647 already has `M.onVehicleResetted` (it only clears `lastFix`); [CODE] IPR uses vehicle `onReset` |
| Block keys | `core_input_actionFilter.addAction(filter, actionOrGroup, true)`, `clear(filter)`, `getActionTemplates().competitive`, `isActionBlocked(name)` | GE | [DOCS]; [OURS] BNGE `settings.lua` line 1233 already uses `core_input_actionFilter` |
| Is another mod loaded? | `extensions.isExtensionLoaded(name)` | GE | [OURS] used in BNGE `addons.lua` line 279 |

### 4.1 Recover and Ctrl+R: what each key is [DOCS]

| Key | Action id | What it does |
|---|---|---|
| Insert | `recover_vehicle` | rewinds the car and repairs it |
| Ctrl+Insert | `recover_vehicle_alt` | alternate recover |
| Home / Ctrl+Home | `loadHome` / `saveHome` | Home teleports to the saved point and repairs |
| R | `reset_physics` | resets the car (full repair) |
| Shift+R | `reset_all_physics` | resets every car |
| Ctrl+R | `reload_vehicle` | reloads the car from disk (full repair) |
| (other) | `dropPlayerAtCamera` | teleports the car to the camera |
| (other) | `vehicle_selector`, `parts_selector`, node grabber, slow motion, world editor | — |

The built-in `competitive` template covers almost all of these. `reset_physics` sits in its own `resetPhysics` template [DOCS].

**Can resets be intercepted?**
- **Keys: yes.** The action filter stops the key from doing anything [DOCS].
- **Everything else: no.** The radial-menu Recover/Repair entries (`core_recoveryPrompt`, mostly career), the console, other mods (IPR), and BNGE's own teleport all call the functions directly and get around the key filter [INFERRED].
- **Detection is reliable [INFERRED].** Every one of these ends in a vehicle reset, so `onVehicleResetted` fires. Comparing `beamstate.damage` from just before with just after shows whether damage disappeared.

**Plan:** block the keys, and treat any reset we didn't start ourselves as a rule breach.

### 4.2 Notes for the later crash-resume feature

- **Same car, same config: use vanilla `beamstate.save` / `beamstate.load`.** It is the simplest path and BNGE has already shown it works in this world [OURS]. For safety also save `partCondition.getConditions()` and the fuel level.
- **Restoring:**
  1. respawn at the nearest point on the route;
  2. wait about 1 s, as BNGE does (`LOAD_DELAY_S = 1.0`);
  3. run `beamstate.load`.
- **IPR's part-keyed format only matters if the config changes,** which crash resume doesn't need.
- **Risk [DOCS / INFERRED]:** damage files can break across BeamNG updates (RLS issue #544, a heap-corruption crash restoring damage after 0.40.5). Stamp saves with the game version and car config, and refuse to load a mismatched save; offer a penalty instead.
- **Precompression gotcha [CODE `doc.txt`].** Suspension beams resize on spawn ("precompression"), so loading damage onto them can give wrong lengths. IPR works around this with a very small `beamPrecompressionTime` and a cache of the original values. If vanilla load shows the same problem on our rally cars, we may need the same trick.

---

## 5. Licence and permissions

- **IPR has no licence [CODE / DOCS].** By default that means all rights reserved. **We can't bundle or copy its code,** and I didn't paste its code into our project; the short quotes here are for analysis.
- **Making it a required, separate download is legally fine [INFERRED].** Calling a public function of another installed mod, or overriding a field such as `extensions.rally_rallyRepair.handleRepairCost`, is technically easy, but it is unofficial and could break on any update. For B we should ask Jesus Goose for permission and a stable hook, through the forum thread or a DM.
- **For C**, our code uses only vanilla BeamNG calls. The technique ("save, reset, re-apply all but the picked parts") is an idea rather than code, and the author describes it publicly in `doc.txt`. It is polite to credit him.

---

## 6. B vs C against the decided rules

| Rule | (B) Depend on IPR and hook it | (C) Our own app |
|---|---|---|
| Mid-stage: instant fix + time penalty | Only by overriding `rally_rallyRepair.handleRepairCost`. We would get a money figure, not which parts, so we would have to turn money into minutes. Free modes (Remove, Attach, Detach, walking repairs) need wrapping too. | Native: we choose the part group, apply the fix, then call `addPenalty('repair', secs, group)` |
| Only stage-feasible repairs (no engine, fuel tank or frame) | Would need us to wrap IPR's vehicle-side `fixPart` / `regenerate` to filter parts. That breaks whenever IPR changes (20 releases in 14 months). | Native: groups are allow-listed per phase (stage vs. bivouac) |
| Between stages: uses bivouac time | IPR has no bivouac concept; all of it would be ours anyway | Native |
| Block free Recover / Ctrl+R | Same work either way (action filter + reset detection). **But IPR's Save/Load/Auto-save/Refuel are free repairs we can't switch off** without patching its UI. | Block keys + detect any reset we didn't start. If IPR is installed, refuse official mode or flag the run. |
| Log every repair in the result package | Would need wrappers around several entry points | Native: one function does every repair and writes the log |
| Repair quality (alignment problems) | Mature, many options (Aggressive, Deep, Attach on Fix) | We hit the same physics limits. Mitigation: repair whole assemblies (a full suspension corner, never a lone wheel) and test on our rally cars. |
| Player setup | Extra download, version must match exactly | Nothing extra |
| Version checks for official runs | Hash a mod we don't control, which changes often | We control the file and its hash |

**Main risks of B:** integrity holes we can't close (3.4); breaking changes we don't control; no licence or permission yet; it is built around money while our rules are built around time; and it only hooks BeamNG's rally loop, which our stages don't use.

**Main risks of C:** more build work; per-part repair can misalign parts on a bent frame (the same limit as IPR); we must keep the part-group mapping per vehicle.

## 7. Recommendation

**Go with (C): our own rally repair app.**
- Use vanilla calls only, with the "save, reset, re-apply all but the chosen group" technique written from scratch.
- Repair whole assemblies rather than single parts.
- Block Recover/Ctrl+R with the action filter, and treat any other reset as a breach.
- In official mode, detect IPR (`extensions.isExtensionLoaded('partRepairMenu')`, or its vehicle extension files) and refuse to start the run, or mark it unofficial.
- IPR can still be used in casual, non-official runs.

## 8. Build estimate for C

| Piece | Days |
|---|---|
| Part-group classifier (slot / part names → wheel, suspension corner, steering, cooling, body panel, lights/glass, engine, fuel tank, frame) + cost table + allow-lists per phase | 0.5–1 |
| Vehicle-side repair: save → reset in place → re-apply everything except the group; parts conditions; fuel kept; tested on 3–4 rally-raid cars | 1.5–2 |
| Rules: mid-stage penalty, bivouac clock and overrun/retirement, spare-wheel count, result-package log | 0.5–1 |
| Blocking and detection: action filter on stage start/finish, `onVehicleResetted` + damage check, IPR detection, official flag | 0.5 |
| UI (HUD panel or small app: pick group → shows time → confirm) + in-game test round with Wyans | 0.5–1 |
| **Total** | **≈3.5–5 days** |

**Smaller first version (≈2–3 days):**
- Mid-stage: wheel change and full suspension corner.
- Bivouac: one full repair that costs bivouac time by damage level, using a vanilla full reset plus a fuel restore, with no per-part work.
- Then add body panels, cooling and steering.

This is longer than the 1–3 days in the earlier plan. The research showed that a proper per-group repair needs the reset-and-re-dent technique rather than a simple engine call.

---

## 9. Sketch: repair cost table and blocking

### 9.1 Cost table (by part group)

Stored as data (e.g. `rallyraid/rules/repairs.json`) so organizers can change it, and hashed with the event files.

```json
{
  "format": "rallyraid-repairs", "version": 1,
  "bivouacBudgetMin": 180,
  "bivouacOverrun": { "penaltyPerMin": 60, "retireAfterMin": 60 },
  "spareWheelsPerStage": 2,
  "groups": {
    "wheel":        { "match": ["wheel_", "tire_", "hub"],                "stage": 2,   "bivouac": 2,   "scale": false },
    "suspension":   { "match": ["suspension", "shock", "spring", "arm", "strut"], "stage": 15, "bivouac": 20, "perCorner": true },
    "steering":     { "match": ["steering", "tierod"],                    "stage": 20,  "bivouac": 25 },
    "cooling":      { "match": ["radiator", "intercooler"],               "stage": 20,  "bivouac": 30 },
    "body_panel":   { "match": ["bumper", "fender", "hood", "door", "tailgate", "skid"], "stage": 5, "bivouac": 10 },
    "lights_glass": { "match": ["light", "glass", "windshield"],          "stage": 3,   "bivouac": 5 },
    "gearbox":      { "match": ["transmission", "gearbox", "transfer", "diff"], "stage": null, "bivouac": 90 },
    "engine":       { "match": ["engine"],                                "stage": null, "bivouac": 150 },
    "fuel_tank":    { "match": ["fueltank", "fuel_tank"],                 "stage": null, "bivouac": 60 },
    "frame":        { "match": ["frame", "chassis", "body_root"],         "stage": null, "bivouac": 120 }
  }
}
```

- Times are minutes. `stage: null` means not allowed mid-stage.
- **Mid-stage cost** is the minutes added as a time penalty (the car is fixed instantly).
- **Bivouac cost** is taken from the bivouac budget.
- **Scaling** [proposal]: `minutes = base × (0.3 + 0.7 × damage)`, where `damage` is the group's highest value from `beamstate.getPartDamageData()` (0–1), so a dent costs less than a write-off. Wheels are a flat 2 min each.
- The `match` lists are first guesses. Part and slot names vary between cars, so we test them on the cars in the published class list and keep per-vehicle overrides where needed.

**Result package entry** (added to `M.results()` as `repairs`, with the penalty also going through `addPenalty('repair', …)`):
```json
{ "t": 1834.2, "km": 112.4, "phase": "stage", "group": "suspension", "corner": "FL",
  "parts": ["pickup_suspension_F_L", "pickup_shock_F"], "damage": 0.62, "minutes": 12.9, "penaltyS": 774 }
```

### 9.2 Blocking Recover / Ctrl+R and catching everything else

```lua
-- on official stage start (and bivouac): block; on finish / unload: clear
local FILTER = 'rallyRaidOfficial'
local function blockFreeRecovery(on)
  local f = rawget(_G, 'core_input_actionFilter'); if not f then return end
  if not on then f.clear(FILTER) return end
  for _, a in ipairs(f.getActionTemplates().competitive or {}) do f.addAction(FILTER, a, true) end
  for _, a in ipairs({ 'reset_physics', 'reset_all_physics', 'reload_vehicle', 'reload_all_vehicles',
                       'recover_vehicle', 'recover_vehicle_alt', 'loadHome', 'saveHome' }) do
    f.addAction(FILTER, a, true)
  end
end

-- any reset we did not start = breach (radial menu, console, IPR, ...)
local expectingReset = false            -- set true by our own repair / crash-resume code just before it resets
function M.onVehicleResetted(vehId)
  lastFix = nil
  if not (S and S.official and S.phase == 'running') then return end
  if expectingReset then expectingReset = false; return end
  S.flags.unauthorizedReset = (S.flags.unauthorizedReset or 0) + 1
  -- rules TBD: count it as a crash resume (uses one of 3, +15/+30 min) or retire the stage
end
```

- The action-filter calls and template names come from the docs [DOCS]. Check in game with `core_input_actionFilter.getBlockedActions()`.
- A periodic damage sample (`beamstate.damage` read from vehicle Lua about every 2 s) catches a damage drop without a reset.
- At official start: refuse if `extensions.isExtensionLoaded('partRepairMenu')`, or put `ipr = true` in the result and flag the run.
- **Today's gap [OURS]:** `core.lua` currently doesn't penalise or flag a reset at all; `onVehicleResetted` only clears `lastFix`. So Insert/R/Ctrl+R are free right now. Position jumps from BNGE teleports are already flagged.

## 10. Open questions for Wyans

1. Bivouac overrun: is 1 min penalty per minute late OK, and retirement after 60 min over? Should an engine change at the bivouac be allowed with an extra penalty, as in Dakar, or be banned?
2. Spare wheels: limit them (e.g. 2 per stage), as real Dakar cars carry a fixed number?
3. An unauthorized reset in an official run: count it as one of the 3 crash resumes, or retire the stage straight away?
4. Is it OK to contact Jesus Goose to credit him, and perhaps to ask about future compatibility?
