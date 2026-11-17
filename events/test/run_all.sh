#!/bin/sh
# every test, on a fresh local database: Lua (mod), node unit, local Worker e2e, Lua check of the served pack,
# browser (desktop + phone), in-game app preview. ~1 min. Never touches Cloudflare (wrangler --local only).
set -e
EV=/workspace/rallyraid-events
WR=/workspace/cf/node_modules/.bin/wrangler
export WRANGLER_SEND_METRICS=false
pkill -f "wrangler.*wrangler.local.jsonc" 2>/dev/null || true
sleep 1
cd $EV/worker && rm -rf .wrangler/state
$WR d1 migrations apply rallyraid-events --local -c wrangler.local.jsonc > /tmp/wmig.log 2>&1
($WR dev --local -c wrangler.local.jsonc --port 8787 --ip 127.0.0.1 > /tmp/wdev.log 2>&1 &)
for i in $(seq 1 40); do curl -sf 127.0.0.1:8787/api/auth/providers > /dev/null && break; sleep 0.5; done
cd /workspace/rallyraid && /workspace/.luavenv/bin/python tests/run_tests.py | grep -E "passed|FAIL"
cd $EV
node --test test/checks.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)"
node --test --test-concurrency=1 test/e2e.test.mjs 2>&1 | grep -E "^(✖|ℹ (pass|fail))"
/workspace/.luavenv/bin/python test/pack_in_lua.py
node test/browser.test.cjs
node test/event_app_preview.cjs
