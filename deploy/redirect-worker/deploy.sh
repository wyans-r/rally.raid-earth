#!/bin/sh
# Deploys the stagebuilder.wyans.net -> rrearth.wyans.net redirect Worker.
# Requires CLOUDFLARE_API_TOKEN in the environment (never commit or print it).
# Do not run this without wyans' own approval.
set -e
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
[ -n "$CLOUDFLARE_API_TOKEN" ] || { echo "CLOUDFLARE_API_TOKEN is not set."; exit 1; }
cd "$HERE" && npx wrangler deploy
