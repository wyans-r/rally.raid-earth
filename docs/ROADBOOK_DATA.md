rally.raid Earth - what BeamNG.Earth actually builds in game, and what the roadbook may say about it (18 Nov 2026)
==================================================================================================================

Source of truth: the BeamNG.Earth source on this box, /workspace/beamng.earth (version 1.10.1-beta330, commit f51896f,
15 Nov 2026), its SOURCES.md, docs/OSM_TAGS.md (the project's own inventory of every OpenStreetMap key it reads) and
the server modules named below. [CODE] = read in that code. [INFERRED] = my reading of what follows from it, not
checked in game.

Words used once: OSM = OpenStreetMap. Overture = Overture Maps, a cleaned-up repackaging of OSM (plus other sources)
that BeamNG.Earth downloads; it renames OSM tags into its own "class / subclass" fields. DEM = digital elevation
model (the height map). WorldCover = ESA WorldCover 2021, a 10 m satellite land-cover map (trees, shrub, grass, crop,
built-up, bare, snow, water, wetland). Graded = BeamNG.Earth smooths a road's height profile before building it.

1. WHERE THE GAME WORLD COMES FROM
---------------------------------
- Roads, tracks, railways, buildings, water, land use, bridges / tunnels: Overture Maps releases, read in small
  ranges around you (SOURCES.md "Map data"; server/overture.py LAYERS: transportation/segment, buildings, base/water,
  base/land_use, base/infrastructure, places, divisions). Overture's road data is OSM's highway ways. [CODE]
- Extra OSM road tags (surface, smoothness, width, lanes, bridge, lit ...): OSM US "Layercake" (data.openstreetmap.us),
  optional; Overture carries the surface too (road_surface rules). [CODE: osmtags.py, overture.py]
- NOT read: Overture's "land" layer and OSM natural=* (no natural, landuse, waterway or tracktype key in
  docs/OSM_TAGS.md; overture.py LAYERS has no base/land). So natural=bare_rock / scree / stone / sand / peak / valley /
  ridge polygons and points are NOT drawn as such. [CODE]
- Ground heights: Mapterhorn terrain tiles (Copernicus GLO-30 30 m globally, national lidar to 1 m in parts of Europe
  and the US), AWS Terrain Tiles as backup. In Morocco this is GLO-30 (30 m). [CODE: SOURCES.md, dem.py]
  The roadbook generator already reads the same Mapterhorn tiles (zoom 12). [CODE: roadbook-gen.js DEM_SOURCES]
- Ground surface physics (what the tyres feel) and the ground photo: ESA WorldCover class per 2 m sample, then
  ROCK wherever the ground is steeper than 35 deg (snow excepted). Bare / sparse land (class 60) = loose dusty dirt,
  shrub (20) = dusty, grass / crop = grass / dirt, wet = mud. [CODE: surface.py CLASS_MATERIAL, ROCK_SLOPE_DEG = 35]
  The generator already reads the same WorldCover tiles. [CODE: roadbook-gen.js LANDCOVER]
- Rocks (3D boulders 0.4 - 2 m) and bushes: scattered on a 6 m grid by WorldCover class. Bare / sparse ground: a rock
  in 8 % of cells, kept with the local slope (none on flat playas under 2 %, all of them over 10 %, slope over +-40 m);
  shrubland: rocks in 4 % of cells, grass 0.3 %. None on beaches, none within 60 m of built-up land, none on a road's
  footprint (roads are masked out, plus 1.5 m). [CODE: vegetation.py SCATTER_P, ROCK_SLOPE = (0.02, 0.10), _scatter]
  So: in the desert, rocky ground in game = bare land on any slope from about 2 %, densest from 10 %; tracks themselves
  are clear, the rocks lie beside them; off-piste you drive through them. [CODE + INFERRED]
- Road / track surfaces: surface=rock / rocky / bedrock on a way = the ground's ROCK material painted along it (no
  smooth dirt strip); gravel / compacted / fine_gravel = gravel strip; dirt / ground / sand / earth = dirt strip.
  OSM's surface=stone is read as stone PAVING (cobbles), not a rock track. [CODE: roads.py ROCKISH, COBBLE_ALIASES]

2. WHICH WAYS EXIST IN GAME
---------------------------
- Built as roads (roads.py STYLE): motorway, trunk, primary, secondary, tertiary, residential, living_street,
  unclassified, service, track (3.5 m, dirt by default), unknown, raceway, busway, and cycleways that are filtered
  streets. [CODE]
- NOT built: highway=path, footway, bridleway, steps, pedestrian, and ordinary cycleways ("Classes not here
  (footway, path, steps, cycleway, ...) are left out for now", roads.py STYLE). On a path you only see the ground photo
  (a faint line if the aerial shows one) over natural terrain. [CODE]
- Height profile (grading.py): built roads are smoothed (Gaussian sigma 12 m; residential 14, unclassified 16, tertiary
  20, secondary 25, primary / trunk / motorway 40 m) so DEM noise and small humps go; gravel / dirt roads 8 m; minor
  dirt roads and tracks only 6 m with a 10 m median ("tracks keep their small real bumps"); 16 m where the DEM is the
  coarse global model. Off the road network the raw DEM is the ground. [CODE: SIGMA_M, CLASS_SIGMA_M,
  DIRT_SIGMA_MINOR_M, DIRT_SIGMA_COARSE_M]
- Extra road roughness (bumps.py) is OFF by default (BNE_BUMPS = 0), and even on it makes no potholes or ruts. [CODE]

3. OBJECTS THE GAME PLACES (and does not)
-----------------------------------------
Built [CODE]: buildings from footprints (all Overture buildings; silos / tanks / water towers / chimneys get shapes),
bridges and their decks for mapped bridge segments of the drivable classes above (bridgetypes.py, deckspans.py),
tunnels, rivers and streams as River objects (riverlines.py: river / stream / canal, NOT drains, ditches or
intermittent ones), lakes and the sea, high-voltage power lines with a pylon at each mapped vertex (powerlines.py),
wind turbines, communication towers and water towers (worldprops.py), oil pump jacks, fuel stations, level-crossing
gates / lights (railways.py), chain-link fences, noise walls and stone walls (fences.py: "Other fences and walls are
left out"; gate nodes only cut a gap in a built fence), town signs, traffic signals / signs on roads.
NOT built [CODE: absent from the code and the tag inventory]: cattle grids, plain field / barbed-wire fences and gates
outside France, wells, springs, cairns, survey markers, milestones off highways, ruins as such (only if mapped as a
building footprint), mosques / churches as such (a plain building if a footprint exists), peaks, saddles, valley or
ridge labels (the terrain shows them, nothing names them), intermittent wadis as water (only their DEM channel).

4. MAPPING: data -> roadbook note / symbol
------------------------------------------
Key: KEEP = stays as it was; ADD = new; GATE = only when the condition holds; DROP = not generated any more.

| data                                              | roadbook note / symbol                        | action | why
|---------------------------------------------------|-----------------------------------------------|--------|------------------------------------------
| WorldCover bare (60), slope 2-10 %+, off-piste    | STONY / ROCKY (symbol stones), "!" from 10 %  | ADD    | game scatters boulders there [CODE]
| WorldCover shrub (20) off-piste                   | STONES + VG                                   | ADD    | 4 % rock cells there [CODE]
| track on bare land with slope >= 6 %              | STONY EDGES (stones), danger 0                | ADD    | rocks beside the clear track [CODE+INF]
| DEM slope > 35 deg across / along the line        | ROCK, SLABS (rock symbol)                     | ADD    | ROCK ground material [CODE]
| surface=rock / rocky / bedrock on the route way   | ROCKY P (rock), danger 1                      | ADD    | ROCK material along it [CODE]
| OSM natural=bare_rock / scree / stone / rock near | ROCKS / SCREE (stones)                        | GATE   | only where WorldCover is bare / shrub too: the
|                                                   |                                               |        | game draws WorldCover, not natural=* [CODE]
| surface=gravel / compacted (tracktype grade1-2)   | PP (gravel road), as before                   | KEEP   | gravel strip [CODE]
| smoothness bad .. impassable >= 300 m             | BAD P / 4x4                                   | GATE   | tracks only (built roads are graded smooth)
| highway=track grade4/5, path, bridleway, footway  | FOLLOW TRACES (P -V / P E3)                   | ADD    | faint or not built in game: you follow the
|                                                   |                                               |        | traces on the ground photo [CODE: STYLE]
| bridge=* on the route way, drivable class, aligned| BRIDGE                                        | GATE   | built only for drivable classes; a bridge
|                                                   |                                               |        | crossing over the route is not "on" it
| bridge on path / footway / bridleway              | -                                             | DROP   | not built [CODE]
| DEM bump / ditch / step on a built road           | -                                             | DROP   | grading smooths them away [CODE]
| DEM bump / ditch / step on a track or off-piste   | BUMP / DITCH / STEP                           | KEEP   | tracks keep their bumps; off-piste = DEM
| DEM crest / dip / compression on primary+ roads   | -                                             | DROP   | 40 m smoothing [CODE]; climbs / descents stay
| waterway river / stream / canal crossing          | CROSS RIVER / STREAM (ford)                   | KEEP   | River object [CODE]
| intermittent stream, wadi, drain, ditch           | CROSS WADI (dry)                              | KEEP   | DEM channel only, no water [CODE]
| barrier=fence chain_link, wall, noise wall        | FENCE / WALL, FIND GAP                        | GATE   | only these are built [CODE]
| barrier=fence (other), hedge outside France        | -                                             | DROP   | not built [CODE]
| barrier=gate / lift_gate etc.                     | -                                             | DROP   | not built as an object [CODE]
| barrier=border_control / toll_booth               | BORDER POST / TOLL                            | KEEP   | real control points (stage info) [INF]
| barrier=cattle_grid                               | -                                             | DROP   | not built [CODE]
| railway level crossing / railway crossing         | LEVEL CROSSING / CROSS RAILWAY                | KEEP   | crossing kits built [CODE]
| highway=traffic_signals / stop                    | TRAFFIC LIGHTS / STOP                         | KEEP   | built on roads [CODE]
| place=village/town near the route                 | village / THROUGH ...                         | KEEP   | buildings + town signs [CODE]
| power=line crossing, power=tower                  | UNDER POWER LINE / PYLON                      | KEEP   | built [CODE]
| wind turbine, communication tower, water tower,   | landmark                                      | KEEP   | built [CODE]
| silo / tank / chimney (with a footprint), fuel    |                                               |        |
| ruins, mosque / church, cemetery                  | landmark                                      | GATE   | only if mapped as an area / building
| well, spring, cairn, survey point, guidepost,     | -                                             | DROP   | nothing placed in game [CODE]
| windpump, monument / milestone nodes              |                                               |        |
| natural=peak / volcano / hill with a name         | "PEAK <NAME> 2 KM onR" landmark               | KEEP   | the terrain shows it (DEM) [INF]
| waterway=river / stream / wadi run alongside, or  | FOLLOW WADI / ALONG RIVER (valley)            | ADD    | DEM valley + River object / channel
| DEM valley floor along the line (any mode)        | IN VALLEY / IN WASH                           | ADD    | the DEM is the ground [CODE]
| DEM ridge along the line                          | ON RIDGE                                      | KEEP   | (extended to tracks)
| lake / reservoir / sea in view                    | LAKE <NAME> onL                               | ADD    | water is built [CODE]
| WorldCover changes (trees, crop, wet)             | IN TREES / FIELDS / MARSH                     | KEEP   | drawn from WorldCover [CODE]

Not available to the generator (left out): exact boulder positions (they are hashed by BeamNG.Earth per 6 m cell, so
the generator can only say where rocks are likely), and anything BeamNG.Earth's optional regional sources add.
