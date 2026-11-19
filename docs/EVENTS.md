# Async events: official runs (mod 0.2.0)

Events are listed at https://stagebuilder.wyans.net/events/ (the site part is not deployed yet).

## For drivers
1. Log in on the events page with an email code or Discord, and enter the event: pick a class and type your vehicle.
2. From the roadbook release time, download one **event pack** per stage, `<event>-ss<n>.rrevent.json`. Put it in
   `Documents/BeamNG.drive/current/rallyraid/events/`, the BeamNG user folder.
3. In the game, open the **rally.raid Earth Event** app and press **LOAD**. The game checks three things:
   - the stage and roadbook files' SHA-256 hashes against the ones published on the event page;
   - that the mod version is new enough;
   - that the event is open.

   If a check fails, the pack is refused with the reason. The same checks run again before the DSS clock starts.
4. Official mode:
   - no route on any map: the in-game planner, recce and roadbook reload are off;
   - BeamNG's reset keys are blocked;
   - the official rules are forced:
     - Recover car: no limit by default (since 18 Nov), +15 min first, +30 min each after; an event may set the old 3 / 1 / 1 km limits;
     - game-crash resume limits on, with no time penalty unless the event sets one; every resume is flagged for review.
5. At the ASS, the game writes a **result package** to `rallyraid/results/official/*.rrresult.json` and uploads it.
   - If the upload fails, the app says so. Press RETRY UPLOAD, or drop the file on the event page.

## What the result package holds
- The full stage result: times, penalties, the waypoint log, repairs, car recoveries and game-crash resumes with their
  review details.
- The hashes of the files actually loaded, and the mod version.
- The GPS trace, as rows of `[t, w, lat, lon, odo, kmh]`:
  - `t` is the stage clock;
  - `w` is seconds of wall-clock time since `trace.epoch0`;
  - `odo` is km driven in the stage;
  - a point every 5 s of stage clock, plus extra points on a turn over 30° or a speed change over 25 km/h, plus one at
    every waypoint.

Typical sizes (JSON):

| Stage | Size |
|---|---|
| 20 km | 10 KB |
| 80 km | 37 KB |
| 150 km | 67 KB |
| 250 km | 119 KB |

The trace is also in the game-crash save, so a resumed run keeps it. The time lost in the crash shows as a gap. That gap
is not counted as a "not one sitting" break, because the resume itself is reviewed.

## Uploading from the game: what BeamNG allows
- **The game's UI (CEF, where the apps run) cannot reach internet hosts.** Its Content-Security-Policy allows only
  localhost, and a native filter cancels other hosts. So the app never uploads anything itself.
- **The game's Lua has LuaSocket**, which handles plain TCP and HTTP. BeamNG.Earth uses it to reach its companion on
  127.0.0.1. It has **no LuaSec**, so **no HTTPS**.
- So `official.lua` POSTs the package over **plain HTTP** to `http://stagebuilder.wyans.net/api/game/results`.
  - The request carries the entrant's upload key, `Authorization: Bearer rrk_...`.
  - The key can only add results to that one entry. A new key can be made on the site at any time; it is an HMAC and
    is never stored.
  - The package holds nothing private.
- This is **untested inside BeamNG**. If `require('socket.http')` is missing in a game build, or a firewall blocks it,
  the file stays on disk and the website upload is the way in.
- The worker only accepts plain HTTP on this one path. Cloudflare's "Always Use HTTPS" must stay off, or that path
  must be exempted.

## Files
- `lua/ge/extensions/rallyRaid/official.lua`: packs, checks, forced rules, the package, the upload.
- `trace.lua`: the GPS trace.
- `sha256.lua`: SHA-256 in plain LuaJIT, matching the website's byte for byte (tested).
- `ui/modules/apps/RallyRaidEvent/`: the in-game app.
- Commands: `rallyRaid_core.cmd('officialList' | 'officialLoad', path | 'officialRetry' | 'officialOff')`.
- Tests: `tests/official_test.lua`. Website side: `/workspace/rallyraid-events/test/`.
