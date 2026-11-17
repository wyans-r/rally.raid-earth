Browser checks (headless Chrome through puppeteer-core; paths inside assume the project at /workspace/rallyraid):

    npm i puppeteer-core@23
    node build_sample.js   # builds the sample stage in the stage builder (routes through OSRM), screenshot builder.png
    node track_mode_test.js # leg mode "tracks & paths" (track-router.js) with Overpass answered from tests/fixtures/tracks:
                           # follows a track, flags a straight gap, Overpass down, old "track" files, GPX option, export /
                           # import. Screenshot screens/trackfix_test.png. Unit tests: node --test tests/track_router.test.js
    node ui_test.js        # clicks, delete, export / import round trip, GPX import, rules edit (needs /tmp/t.gpx)
    node preview_app.js    # renders the HUD app outside the game (tests/app_preview.html), screenshots gps_app*.png
    node roadbook_browser_test.js  # roadbook generator in Chrome: Mapterhorn tiles decoded client-side, heights = node's
    node examples_test.js  # the builder's Examples menu: every example loads, validates, matches its file
    node guide_test.js     # the builder's guide cards and links from the editor
    node roadbook_editor_test.js   # roadbook editor (stage-builder/roadbook.html): terrain-first generate, cache,
                                   # Overpass failure, box edits (move / notes / symbols / tulip drag / split / pin),
                                   # line edit + per-leg re-plan, regenerate keeps edits, save / load, hash warning,
                                   # A5 + roll PDF. Screenshots roadbook_editor*.png, PDFs in roadbook/preview/
    node roadbook_builder_test.js  # builder -> editor hand-off (Roadbook button, same stage hash), no notes fields
                                   # in the waypoint editor, an older stage file's notes kept for migration
    node preview_roadbook_app.js   # in-game Roadbook reader (+ recce panel and quick-pick) + GPS BOX line outside the game
                                   # (tests/roadbook_app_preview.html), screenshot roadbook_app.png

    node recce_import_test.js      # editor: import an in-game recce file (tests/fixtures/recce, written by
                                   # tests/recce_test.lua), review, apply, conflicts, undo, km from the driven line.
                                   # Screenshot roadbook_editor_recce.png

    node repair_app_test.js        # in-game Rally Raid Repair app outside the game (tests/repair_app_preview.html):
                                   # stage menu, spare limit, REPAIR ids, bivouac budget warnings. Screenshot repair_app.png
    node resume_app_test.js        # RECOVER CAR + game-crash resume in the Rally Raid Repair app (tests/resume_app_preview.html):
                                   # recover: the confirm (penalty, recoveries left, where to, which damage), CONFIRM /
                                   # CANCEL, refusal + RETIRE (asks first), CLOCK STOPPED, the outcome, the menu button
                                   # (and switched off); game crash: the offer, RESUME / DISCARD (asks first), older-save
                                   # and penalty lines, HELD + GO, REVIEW, retired over a limit. resume_app.png
    node planner_app_test.js       # in-game Rally Raid Planner app outside the game (tests/planner_app_preview.html,
                                   # a mock of rallyRaid/planner.lua; map servers blocked = offline): new stage, drive
                                   # with REC, points by button and key, offline roadbook, boxes at the car, save + load,
                                   # draft; its files open in the real builder and editor, website files come back
                                   # unchanged; no-crypto.subtle page. Screenshot planner_app.png

rb_harness.js serves stage-builder/ on a free port and answers elevation tiles and Overpass from roadbook/cache, so
the roadbook tests run offline (an Overpass query that is not cached gets a 504, as a busy server would).
Run with NODE_PATH=/workspace/rr-tools/node_modules.
- `render_legend.js`: renders the roadbook symbol legend to `roadbook/fim_symbol_legend.png` and checks every symbol (and alias) parses as a standalone SVG and draws something.
