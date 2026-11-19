#!/bin/sh
# Copy the latest stage builder into this folder's site/ directory, then deploy
# to https://rrearth.wyans.net.
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
# /mod and the zips are on GitHub Releases since 17 Nov 2026: _redirects sends /mod, /mod.html and /download/*.zip there
cp "$SRC/_redirects" "$SITE/_redirects"
rm -f "$SITE/mod.html"
cp "$SRC/credits.html" "$SITE/credits.html"
# receives saved work copied over from stagebuilder.wyans.net (deploy/redirect-worker)
cp "$SRC/migrate.html" "$SITE/migrate.html"
cp "$SRC/mobile.css" "$SITE/mobile.css"
cp "$SRC/mobile.js" "$SITE/mobile.js"
cp "$SRC/share.js" "$SITE/share.js"
cp "$SRC/track-router.js" "$SITE/track-router.js"
cp "$SRC/stage-polish.js" "$SITE/stage-polish.js"
cp "$SRC/stagegen-core.js" "$SITE/stagegen-core.js"
cp "$SRC/stagegen.js" "$SITE/stagegen.js"
cp "$SRC/stagegen.css" "$SITE/stagegen.css"
# 19 Nov 2026: Changelog tab. CHANGELOG.md comes from the repo root on every deploy, so the tab shows what is pushed
if [ -f "$SRC/changelog.js" ]; then cp "$SRC/changelog.js" "$SITE/changelog.js"; fi
if [ -f "$ROOT"/CHANGELOG.md ]; then cp "$ROOT"/CHANGELOG.md "$SITE/CHANGELOG.md"; fi
rm -rf "$SITE/examples"
cp -a "$SRC/examples" "$SITE/examples"
# No Overpass extracts on main (the shared cache is on the branch overpass-cache); clear any left from the B20 deploy
rm -rf "$SITE/overpass-extracts"
# 19 Nov 2026 (wyans): rally viewer retracted from the public site until there is a featured reason for it.
# Do not copy rally.html, rally-view.js or rallies/. Remove leftovers from an earlier deploy folder.
rm -f "$SITE/rally.html" "$SITE/rally-view.js"
rm -rf "$SITE/rallies"
# No zips hosted here (GitHub Releases). NOT YET (held until wyans checks the event in game):
# stage-chain.js, calendar.html, calendar.json (EXAMPLE_FLAGS.rallyEvents stays false in index.html)
rm -rf "$SITE/download"

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
