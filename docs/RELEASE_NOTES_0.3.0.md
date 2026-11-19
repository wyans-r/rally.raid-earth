# rally.raid Earth 0.3.0 (19 Nov 2026), PRE-RELEASE

**Pre-release: not tested in game yet.** This build has NOT been tested in game for: the repair fixes, the GPS app's RALLY mode, and RECCE editing in the Planner app (also unlimited recovers). The last fully driven build is [v0.2.0](https://github.com/wyans-r/rally.raid-earth/releases/tag/v0.2.0), and the website's download links still point to it. Please report anything that misbehaves.

You need **BeamNG.drive** with **BeamNG.Earth** installed. Plot stages for free at **[rrearth.wyans.net](https://rrearth.wyans.net)**.

## Download and install

`rallyraid_earth.zip` (below, under Assets). Put it in `%LOCALAPPDATA%\BeamNG\BeamNG.drive\current\mods\` **without unzipping it**, replacing the 0.2.0 zip (keep the same filename). Then remove the old Repair and Rally apps from your HUD layout if you had them (they are now inside the GPS app).

## What's new since 0.2.0

**Three HUD apps instead of five**
- **rally.raid Earth GPS**: the rally computer. Its MENU now has **REPAIR** (mid-stage repairs, spare wheels, suspension / radiator, bivouac time and engine change), **Recover car**, crash resume and **RALLY** mode (experimental).
- **rally.raid Earth Planner**: build a stage by driving it, plus the **RECCE** panel to fix the loaded stage's roadbook as you drive.
- **rally.raid Earth Roadbook**: the roadbook reader only (recce edits show in it live).

**Repairs**
- Four repair fixes: a wheel change now sticks, no instant re-puncture after a wheel change, steering works after a suspension repair, and Recover only rights the car (no free repair).
- Bivouac: an engine change takes 90 min of bivouac time **plus a 2 h time penalty** on the next stage; whole-car repair times are unchanged (docs/REPAIR.md).

**Recover car**
- **Unlimited** recovers, allowed anywhere (the 1 km-from-ASS rule is gone). Each costs **15 min** the first time in a rally and **30 min** after that.
- The game's own reset key stays unlimited, with a penalty and a full repair.

**Roadbooks (generator 0.5.x, also on the website)**
- Notes match what BeamNG.Earth builds: rock notes (in dune fields too), valley / wadi / landmark notes, "FOLLOW TRACES" for minor tracks, no phantom bumps or bridges.
- **At least 300 m between boxes**. Closer notes are merged into one box ("AT 180 CROSS WADI"). Danger notes, junctions and speed zones are never dropped, and waypoints keep their own box.
- Off-piste stretches inside track and road legs (the hop onto the road, gaps, the tail after it ends) now go round obstacles and steep ground instead of cutting straight across.
- Lines can follow the ground between boxes, with the note saying what to follow ("FOLLOW VALLEY FLOOR 2.1 KM, GENERAL CAP 152", "SKIRT HIGH GROUND ON R"). Along a valley the line keeps to the valley centre unless that gets too steep.
- Fix: tulip drawings with crossing ticks no longer fail (NaN in the SVG).

**Routing (website)**
- "Tracks & paths" and road routing are consistent; longitudes that wrapped round the world (some older files) are corrected; smaller map-data requests in towns.
- "Generate name and description" also sets the stage id from the start and finish places (e.g. `abteh-to-msied`).

**Other**
- In-mod links now point to rrearth.wyans.net (the old stagebuilder.wyans.net address still redirects).

Not an official BeamNG or FIM/FIA product. Map data © OpenStreetMap contributors (ODbL); full credits on the website and in the README.
