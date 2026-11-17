# Async Event MVP — progress log
Started 2026-11-17 05:50 CST.
- [ ] 0 explore mod/site, backups
- [x] 0 explore (05:50). Mod backup: /workspace/backups/mod_before_events_*.tgz
  - Token check (read-only list calls, token never printed): D1 list -> auth error 10000 (token has NO D1 rights);
    R2 list -> "Please enable R2 through the Cloudflare Dashboard" (R2 not enabled on the account). Zone: always_use_https=off, ssl=full.
  - Game HTTP research: GE Lua has LuaSocket (plain TCP/HTTP, used by BeamNG.Earth for 127.0.0.1); no LuaSec => no HTTPS.
    CEF UI apps: CSP connect-src only localhost; native filter cancels external hosts => UI fetch to our site is blocked.
    => in-game upload = plain HTTP POST via LuaSocket (feature-detected), fallback = package file + website drag-and-drop.
    Box egress blocks plain HTTP (Pingora 500), so cannot test http:// from here.
- Steering 05:49: login = BOTH email code (Resend, stubbed) + Discord; trace base 5 s adaptive; gap flag > 2 min excl. game-crash resumes;
  roles admin + approved organizers.
- [x] 1 mod Lua (06:15): sha256.lua (pure LuaJIT, = Python hashlib), trace.lua (5 s + turn>30° / speed>25 km/h extra points, at every WP),
  official.lua (pack load+checks, forced rules, refusals, result package, LuaSocket HTTP upload, file fallback), core.lua hooks,
  VERSION 0.2.0. tests/official_test.lua 36 pass; all old Lua tests still pass. Trace sizes: 20 km 10 KB, 80 km 37 KB, 150 km 67 KB, 250 km 119 KB.
- [x] 2a site copy of stage-builder taken 05:55 (BASE_SNAPSHOT.sha256 = the files I started from)
- [x] 2a site copy of stage-builder taken 05:55 (BASE_SNAPSHOT.sha256 = the files I started from)
- [x] 2b D1 migration worker/migrations/0001_events_mvp.sql; worker/src/checks.js + test/checks.test.mjs (15 pass) 05:58
- [x] 3 worker src (util, mail, auth, events, index), wrangler.jsonc (prod template) + wrangler.local.jsonc; local D1 migrated 06:01
- [x] 4 site/events/{index.html,events.css,events.js} front-end (list, login, account/organizer request, new/edit event, stage files, lock, enter, packs, drop upload, leaderboard+HC, review, result+trace SVG, admin) 06:04
- [x] 5 test/e2e.test.mjs 9/9 pass against wrangler dev --local (fake event end to end) 06:05
- [x] 6 browser test 9/9 ok, screenshots test/shots/*.png; Events links in index.html + mod.html 06:07
- [x] 7 docs: LOGIN_SETUP.md, DEPLOY.md, MERGE.md, merge/{site-links.patch, wrangler.stagebuilder.jsonc, deploy.sh} 06:08
- [x] 8 in-game app preview (test/shots/ingame_event_app.png); mod docs/EVENTS.md; test/run_all.sh (fresh local DB, all suites) ALL GREEN 06:10
DONE (MVP built + tested locally). NOT done (needs Wyans): Cloudflare token D1 rights + enable R2, Discord app, Resend domain/key,
merge into main tree after Stage-Gen work, deploy. See DEPLOY.md, LOGIN_SETUP.md.
