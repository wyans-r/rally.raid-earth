#!/bin/sh
# Copy the latest stage builder into this folder's site/ directory, then deploy
# to https://stagebuilder.wyans.net.
#
# Requires CLOUDFLARE_API_TOKEN in the environment (never commit it).
# Optional: CLOUDFLARE_ACCOUNT_ID (also set in wrangler.jsonc).
# Does nothing unless you run it. Do not run this without wyans' own approval.
set -e
HERE="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
ROOT="$(CDPATH= cd -- "$HERE/../.." && pwd)"
SRC="$ROOT/stage-builder"
SITE="$HERE/site"

if [ -z "$CLOUDFLARE_API_TOKEN" ]; then
  echo "CLOUDFLARE_API_TOKEN is not set. Export it in your shell or use a .env file (not committed)."
  exit 1
fi

mkdir -p "$SITE"
cp "$SRC/index.html" "$SITE/index.html"
for f in roadbook.html roadbook-editor.js roadbook-editor.css roadbook-gen.js roadbook-render.js roadbook-pdf.js; do
  cp "$SRC/$f" "$SITE/$f"
done
cp "$SRC/mod.html" "$SITE/mod.html"
cp "$SRC/credits.html" "$SITE/credits.html"
cp "$SRC/mobile.css" "$SITE/mobile.css"
cp "$SRC/mobile.js" "$SITE/mobile.js"
cp "$SRC/share.js" "$SITE/share.js"
cp "$SRC/track-router.js" "$SITE/track-router.js"
cp "$SRC/stage-polish.js" "$SITE/stage-polish.js"
cp "$SRC/stagegen-core.js" "$SITE/stagegen-core.js"
cp "$SRC/stagegen.js" "$SITE/stagegen.js"
cp "$SRC/stagegen.css" "$SITE/stagegen.css"
rm -rf "$SITE/examples"
cp -a "$SRC/examples" "$SITE/examples"
# No Overpass extracts on main (the shared cache is on the branch overpass-cache); clear any left from the B20 deploy
rm -rf "$SITE/overpass-extracts"
# The public download zip is published only after wyans' in-game test OK.
# This script does not copy a zip into site/download.

WR="$(command -v wrangler || true)"
if [ -z "$WR" ] && [ -x "$ROOT/node_modules/.bin/wrangler" ]; then
  WR="$ROOT/node_modules/.bin/wrangler"
fi
if [ -z "$WR" ]; then
  echo "wrangler is not installed. From the repo root: npm i wrangler --save-dev"
  exit 1
fi
cd "$HERE"
"$WR" deploy
