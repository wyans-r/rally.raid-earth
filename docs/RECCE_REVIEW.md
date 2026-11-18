# Recce mode: review (17 Nov 2026)

Wyans asked after the 17 Nov in-game test: recce looks limited ("can only add symbols?"). This note covers what recce
does today, what is missing, and a proposal in priority order with an estimate for each item. **Nothing here is built
yet.** Pick what to do next.

Code: `mod/lua/ge/extensions/rallyRaid/recce.lua` (701 lines), `core.lua` `M.recceCmd`, and the RECCE panel in
`mod/ui/modules/apps/RallyRaidRoadbook/app.js`. The format is in `docs/ROADBOOK_FORMAT.md` ("Change records").

## What recce does today

Recce needs a **loaded stage with a roadbook**. Press RECCE in the Roadbook app to turn it on or off.

| Part | What it does | Where you see it |
|---|---|---|
| Driven line | Records a lat/lon point every 10 m, plus the km driven. | Panel: km, points. Saved in `/rallyraid/recce/<stage>.recce.json`. |
| Automatic boxes | Detects jumps (airtime), hard compressions, crests, soft sand (slow + wheelspin), steep climbs/descents and side slopes. Each one becomes a `recce-auto` box, unverified. | Panel line "DETECTED: ...". The box appears in the roadbook, marked to check. |
| + BOX HERE | Adds a new box at the car with symbols (quick-pick of 30 plus the whole library), danger 0–3 and notes (120 chars). | The quick-pick panel. **This is the part Wyans saw.** |
| ✓ / HERE / TAG / ✕ | Confirm, move to the car, retag (symbols/danger/notes) or delete the **nearest** box within 150 m. | "NEAR n, d m" line. |
| UNDO | Takes back the last change. | |
| MERGE (+ rescale) | Writes the changes into the `.roadbook.json` (with a backup and a revision bump). Rescale re-measures box km from the driven line. | Notice with applied/conflict counts. |
| Stage builder import | The roadbook editor can import a `.recce.json` (the "recce" button) and apply it there. | `stage-builder/roadbook.html` |

Tests: `tests/recce_test.lua` (63 checks: detection on simulated telemetry, change records, merge/rescale) and the
Roadbook recce buttons in `tests/browser/hud_buttons_test.js`.

## Why it feels limited

1. **The only visible action is "add a box with symbols".** The automatic detections only show for 8 s
   ("DETECTED: ..."). Nothing lists what recce has recorded, so it looks like nothing happened.
2. **Box editing covers symbols, danger and notes only.** There is no way to edit a box's distance (km), its
   CAP/heading, the junction/tulip instruction, or its label. A rally driver mostly fixes those.
3. **Only the nearest box (150 m).** You can't step through boxes or edit one behind you without driving back.
4. **No stage = no recce.** You can't recce a new route. That is the Planner's job, but the two don't connect.
5. **Typing notes in game is awkward.** BeamNG keys still act while you type in the notes field.
6. **Merge is all or nothing, with no review step.** You don't see conflicts until after the merge.

## Proposal (priority order)

Estimates are focused work time, including tests, for the Lua side plus the app. "In game" means time for Wyans to check it.

| # | Item | What | Estimate |
|---|---|---|---|
| 1 | **Changes list** | A "CHANGES n" tab in the recce panel listing every change (auto and manual) with its km, kind and symbols. Tap one to select it, then ✓ / ✕ / TAG it. Shows the automatic boxes so recce visibly does something. | 0.5 day + 15 min in game |
| 2 | **Select any box, not only the nearest** | ◀ ▶ to step through roadbook boxes (the display already scrolls with box up/down). The recce actions apply to the box on screen, so you can fix a box behind you. | 0.5 day |
| 3 | **Edit km / distance** | "KM HERE" sets the box's km to the current trip. ± 10 m nudges it. Same change record (`move` with km only). | 0.5 day |
| 4 | **Edit CAP and instruction** | CAP from the car's heading ("CAP HERE"), plus a short list of instructions (KEEP LEFT/RIGHT, TURN L/R, STRAIGHT ON, a junction tulip from the driven line). Needs an `update` with `cap` / `instr` fields, and the merge plus the stage builder accepting them. | 1–1.5 days |
| 5 | **Merge preview** | Before MERGE: "n applied, m conflicts (box x: moved in the editor since)". Choose keep mine / keep file per conflict. | 1 day |
| 6 | **Auto-detection tuning in game** | A "sensitivity" setting (low / normal / high) and a count per kind in the panel. Needs one real drive to tune the thresholds (`M.T`). | 0.5 day + a 20 min drive |
| 7 | **Notes without typing** | Note presets (CAUTION, NARROW, BIG HOLE, CAMEL GRASS...) as buttons, so the notes field is optional. | 0.25 day |
| 8 | **Recce a new route** | Start recce with no stage: it records the line plus dropped boxes, and "SEND TO PLANNER" turns that into a draft stage (waypoints every n km + the boxes). Joins recce to the Planner. | 2–3 days |
| 9 | **Recce report** | After recce: a summary (km driven vs roadbook, boxes added/confirmed/moved/deleted, unverified auto boxes) in the console and on screen. | 0.25 day |

Suggested first batch: 1, 2, 3, 7 and 9 (about 2 days). They make recce visibly useful for fixing an existing
roadbook. Then 4 and 5 (about 2.5 days). Item 8 is its own feature.

## Open questions for Wyans

- In recce, is the main job "fix an existing roadbook" (items 1–7) or "make a roadbook from scratch while driving" (item 8)?
- Should automatic boxes go straight into the roadbook (as now, marked unverified) or only into the changes list until confirmed?
