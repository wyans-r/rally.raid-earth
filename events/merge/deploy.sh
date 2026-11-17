#!/bin/sh
# goes to /workspace/cf/stagebuilder/deploy.sh at merge time. Same as the old one, plus the events page, the Worker code
# and the D1 migrations. Deploy only with Wyans' OK.
set -e
. /workspace/cf/lib.sh
SRC=/workspace/rallyraid/stage-builder
EV=/workspace/rallyraid-events          # until merged: worker/ lives here (after the merge: /workspace/rallyraid/events-worker)
SITE=/workspace/cf/stagebuilder/site
DST=/workspace/cf/stagebuilder
cp "$SRC/index.html" "$SITE/index.html"
for f in roadbook.html roadbook-editor.js roadbook-editor.css roadbook-gen.js roadbook-render.js roadbook-pdf.js; do cp "$SRC/$f" "$SITE/$f"; done
cp "$SRC/mod.html" "$SITE/mod.html"
for f in mobile.css mobile.js share.js stagegen-core.js stagegen.js stagegen.css; do cp "$SRC/$f" "$SITE/$f"; done
rm -rf "$SITE/download" && cp -a "$SRC/download" "$SITE/download"
rm -rf "$SITE/examples" && cp -a "$SRC/examples" "$SITE/examples"
rm -rf "$SITE/events" && cp -a "$SRC/events" "$SITE/events"
rm -rf "$DST/src" "$DST/migrations" && cp -a "$EV/worker/src" "$DST/src" && cp -a "$EV/worker/migrations" "$DST/migrations"
cd "$DST"
"$WR" d1 migrations apply rallyraid-events --remote
"$WR" deploy
