# Async events MVP: merge and deploy steps (NOT done yet: each live step needs Wyans' OK)

## 0. What exists now
* **Web copy:** `/workspace/rallyraid-events/`
  - `site/` is a copy of `stage-builder/` taken at 05:55 CST on 2026-11-17 (hashes in `BASE_SNAPSHOT.sha256`).
  - It adds `site/events/` and one "Events" link each in `index.html` and `mod.html` (`merge/site-links.patch`).
* **Worker:** `worker/src/*.js`; D1 schema in `worker/migrations/0001_events_mvp.sql`.
* **Mod:** already in `/workspace/rallyraid/mod`. A backup from before the change is in `/workspace/backups/mod_before_events_20261117_0550.tgz`.
  - New files: `sha256.lua`, `trace.lua`, `official.lua` and the `ui/modules/apps/RallyRaidEvent/` app.
  - Changed: `core.lua` (VERSION 0.2.0).
  - New test: `tests/official_test.lua`.
* **Tests:**

      cd /workspace/rallyraid-events/worker && wrangler dev --local -c wrangler.local.jsonc --port 8787 &
      cd .. && node --test test/checks.test.mjs && node --test --test-concurrency=1 test/e2e.test.mjs \
        && /workspace/.luavenv/bin/python test/pack_in_lua.py && node test/browser.test.cjs
      cd /workspace/rallyraid && /workspace/.luavenv/bin/python tests/run_tests.py

## 1. Merge into the main tree (safe, local only; do it after the Stage-Gen timeout work is finished)
1. Check that the other worker's edits did not touch `index.html` or `mod.html`, then apply `merge/site-links.patch`:

       cd /workspace/rallyraid && patch -p0 --dry-run < ../rallyraid-events/merge/site-links.patch

   If it does not apply cleanly, add the two links by hand. Each is one line.
2. `cp -a /workspace/rallyraid-events/site/events /workspace/rallyraid/stage-builder/events`
3. Keep the Worker where it is, or move `worker/` to `/workspace/rallyraid/events-worker/` and change `EV=` in `merge/deploy.sh`.
4. Rebuild the mod zip (Python zipfile, as before). It now has `RallyRaidEvent` and VERSION 0.2.0.
   - Restore the Moab sample stage from `stage-builder/examples/` first, because `build_sample` rewrites it.
   - Copy the zip to `stage-builder/download/`, and update the version on `/mod` if it shows one.

## 2. Cloudflare resources (needs Wyans' OK and token rights)
Checked at 05:55 CST with read-only list calls. The token was never printed.

| Need | Status now | Fix |
|---|---|---|
| D1 | **token has no D1 rights**: list returns auth error 10000 | dashboard → My Profile → API Tokens → edit the token → add **Account · D1 · Edit** |
| R2 | **R2 not enabled on the account** ("Please enable R2 through the Cloudflare Dashboard") | dashboard → R2 → enable. Cloudflare may ask for a card even for the free tier (10 GB free). Then add **Account · Workers R2 Storage · Edit** to the token |
| Workers deploy | works today | – |
| DNS (only if Grok Bot should add the Resend records) | not checked | **Zone · DNS · Edit** on wyans.net |

Then:

    cd /workspace/cf && . ./lib.sh
    $WR d1 create rallyraid-events          # prints the database_id -> merge/wrangler.stagebuilder.jsonc
    $WR r2 bucket create rallyraid-events
    cp /workspace/rallyraid-events/merge/wrangler.stagebuilder.jsonc stagebuilder/wrangler.jsonc   # fill the REPLACE_ values
    cp /workspace/rallyraid-events/merge/deploy.sh stagebuilder/deploy.sh
    cd stagebuilder
    openssl rand -base64 48 | $WR secret put SESSION_SECRET      # random; never shown
    $WR secret put DISCORD_CLIENT_SECRET   # from the masked entry box (LOGIN_SETUP.md A)
    $WR secret put RESEND_API_KEY          # from the masked entry box (LOGIN_SETUP.md B)

If R2 can't be enabled: the stage and roadbook files could live in D1 instead. Rows are capped at about 2 MB, which is
enough for these files and the packages (a 150 km trace is about 70 KB). It is a small code change; ask first.

## 3. Deploy (after Wyans says yes in his own words)

    sh /workspace/cf/stagebuilder/deploy.sh      # applies the D1 migration (--remote), then wrangler deploy

**Cloudflare setting that must stay as it is:** "Always Use HTTPS" is **off** on wyans.net today. The game uploads over
plain HTTP, because BeamNG's Lua has no HTTPS. If it is ever switched on, add a Configuration Rule that exempts
`/api/game/results`, or in-game upload stops and players fall back to the website upload. The Worker itself already
sends every other http:// API call to https://.

## 4. Verify live
1. The static pages still match, using the sha256 curl check as before. Add `/events/`, `/events/events.js` and `/events/events.css`.
2. `curl -s https://stagebuilder.wyans.net/api/auth/providers` should return `{"providers":["email","discord"]}`.
3. Wyans logs in. With his email in ADMIN_EMAILS he is admin. He creates a test event, adds the Moab stage and roadbook,
   locks it, enters it, downloads the pack and drives it in the game.
   - The Rally Raid Event app should say "uploaded".
   - Otherwise drop the `.rrresult.json` file on the event page.
4. Roll back: `cd /workspace/cf/stagebuilder && $WR versions list && $WR rollback <id>`. D1 and R2 data stay.
