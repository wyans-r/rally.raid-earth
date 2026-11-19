# rally.raid Earth roadbook format (schema version 1)

A roadbook is its own UTF-8 JSON file, `<stage id>.roadbook.json`, that belongs to one stage file
(`docs/STAGE_FORMAT.md`). It is kept separate so it can be refined (editor, in-game recce) and shared on its own,
without touching the stage that the GPS / timing uses.

Life of a roadbook:

1. **Route** the stage in the builder.
2. **Generate** a draft: `RoadbookGen.generate(stage)` (`stage-builder/roadbook-gen.js`) reads terrain heights and
   OpenStreetMap along the route and writes every box with `source` `auto-dem` / `auto-osm` / `auto-landcover` /
   `auto-route`. Since generator 0.2 it also names what a crew can *see* from each box (OSM landmarks, the vegetation
   from ESA WorldCover, small DEM features); see "What the generator writes" below.
3. **Recce** in game (recce mode, below): drive the stage, confirm / move / retag / delete auto boxes, drop new boxes, and let
   the car's own data add boxes. Every change is a *change record* (below) applied with `RoadbookGen.applyChanges`.
4. **Edit** in the roadbook editor (`stage-builder/roadbook.html`, the builder's Roadbook button) for competition
   polish. Edits are change records too (`by: "editor"`), so edited boxes are pinned and keep their history.
5. **Regenerate** at any time (route changed, better OSM): `RoadbookGen.mergeRegenerated(old, fresh, stage)` keeps
   all human work and only refreshes the untouched auto boxes.

**Golden rule (as for stages): every position is WGS84 lat / lon.** BeamNG.Earth rebases its world, so nothing in
here is a game coordinate. Recce mode converts the car's position with `beamngEarth_api.pose()` / `toGeo`.

## Top level

| field | type | meaning |
|---|---|---|
| `format` | string | always `"rallyraid-roadbook"` |
| `schemaVersion` | int | `1`. Readers refuse a higher number; new optional fields keep `1` |
| `id` | string | `<stage id>-rb` |
| `name` | string | shown in tools |
| `stage` | object | `{id, name, hash, lengthKm}`: the stage this belongs to. `hash` = `sha256:` of the stage's waypoints (id, type, lat, lon at 6 decimals) and route legs (`RoadbookGen.stageHash`). A different hash means the stage changed since: distances may be stale, run *regenerate* |
| `generator` | string | tool + version that last wrote it (`rallyraid-roadbook-gen 0.1.0`) |
| `created`, `modified` | ISO 8601 UTC | |
| `revision` | int | whole-file revision, +1 on every merge / applied batch of changes |
| `settings` | object | generator settings used: `density` (most boxes in any 10 km, on tracks and off-piste counted separately; default 4), `stepM` (sampling step), `mergeM` (features closer than this share a box), `junctionsInSpeedZones` (`turns` / `all`) |
| `sources` | object | `elevation` `{name, primary, url, zoom, tiles, attribution}`, `osm` `{endpoint, fetched, elements}`, `landmarks` `{elements, failedChunks}` (the landmark / landform Overpass queries; `null` = not fetched), `landcover` `{name: "esa-worldcover-2021", tiles, failures, knownPct}` (`null` = not used), `attribution` (print this on the roadbook; names ESA WorldCover when it was used) |
| `stats` | object | `boxes`, `lengthKm`, `offPisteKm`, `onPisteKm`, `per10km {overall, offPiste, onPiste}`, `byKind`, `danger` (count per level 0-3) |
| `speedZones` | array | `{fromKm, toKm, limit}` from the stage's DZ / FZ |
| `profile` | object | `{stepKm, km[], h[]}`: smoothed ground height (m) every ~50 m, for editors and plots |
| `route` | object | the line the roadbook follows: `{legs: [{from, to, mode, km, points, planned?, vertexInfo?}]}`. Road legs are the stage's; every off-piste (`direct`) leg is replaced by the **planned driven line** (`planned: true`), see *Off-piste line* |
| `planner` | object / null | how the off-piste line was made: `settings`, `obstacles` (`{elements, failed}` from OSM), and per leg `{from, to, vertices, longestStraightM, meanSegM, straightLenM, lineLenM, reasoned, fabricated}` |
| `boxes` | array | the boxes in route order, see below |
| `conflicts` | array | change records that could not be applied (see *Merging*), for the editor to resolve |
| `editor` | object | optional, written by the editor: `lineOverrides` `{"<from>><to>": [[lat, lon], ...]}` (an off-piste leg drawn / dragged by hand, used as it is by the next generate) and `legSeeds` `{"<from>><to>": n}` (the "new variation" counter of a leg). Generate passes both to the planner, so a regenerate reproduces the line you chose |
| `partial` | string | optional: `"terrain-only"` when OpenStreetMap could not be reached (no junctions / fords / gates yet); regenerate later `"driven-heights"` (made by the in-game planner with no internet: waypoint boxes, tulips from the route, climbs / descents / crests from the heights driven in the game) or `"route-only"` (the same with no heights) |
| `ingame` | object | optional, written by the in-game planner when it generated the roadbook: `{mode: "full" \| "terrain-only" \| "driven-heights" \| "route-only", at, by, offlineReason}` (`docs/INGAME_PLANNER.md`). The website editor does not use it: it keeps it on save and drops it when it regenerates |

## Roadbook text in older stage files (migration)

Before the roadbook editor existed, the builder let you type notes and a danger level on each stage point; they were
stored on the stage's own `roadbook.boxes[]` (`notes`, `danger`). That field is now deprecated
(docs/STAGE_FORMAT.md): roadbook text lives only here, so the two can never disagree. When a roadbook is generated
from such a stage, `migrateStageNotes` moves the text in:

- a waypoint's text goes on that waypoint's box; a NOTE point's text on the auto box within `mergeM` of it, or on a
  new box at that spot. What the generator found there is kept after the author's text (unless it is only a CAP).
- those boxes become `pinned`, `source: "editor"` (`sources` keeps the auto source too), with a history entry
  `by: "stage-file"`, and `migrated: true`; `stats.migratedFromStage` counts them. A regenerate keeps them like any
  other edit (same `autoKey`, so they are not added twice).
- NOTE points without text still get a box at their spot (an ordinary auto box).

The builder no longer offers these fields. It passes text from an older file through unchanged (read-only) and
writes none for new points; the game reads stage `notes` only when no roadbook file exists.

## Off-piste line

A real off-piste section is not driven on the straight line between waypoints. `RoadbookGen.planOffPiste` replaces each
`direct` leg with a planned line (cost-surface A* on a 30 m grid over the same Mapterhorn terrain; slope, climbing,
faces over ~22 %, cliffs, OSM buildings / water / military areas (blocked), woods / scrub / wetland (expensive),
fences and walls (cost of a detour), cells that read exactly 0 m (sea or coastal flat: 3x), plus a smooth seeded noise
field, so it is deterministic per stage). The path is simplified to drivable pieces (250 m minimum, heading changes of
5 deg or more) and straights longer than 1.8 km (3 km on a genuinely flat pan) get small seeded doglegs.

- The line starts and ends exactly at the leg's waypoints / boxes, so every waypoint is passed at 0 m.
- Every bend becomes a box (`features[].kind = "cap"`) with the CAP out, the turn in the tulip and, where the planner
  knows why, a reason: `go left round dune`, `follow interdune corridor right`, `keep right of trees`, `avoid steep
  slope, go left`, `keep inland, right`, `along fence to a gap, left`. `vertexInfo[k]` per line point:
  `{reason, side, obstacle, climbSaved}`, or `{reason: null, fabricated: true}` for a pure variation dogleg.
- **Off-piste stretches of track / road legs (0.5.0)**: the same planner runs on the parts of a `track` or `road` leg
  that are not on a mapped way: the hop from a waypoint onto the road / track, gaps where no mapped way connects, and
  the tail after the way ends (`leg.cover.gaps` and `leg.off`, docs/STAGE_FORMAT.md), when a piece is at least
  `planMinGapM` (150 m). Each piece is planned between its own two end points and spliced back in, so it joins the
  road / track exactly; the rest of the leg is untouched. The route leg then carries `gapsPlanned: true`, `offSegs`
  (segment numbers, segment s = points[s-1] -> points[s]) and `vertexInfo` (`{gap: true, ...}` on planned bends); those
  segments are read as off-piste (CAP boxes, reasons), the rest as road / track. Pieces the builder already planned
  (a `leg.off` run of more than one segment) are kept as drawn. `planGaps: false` turns this off.
  `RoadbookGen.planLegGaps(leg, opts)` does the same for one leg (the builder calls it after routing a leg).
- **Terrain to follow and valley runs (0.5.0 / 0.5.1)**: each piece of the planned line is labelled with what it
  follows (`vertexInfo[k].follow`: `follow valley floor`, `follow dune corridor` (only where the ground is rough along
  the piece itself), `follow foot of escarpment on L/R`, `skirt high ground on L/R`), from the ground 150 / 300 / 600 m
  either side. A bend inside a run with the same guidance (under `followMaxTurn`, 50 deg) is no new box; the box where
  the run starts says "FOLLOW VALLEY FLOOR 2.1 KM, GENERAL CAP 152". On a valley-floor run two candidate lines are
  built: (a) the minimum-slope line (A* over the run's box, cost = length x (1 + 12 x slope^2) + climbing, no noise) and
  (b) the approximate valley centre (midway between the walls, `valleyWallM` 10 m higher, up to `valleyMaxHalfM` 600 m
  out, on a cross-section every 60 m); both smoothed (~400 m running mean, simplified to 30 m, no piece under 150 m).
  The shorter one is driven if its along-line grade keeps within `planMaxUp` / `planMaxDown` (22 % / 35 %) and it
  crosses nothing blocked; else the other; if neither, the planner's own line stays (`stats[].valley[]` lists both
  lengths, grades and the pick; `planValleyCentre: false` turns it off).
- All roadbook distances (`km`) are along this line. The stage file is not changed: the in-game GPS keeps the waypoint
  CAPs and the stage's km. Optionally `RoadbookGen.applyPlannedLine(stage, roadbook)` (or `RB_WRITE_STAGE=<file>
  node roadbook/tools/gen.js ...`) writes a copy of the stage whose `direct` legs carry the planned points
  (`planned: true`) with leg / waypoint / roadbook-box `km` re-summed and waypoint `cap` untouched, so the trip-meter
  snap at each waypoint matches the roadbook.

## `boxes[]`

| field | type | meaning |
|---|---|---|
| `n` | int | box number 1..N in route order (`null` for a deleted box). Renumbered after every change |
| `id` | string | stable id. Waypoint boxes use the waypoint id; auto boxes `rb-<kind>-<km x 100>`; recce / editor boxes any unique string (recce uses `rc-<time>`) |
| `km` | number | total distance from the DSS, 0.01 km: what the trip meter reads at the box |
| `partial` | number | km since the previous (not deleted) box |
| `capIn`, `capOut` | int | heading (degrees true) arriving at / leaving the box along the route. `cap` = `capOut` (what the GPS / stage format call `cap`) |
| `waypoint` | string / null | the stage waypoint id at this box |
| `label` | string | `DSS`, `WPM 2`, `NOTE`, `DANGER` ... |
| `lat`, `lon` | number | where the box is (6 decimals) |
| `offPiste` | bool | box is on a `direct` (off-piste) leg |
| `symbols` | string[] | symbol codes, most important first (list below) |
| `danger` | int | 0-3, printed `!`, `!!`, `!!!` |
| `notes` | string | instruction text (auto text joins several features with `. `) |
| `tulip` | object | the drawing as data (below). A future editor may add `svg` (hand-drawn override) |
| `features` | array | what the generator found here: `{kind, ...measurements}` e.g. `{kind:"descent", grade:17, maxGrade:24, len:300, relief:51, danger:1}`, `{kind:"junction", instr:"KEEP LEFT", ...}`, with `osm` tags for OSM features. Informational; recce may add `{kind:"jump", airtime:0.8, by:"recce-auto"}` |
| **provenance** | | |
| `source` | string | who made the box: `auto-dem` (terrain heights), `auto-osm` (OpenStreetMap), `auto-landcover` (ESA WorldCover land cover), `auto-route` (waypoint boxes and filler CAP / "stay on track" boxes), `recce-auto` (detected from the car in recce), `recce-manual` (dropped by the driver in recce), `editor` (made in the roadbook editor) |
| `sources` | string[] | every source that contributed (an `auto-osm` box confirmed in recce: `["auto-osm","recce-manual"]`) |
| `autoKey` | string | for auto boxes: `<kind>:<km>` or `wp:<id>`, the identity used to match a box across regenerations |
| `verified` | bool | someone drove / checked it (recce confirm, recce manual box, editor) |
| `pinned` | bool | a human changed it: regeneration must not replace or move it (except re-measuring `km` from its lat/lon when the route changed) |
| `deleted` | bool | tombstone: a human removed an auto box. It stays in the file (pinned) so regeneration does not bring it back; renderers skip it |
| `orphan` | bool | set by regeneration when a kept box is now > 150 m from the changed route: needs a look |
| `rev` | int | box revision, +1 on every change |
| `history` | array | `{rev, at, by, change, note}` per change, oldest first |

Readers must ignore fields they do not know; writers must keep them.

### What the generator writes (0.2)

Everything below comes from data; nothing is made up. With no landmark / land-cover data a box just says less.

- **Landmarks** (`auto-osm`, separate Overpass queries so the main OSM cache stays valid): objects within sight of a box
  (150-450 m depending on the object; named peaks 2.5 km, the sea shore 2 km) get the 1-2 most prominent named in
  the notes with side and distance in FIM shorthand: `RUIN onL 100`, `PYLON onR`, `TOWARDS MAST`, `BTW 2 TREES`,
  `SEA onL 1.8 km`, `IN ORCHARD`, `SA (sandy)` / `EMP (stony)` inside OSM sand / scree areas. The box gets the
  symbol (`ruins pylon electric_line antenna tanks well cairn post mosque cemetery fort petrol tree palm_tree trees rocks
  sign_post road_works buildings water soft_sand vegetation towards`) and a feature `{kind:"landmark", what, word,
  side, d, osm:"node/123"}`. Things behind the crew are skipped, a point object is named once, a shore / area / peak
  again 10 km on, the same word not twice within 1.5 km. Crossing a power line is its own box (`landmark_cross`,
  "UNDER POWER LINE"); a prominent object within 40-80 m of the line can be a box of its own (`landmark_pass`).
- **Land cover** (`auto-landcover`): ESA WorldCover 2021 10 m classes (via Microsoft Planetary Computer tiles, CORS
  open, so the browser builder gets it too), the majority within +-100 m of the line. Off-piste a lasting change
  (>= 300 m either side) is a box (`cover`: "VG: VG (BUSH)", "VG: GRASS TUFTS", "IN TREES", "IN FIELDS",
  "END VG, open ground"), and a box inside vegetation says so ("IN VG (BUSH)"). On a track only trees, fields and
  marsh are noted (the road itself reads as built-up). Unknown cover (no tile) = nothing said.
- **Small DEM features**: `bump`, `ditch` (narrow, < 4 m deep; deeper = `wadi`), `step_up` / `step_down` (>= 4 m
  over 40 m with gentler ground either side). Not in dunes or broken ground, not next to a crest / dip box, at most one
  per 2 km. A crest box where the line turns >= 25 degrees gets `over_crest` ("L OVER CREST").
- **Ground**: a box that would only say CAP gets the ground class symbol (`flat` / `rolling` / `broken`) when it
  changed since the last box that said it (or 5 km on).
- **Shorthand**: track kinds as `RO` (tarmac / dual), `PP` (gravel, principal track), `P` (track), `TRACES` (a grade 4/5
  two-track or a path: not a real piste; was `P -V` / `P E3` before 0.4), `P SA` (sand track), `HP` (off-piste). Junctions: `kpL` / `kpR` / `kpS` (+ `keep_left` / `keep_right`
  symbols), `TURN L on P (name)`, `FPP` / `FRO` when you stay on the biggest road. `QT PP, HP` leaving a track,
  `RP P (track)` joining one, `END RO, PP (gravel road)` at a surface change, fillers `FRO` / `FPP` / `FOLLOW P`,
  dunes `DNX 3.2 km, L2 (~12 m, max 20 m)` (L1 small, L2 medium, L3 big).

`stats.enrich` counts it all: `landmarks`, `landmarkPass`, `powerLineCrossings`, `cover`, `coverChanges`,
`coverKnownPct`, `terrain`, `overCrest`, `bumps`, `ditches`, `steps`, `offPisteCapOnlyPct` (off-piste boxes whose only
symbol is `cap`).

### Density (0.2)

`settings.density` is the most boxes in any 10 km of the route, counted separately on tracks and off-piste
(slider 2-25, default 4 = rally-like: gaps of 2-8 km over similar ground, ~10 km at most). The generator collects
every candidate box, ranks them and drops the least important until every 10 km window is under the limit:

1. **Never dropped**: waypoints, danger >= 2, junctions with a real choice (an obvious straight-on along the biggest
   road past smaller tracks can go), gates / cattle grids / fences, leaving / joining / crossing a track, road or
   railway, every turn of the planned off-piste line of `capKeepTurn` (10) degrees or more, speed zones, and every
   pinned / editor / recce box (those are never touched by a regeneration either).
2. **Then by importance** (`max(item priority) + 3 per extra item`): hazards and terrain changes, large CAP changes,
   then small CAP changes, landmark-only boxes and fillers last.

Fillers (`FRO` / `FPP` / `FOLLOW P`, or a CAP) are added only where a gap is longer than `maxGapKm`
(default 40 / density km, at least 1; road fillers every `roadFillerKm`, default 40 / density, at least 5).
The off-piste planner also follows the slider: at low density it keeps only ~0.6 x density / 10 km turning points
(never one turning > 35 degrees or making the line > 25 % longer) and allows longer straight-ish legs (still
dog-legged, never dead straight), so a sparse roadbook has fewer, bigger CAP changes. The editor shows the effect
next to the slider: "now: N boxes, median gap X km, longest Y km".

Notes are stored in upper case except the FIM mixed-case abbreviations `onL onR kpL kpR kpS`, which the renderer,
editor, PDF and in-game app keep as written (`RoadbookRender.noteCase`).

### Notes that match the game (0.4, 18 Nov 2026)

Wyans: "let's match up roadbook notes to things beamng earth actually populates". Source of truth: BeamNG.Earth's
own code (v1.10.1-beta330), written up in `BEAMNG_EARTH_DATA_1118.txt` (box) / `docs/ROADBOOK_DATA.md`.

- **Rocks** (`rocks`, `auto-landcover`): BeamNG.Earth scatters rocks from the same ESA WorldCover tiles: bare ground only
  on slopes (none under 2 %, full at 10 %, slope over +-40 m), shrubland a steady 4 %, nothing on built roads, near
  towns or on beaches; ground over 35 degrees is rock. So off-piste (and on paths, which the game does not build):
  bare 5 %+ `STONY`, 10 %+ `ROCKY, SLOW !`, shrub `STONES IN VG`, over 70 % `ROCK, STEEP !`; on a track over bare 10 %+
  ground `ROCKS BOTH SIDES`; `surface=rock|rocky|bedrock` on the way `ROCKY P 400 M` (`rocky_track`). The same ground
  once per 3 km unless it gets worse. Dune fields included (Wyans 18 Nov: the game puts stones on dune flanks too). OSM scree / bare rock areas (`EMP (STONY)`) only where WorldCover is bare / shrub.
- **Valleys, wadis, rivers**: `FOLLOW VALLEY 1.2 KM` (DEM: both sides >= 4 m higher for 400 m+) off-piste and on tracks
  (not on tarmac); `ALONG RIVER onL (DRAA) 2.0 KM`, `FOLLOW WADI`, `IN WADI BED` (`along_water`: an OSM river / stream /
  canal / wadi within 150 m running the same way for 600 m+; a dry wadi needs the route in its bed or the valley in
  the DEM); `ON RIDGE` on tracks too. Named lakes / reservoirs: `LAKE <NAME>`.
- **Ambient notes**: rocks, valleys, rivers, ridges, rocky track and TRACES do not get a box of their own on a sparse
  roadbook; when theirs was pruned they ride on the next box that is there anyway (200 m before .. 1.5 km in, at most
  4 note parts / 5 symbols). No extra boxes: spacing, merging and density are unchanged (`stats.enrich.ambient`).
- **Dropped (not in the game)**: gates, chains, bollards, cattle grids (border posts and tolls stay); fences other than
  chain-link, and hedges / ditches / embankments as barriers (walls stay); wells, springs, cairns, survey points,
  sign posts, windpumps, monuments, milestones, border stones, mapped boulders; ruins / mosques / forts / cemeteries /
  storage tanks mapped only as a point (as a building or area they stay: Overture builds the footprint).
- **Bridges**: only where the route's own way (matched within 12 m, running within 30 degrees) is a bridge and is a
  class the game builds (not path / footway / bridleway). Before, an overpass the route ran under could give BRIDGE.
- **DEM bumps / crests**: the DEM is a surface model (houses, bridge decks, trees in it) and the game grades built
  roads (grading.py: residential 14 m .. primary+ 40 m smoothing; tracks 6 m + a 10 m median, so they keep small
  bumps). `bump` / `ditch` only off-piste / on tracks, not in built-up cover, not within 80 m of a bridge or crossing;
  steps not on graded roads; crests / dips not on secondary+ unless blind; a jump on a graded road is a crest;
  `BAD P` (smoothness) only on tracks. `stats.enrich.terrainDropped` counts what was dropped.

### Spacing, junction complexes and wording (0.3)

- **Minimum spacing**: no two boxes closer than `minSpacingM` (250 m since 0.5.0; was 150), or `fastSpacingM` (300 m;
  was 200) when both are on a tarmac / gravel road (RO / PP). Real roadbooks: neither the FIM / W2RC nor the Dakar
  rules set a minimum box distance, but the Dakar roadbook lexicon treats a partial under 300 m as a "short distance"
  and combines elements that close into one "extended note" with the distance in it; sample rally rolls run about one
  box per 0.6-1 km with only a few under 300 m. Boxes still under `shortFlagM` (300 m) from the one before get
  `short: true`. Plotted NOTE points now ride on a box within `minSpacingM` too (0.4.0 used 70 m). Two boxes closer than that become one: the things that matter (never-prune items:
  real-choice junctions, crossings, gates, leaving / joining a track, planned CAP turns; anything with danger) move into
  the first box of the pair (into the waypoint's box when one is a waypoint), so a run of junctions and crossings is one
  box describing the way through it; the rest of the weaker box is dropped. Exceptions: two waypoints keep their own
  boxes, a must-keep box just before a waypoint keeps its own spot (the waypoint box cannot move back) unless it is
  within `wpShortM` (100 m) of it, then it joins the waypoint box, and pinned /
  author / recce boxes are never moved or merged (`stats.merged`, `stats.spacingKept`).
- **Which junctions are a choice** (`feature.choice`): a turn, a fork (a side road within 50 degrees of the way on),
  or straight on while a bigger road leaves. Not a choice (pruned and merged like any note, never "must keep"): straight
  on past smaller or crossing roads, following the same road round a bend past smaller streets, and anything else when
  only side streets leave a main road. The other carriageway of a dual road is recognised by name / ref or, when
  unnamed, as the same class of one-way road running parallel within 15 degrees.
- **Junction complexes**: junctions and crossings in one box become tulip nodes in travel order (within 45 m = one
  node, its biggest turn is the turn there). Two or more nodes are drawn as a path (`tulip.pre`, below) and written in
  order: `TURN R ON P (CROSS TRACK), AT 80 TURN L ON P (NORTH)` (AT = metres after the first step).
- **Wording** (generated text only; author, editor and recce text is never rewritten): upper case except
  `onL onR kpL kpR kpS`; danger first, then the action (the way through), then what confirms it (village, landmark),
  then terrain; at most 3 parts from the box's own features plus landmarks up to 4 parts in all; one CAP per box (the
  heading after the last turn, the same as the CAP column); names in Latin script only (`name:en`, `int_name`,
  `name:latin`, `name:fr`, else the Latin part of `name`, else the road `ref`, else nothing); no question marks.
  Examples: `X-ROADS kpS FRO`, `CROSS WADI (UNIAB)`, `FENCE, FIND GAP`, `CROSS RO (375) x2` (both carriageways),
  `STEEP DESC. 33%, 180 M`, `SIDE SLOPE 25%, DROPS R`, `DNX 3.2 KM L2 (~12 M)`, `THROUGH HASSILABIED, SLOW`,
  `CAP 025, FOLLOW CORRIDOR L`, `SUCC. CRESTS 340 M, BLIND`.

### Tulip data

```json
"tulip": {"entry": {"track": "gravel"}, "exit": {"angle": -38, "track": "track"},
          "branches": [{"angle": 25, "track": "twotrack", "highway": "track", "name": null},
                       {"angle": 90, "track": "water", "cross": true}]}
```

A junction complex (0.3) adds the earlier nodes; the top-level `exit` / `branches` are the last node (the arrow), so
an old reader still draws the final decision:

```json
"tulip": {"entry": {"track": "gravel"}, "exit": {"angle": -90, "track": "track"}, "branches": [{"angle": 90, "track": "track"}],
          "at": 80, "pre": [{"at": 0, "angle": 90, "track": "track", "branches": [{"angle": -90, "track": "track"}]}]}
```

`at` = metres after the box; each node's `angle` is the turn there relative to the heading arriving at that node, and
its `branches` are relative to that same heading. The renderer draws the path from the entry dot, node gaps scaled to
their distance and labelled in metres, the arrow on the last exit only. Files without `pre` render exactly as before.

Angles are degrees relative to the arrival heading (`capIn`): 0 = straight on, negative = left, positive = right,
180 = back. The entry always comes from the bottom of the drawing. `branches` are side roads at a junction (from the
real OSM geometry ~40 m out), or `cross: true` lines the route cuts through (a track off-piste, a river, a fence,
a railway). Track classes and how they are drawn (FIM legend "tracks"): `tarmac` (hollow double line), `dual` (dual
carriageway: double line with a centre line), `gravel` (thick; principal track), `track` (single), `twotrack` (dash-dot:
low visible track / traces), `sand` (dotted thick), `path` (thin dashed), `offpiste` (dotted, HP), `water`, `fence`, `railway`.

### Symbol codes

The library follows the 2026 FIM World Rally-Raid / Dakar roadbook legend (sources: `docs/fim-symbols/SOURCES.md`;
the drawings are our own). `RoadbookRender.GROUPS` is the authoritative list, `NAMES` the legend names; the legend
sheet is `roadbook/fim_symbol_legend.png` and the editor's **Symbol legend** button.

- **on track**: `crest bump dip compression ditch jump step_up step_down climb descent hole ruts twisty undulations
  broken sideslope_l sideslope_r narrow`
- **dunes / terrain**: `dunes broken_dune dunes_end bowl soft_sand wadi ridge valley flat rolling rocks cliff water`
- **route**: `junction keep_left keep_right track_left track_right continue bend hairpin over_crest cap offpiste
  join_track cross_track towards reset_trip surface`
- **crossings**: `ford bridge under_bridge gate cattle_grid fence barbed_wire wall railway`
- **landmarks**: `village buildings ruins mosque cemetery fort well tanks petrol post electric_line pylon antenna
  sign_post cairn animals road_works`
- **vegetation**: `tree trees palm_tree vegetation camel_grass`
- **safety**: `danger stop speed_<km/h>`
- **waypoints / controls**: `DSS ASS CP WPV WPE WPM WPN WPS WPC WPP DZ FZ`

Aliases (`RoadbookRender.ALIAS`, FIM wording) draw the same symbol, e.g. `summit`→`crest`, `bumpy`→`undulations`,
`bumpy_broken`→`broken`, `wading`→`ford`, `fence_gate`→`gate`, `caution`→`danger`. Writers keep the code as given;
renderers draw unknown codes as text. Danger is drawn the FIM way: `!` / `!!` / `!!!` in red, a red line under the km
at danger 2 and above, a red frame round the box at danger 3. Notes may use the FIM abbreviations (`RoadbookRender.ABBR`:
`P PP RO HP FPP FRO SA GV VG kpL kpR kpS onL onR CX E3 QT NBX IMP ORN RP BTW DN DNX DNT ...`); the editor inserts them.

## Change records (recce and editor)

Recce mode and the editor never rewrite the file wholesale; they produce a list of changes:

```json
{"op": "confirm", "id": "rb-crest-1740", "baseRev": 1, "by": "recce-manual", "at": "2026-11-20T18:02:11Z"}
{"op": "move",    "id": "rb-crest-1740", "baseRev": 2, "by": "recce-manual", "lat": -19.8461, "lon": 12.9921, "km": 17.46}
{"op": "update",  "id": "rb-dip-2396",   "baseRev": 1, "by": "recce-manual", "fields": {"danger": 2, "symbols": ["compression"], "notes": "Big compression"}}
{"op": "delete",  "id": "rb-terrain-3226","baseRev": 1, "by": "recce-manual"}
{"op": "add",     "id": "rc-1763661731",  "by": "recce-auto", "box": {"km": 21.08, "lat": -19.82, "lon": 13.0, "symbols": ["jump"], "danger": 2, "notes": "Jump, 0.9 s airtime", "features": [{"kind": "jump", "airtime": 0.9}]}}
```

`ops`: `add`, `update`, `confirm`, `move`, `delete`. `by`: `recce-auto`, `recce-manual`, `editor`. `baseRev` = the
box's `rev` when the change was made (so a recce file recorded against an older roadbook can be detected).

Applying (`RoadbookGen.applyChanges(rb, changes)`):
- `add`: new box, `source` = `by`; `recce-manual` / `editor` boxes are `verified` and `pinned`; `recce-auto` boxes are
  neither until someone confirms them.
- `confirm`: `verified = true` (not pinned: the content is still the generator's, so a regeneration may refresh the
  numbers, but a verified box is always kept).
- `move`, `update`: change the fields, `pinned = true`, `verified = true` (unless the change is `recce-auto`).
- `delete`: tombstone (`deleted`, `pinned`).
- every applied change: `rev + 1` and a `history` entry; then boxes are re-sorted by `km` and renumbered.
- **conflict**: a change with `baseRev` older than the box's `rev`, on a box that was pinned in the editor, by
  anyone but the editor, is not applied; it goes to `conflicts[]` with a reason. Recce never overwrites desk edits
  silently; the editor shows the conflict and the user picks.

### Recce edits for an existing roadbook (17 Nov 2026)

- **Distance from the trip meter.** KM = TRIP and -10 / +10 write a `move` with `km` only (no `lat`/`lon`) and
  `"kmOnly": true, "oldKm": <km before>`. Repeated edits of one box in a row are one change. The partials after it
  follow, because boxes are re-sorted and renumbered by km.
- **CAP from the car.** CAP HERE writes an `update` with `fields: {cap, capOut}` (degrees, from the car's heading), plus `oldCap`.
- Both use the existing ops, so `M.applyChanges`, the merge and the stage builder's import (`RoadbookGen.applyChanges`)
  need no change.
- **Report.** REPORT, and every recce off, writes `/rallyraid/recce/<stage id>.report.txt` and `.report.json`
  (`format: "rallyraid-recce-report"`) to the user folder. They hold the counts per kind, unverified automatic boxes,
  driven km and every change not merged yet, with its box number, km and text.

## Merging a regeneration (`RoadbookGen.mergeRegenerated(old, fresh, stage)`)

- **Kept** from the old file: every box that is `pinned`, `verified`, `deleted` (tombstones) or whose `source` is
  `recce-auto`, `recce-manual` or `editor`.
- **Replaced**: all other (untouched auto) boxes are dropped and the fresh run's boxes come in, except a fresh box
  whose `autoKey` equals a kept box's, whose waypoint already has a kept box, or that lies within `mergeM` (70 m) of a
  kept box. So a deleted auto box stays deleted and a moved one does not reappear at its old spot.
- If `stage.hash` changed, kept boxes get their `km` re-measured from their lat/lon on the new route (`history`
  notes it); boxes now more than 150 m off the route get `orphan: true`.
- `revision + 1`, `created` kept, boxes renumbered and partials recomputed.

## Game side

- The mod (`lua/ge/extensions/rallyRaid/stages.lua`, `loadRoadbook`) looks for the roadbook when a stage loads:
  the stage's `roadbook.file`, else `rallyraid/roadbooks/<stage id>.roadbook.json`, else
  `<stage file name>.roadbook.json` next to the stage (such files are not listed as stages). It refuses another
  stage's roadbook, a different `format` or a newer `schemaVersion`; it warns when `stage.lengthKm` differs from the
  stage by more than 200 m.
- Live boxes (not `deleted`) sorted by km and renumbered are sent to the **rally.raid Earth Roadbook** HUD app
  (`ui/modules/apps/RallyRaidRoadbook/`, drawn with the same `roadbook-render.js`), which shows the current box and
  the next three with tulips, symbols, notes, CAP and danger, scrolling with the trip. Box up / down (Ctrl+Shift+PgUp
  / PgDn) scrolls without touching the trip; SYNC (Ctrl+Shift+End) sets the trip to the shown box; any trip adjust
  returns the display to the odometer. The GPS app shows `BOX n > km to the next`.
- The waypoints take their `km` from their waypoint boxes, so the trip snap at each waypoint matches the printed
  roadbook (the planned off-piste line is a little longer than the stage's straight legs).
- Recce mode: see *Recce* below.

## Editor and PDF

- `stage-builder/roadbook.html` + `roadbook-editor.js` / `.css`: opened from the builder (the stage is handed over
  in `localStorage['rallyraid-roadbook-stage']`, `?from=builder`), with `?example=<id>`, or with a stage file.
  Generate shows terrain boxes first (`onPartial`) while OpenStreetMap loads; elevation tiles and Overpass answers
  are cached in IndexedDB (`rallyraid-roadbook` database), Overpass mirrors are tried in turn with exponential
  backoff and a 120 s timeout. The work is autosaved in the same database per stage id.
- `stage-builder/roadbook-pdf.js` (jsPDF, loaded on demand from unpkg): `RoadbookPDF.build(rb, {format: 'a5' |
  'roll'})`. 148 mm wide; A5 pages hold 6 boxes, the roll format makes strips up to 4.5 m long. A cover page with the
  stage summary and how to read the boxes, then per box: total / partial km and box number, the tulip, symbols +
  notes + CAP + danger. Page headers: stage, box and km range, page n / N.

## Recce (in game)

Recce mode (`lua/ge/extensions/rallyRaid/recce.lua`) is switched on in the rally.raid Earth Roadbook app (RECCE) once a
stage is loaded (no default key; bindable as "rally.raid Earth: recce mode on / off"). It can run on a timed stage too, but the result is then marked unofficial.

What it records, all in lat / lon from `beamngEarth_api.pose()` (game coordinates are only used inside one frame for
the car's motion, so the world's rebasing cannot break anything; frames during a rebase are skipped):

- **The driven line**: a point every 10 m, `[lat, lon, km driven]`; a jump of more than 250 m between two fixes
  (teleport, reset) starts a new piece (`breaks`) and adds no distance.
- **What the car detects** (`by: "recce-auto"`, added as boxes that stay unverified until someone confirms them):
  - *jump*: proper acceleration along the car's up axis (`dv/dt + g`, what an accelerometer in the car would feel)
    near zero for at least 0.35 s; airtime, length (take-off to landing), height above the take-off and drop;
    danger 1-3 from airtime / length. The landing's g-spike is not counted as a compression.
  - *compression*: 2.4 g or more on the up axis (not within 0.6 s of a jump's landing), with the peak g.
  - *crest*: nose up at least 6 deg, then nose down at least 6 deg within 30 m, at 8 m/s or more, on the ground.
  - *soft sand*: under 30 km/h, throttle over 40 %, the driven wheels turning 35 % faster than the car moves, for
    2.5 s (the vehicle's `electrics.values.wheelspeed` / `throttle`, asked four times a second); "bogging" under 8 km/h.
  - *climb / descent*: grade 25 % or more for 30 m or more; *side slope*: 30 % (17 deg) or more across for 25 m.
    Grades come from ray casts to the ground 8 m ahead / behind and 4 m left / right of the car (`castRayStatic`),
    or from the car's pitch / roll when the game does not answer the ray casts.
  - the same kind found twice within 40 m is one box (the more dangerous one kept); a detection within 60 m of a
    roadbook box with the same symbol is noted as `box.near` = that box's id, for the editor to compare.
- **What the driver does** (`by: "recce-manual"`), on the RECCE panel's buttons in the Planner app (18 Nov: moved there from the Roadbook app, which is a reader now and shows each edit live; no default keys; each is bindable):
  - **+ BOX HERE**: a new box at the car (lat / lon and the trip km); the app shows the quick-pick: 30 common symbols (QUICK tab), every legend group as a tab and a symbol search,
    danger 0-3, notes; SAVE (or + BOX HERE again) adds it, CANCEL drops it.
  - The app shows the nearest roadbook box within 150 m: ✓ confirm, HERE move it here,
    TAG retag (the quick-pick filled with its symbols / danger / notes), ✕ delete.
  - UNDO takes back the last change. Every change shows on the roadbook display at once.

### The recce file

`/rallyraid/recce/<stage id>.recce.json` (BeamNG user folder / current / rallyraid / recce /), saved after every
change and every 15 s of driving; switching recce on again for the same stage continues it ("new recce" forgets it):

```json
{"format": "rallyraid-recce", "schemaVersion": 1, "created": "...", "started": "...", "updated": "...",
 "stage": {"id": "nam-ss2-...", "name": "...", "hash": "sha256:..."},
 "roadbook": {"id": "nam-ss2-...-rb", "revision": 3, "file": "/rallyraid/roadbooks/nam-ss2-....roadbook.json"},
 "driven": {"stepM": 10, "km": 12.43, "points": [[-19.83, 13.01, 0.0], ...], "breaks": [412]},
 "changes": [ ...change records not yet merged... ],
 "applied": [ ...change records already merged in game... ],
 "mergedInto": {"revision": 4, "at": "...", "applied": 9, "conflicts": 1, "rescaled": 0, "backup": "..."}}
```

Change records are the ones above, plus `drivenKm` (km along the driven line) on `add` boxes and `move` records.
`baseRev` is the box's `rev` as the game saw it (counting the recce's own earlier changes to it). Lists may be written
by the game as JSON objects (`{"1": ...}`, `{}`); readers accept both.

### Merging

- **In game**: MERGE in the app (`rallyRaid_core.cmd('recceMerge')`) copies the roadbook to
  `/rallyraid/recce/backup/<stage id>.rev<n>.roadbook.json`, applies the changes with the same rules as
  `RoadbookGen.applyChanges` (the Lua and JS results are compared in the tests), writes the roadbook back, moves the
  changes to `applied` and reloads the display. A change on a box edited in the editor since the recce read it
  becomes a `conflicts[]` entry (the editor shows them). With **km** ticked, the km are re-measured from the driven line.
- **In the editor**: *Recce...* imports the file: the driven line (purple) and a marker per change on the map, and a
  review list (new / conflict / already in this roadbook) with a checkbox per change; *Apply* runs them through
  `applyChanges` (undo takes the whole import back). Boxes added in recce get their km measured on the roadbook's
  route unless *Re-measure km from the driven line* is ticked. Boxes from the recce carry a RECCE flag; boxes the car
  detected carry CHECK until someone confirms them.
- **Re-measuring km** (`M.rescale` / `RoadbookGen.rescaleToDriven`): every live box within 60 m of the driven line gets
  the distance driven to it, counted from the first box on the line (which keeps its km); boxes off the line are spaced
  in proportion between the boxes on it. The roadbook's distances then match what the trip meter read on the recce
  drive; `rb.recce = {drivenKm, matched, at}` and each box's history note it.
