# Merge notes
See DEPLOY.md §1. Files touched outside new folders:
- stage-builder/index.html: +1 line (Events button next to "Get the mod")      -> merge/site-links.patch
- stage-builder/mod.html:   nav line gets " · Events"                         -> merge/site-links.patch
- /workspace/cf/stagebuilder/wrangler.jsonc: static-only -> Worker + assets   -> merge/wrangler.stagebuilder.jsonc
- /workspace/cf/stagebuilder/deploy.sh: + events/, src/, migrations, d1 migrations apply -> merge/deploy.sh
New: stage-builder/events/ (from site/events/), the Worker (worker/src, worker/migrations).
Not touched: stagegen*.js, roadbook-gen.js (the Stage-Gen worker's files), the planner's roadbook-gen.js copy.
Mod (already in /workspace/rallyraid/mod; backup /workspace/backups/mod_before_events_20261117_0550.tgz):
- new lua/ge/extensions/rallyRaid/{sha256,trace,official}.lua, ui/modules/apps/RallyRaidEvent/, tests/official_test.lua
- core.lua: VERSION 0.2.0, official hooks (load/attach, pre-start check, trace points, finish package, refusals), trace in the game-crash save
- tests/run_tests.py: SHA256 helper + official_test.lua in the default list
