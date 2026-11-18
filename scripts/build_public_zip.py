#!/usr/bin/env python3
"""Build the rally.raid Earth BeamNG.drive zip.

Default (public) build:
  - Top-level folders inside the zip are lua, ui, scripts, settings, rallyraid
    (no wrapper folder named after the mod).
  - Leaves out the unreleased rally.raid Earth Event app, official.lua and sha256.lua.
  - Three HUD apps (18 Nov): GPS (with REPAIR and RALLY built in), Roadbook (reader), Planner (with RECCE). The Event
    app (a COMING SOON placeholder) is never in a zip, not even with --include-events (its Lua is).
  - RALLY MODE (B10, EXPERIMENTAL - not yet tested in game): the GPS rally panel styles and rally.lua go in only with
    --include-rally (core.lua runs without them). Rally files (rallyraid/rallies/, the events) need
    --include-rally-events as well; they stay out until wyans has checked the event in game.
  - Leaves out README / LICENSE / docs (BeamNG.com asks you not to pack a readme;
    put the description on the listing instead). Credits are shown in the apps.

This script only writes a zip on disk. It does not upload it, does not copy it
to the website download folder, and does not submit it to BeamNG.com.

The public zip should be published only after wyans has said the in-game test
of the repair + planner + resume build is OK.

Usage:
  python3 scripts/build_public_zip.py
  python3 scripts/build_public_zip.py --include-events --output dist/rallyraid_earth_dev.zip
  python3 scripts/build_public_zip.py --include-rally                    (public zip since 17 Nov 2026)
  python3 scripts/build_public_zip.py --include-events --include-rally --include-rally-events --output /workspace/rallyraid_earth_b10_dev.zip
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MOD = ROOT / "mod"

# Public filename confirmed by wyans on 17 Nov 2026 (no version number, username prefix).
# Once used on BeamNG.com it should stay the same.
DEFAULT_OUT = ROOT / "dist" / "rallyraid_earth.zip"

TOP_LEVEL = ("lua", "ui", "scripts", "settings", "rallyraid")

# Paths relative to mod/, using forward slashes, for the public (default) build.
PUBLIC_EXCLUDE_PREFIXES = (
    "ui/modules/apps/RallyRaidEvent/",
    "lua/ge/extensions/rallyRaid/official.lua",
    "lua/ge/extensions/rallyRaid/sha256.lua",
)

# never in any zip (18 Nov: three HUD apps; the Event app is a COMING SOON placeholder until Async Events)
ALWAYS_EXCLUDE_PREFIXES = ("ui/modules/apps/RallyRaidEvent/",)
# RALLY MODE (B10, EXPERIMENTAL): only with --include-rally (the GPS RALLY panel hides itself without rally.lua)
RALLY_PREFIXES = (
    "ui/modules/apps/RallyRaidGPS/rally.css",
    "lua/ge/extensions/rallyRaid/rally.lua",
)
# rally files (events): only with --include-rally-events
RALLY_EVENT_PREFIXES = ("rallyraid/rallies/",)
# never in any zip: stray build / tooling files
JUNK_SUFFIXES = (".whl", ".pyc", ".log")

SKIP_NAMES = {".DS_Store", "Thumbs.db"}
SKIP_SUFFIXES = (".bak", ".bak-trackfix")


def should_skip(rel: str, include_events: bool, include_rally: bool = False, include_rally_events: bool = False) -> bool:
    name = rel.split("/")[-1]
    if name.endswith(JUNK_SUFFIXES) or "lupa" in name.lower():
        return True
    if name in SKIP_NAMES or name.startswith("."):
        return True
    if any(name.endswith(s) or rel.endswith(s) for s in SKIP_SUFFIXES):
        return True
    if name.endswith(".bak-trackfix"):
        return True
    for p in ALWAYS_EXCLUDE_PREFIXES:
        if rel == p.rstrip("/") or rel.startswith(p):
            return True
    if not include_events:
        for p in PUBLIC_EXCLUDE_PREFIXES:
            if rel == p.rstrip("/") or rel.startswith(p):
                return True
    if not include_rally:
        for p in RALLY_PREFIXES:
            if rel == p.rstrip("/") or rel.startswith(p):
                return True
    if not (include_rally and include_rally_events):
        for p in RALLY_EVENT_PREFIXES:
            if rel.startswith(p):
                return True
    return False


def iter_files():
    for top in TOP_LEVEL:
        base = MOD / top
        if not base.is_dir():
            raise SystemExit(f"missing folder: {base}")
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            rel = path.relative_to(MOD).as_posix()
            yield path, rel


def build(output: Path, include_events: bool, include_rally: bool = False, include_rally_events: bool = False) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    files = []
    for path, rel in iter_files():
        if should_skip(rel, include_events, include_rally, include_rally_events):
            continue
        files.append((path, rel))

    # Sanity: packed layout
    tops = sorted({rel.split("/")[0] for _, rel in files})
    if tops[0] not in TOP_LEVEL:
        raise SystemExit(f"unexpected zip top-level folders: {tops}")

    needed = [
        "lua/ge/extensions/rallyRaid/core.lua",
        "lua/ge/extensions/rallyRaid/gameResume.lua",
        "scripts/rallyRaid/modScript.lua",
        "settings/inputmaps/keyboard_rallyRaid.json",
        "ui/modules/apps/RallyRaidGPS/app.js",
        "ui/modules/apps/RallyRaidRoadbook/app.js",
        "ui/modules/apps/RallyRaidPlanner/app.js",
        "ui/modules/apps/RallyRaidGPS/repair.css",
        "ui/modules/apps/RallyRaidPlanner/recce.css",
        "ui/modules/apps/RallyRaidRoadbook/roadbook-render.js",
        "rallyraid/stages/moab-sand-flats-ss1.json",
        "settings/ui_apps/originalLayouts/default/rallyRaidEarth.uilayout.json",
        "settings/ui_apps/originalLayouts/default/rallyRaidEarthPlanner.uilayout.json",
    ]
    have = {rel for _, rel in files}
    missing = [n for n in needed if n not in have]
    if missing:
        raise SystemExit(f"zip is missing required files: {missing}")

    if not include_events:
        forbidden = [rel for rel in have if should_skip(rel, include_events=False, include_rally=include_rally, include_rally_events=include_rally_events)]
        if forbidden:
            raise SystemExit(f"public zip still contains excluded files: {forbidden}")
        if any("RallyRaidEvent" in rel or rel.endswith("official.lua") or rel.endswith("sha256.lua") for rel in have):
            raise SystemExit("public zip still contains Events files")

    apps = sorted({rel.split("/")[3] for rel in have if rel.startswith("ui/modules/apps/") and rel.endswith("/app.json")})
    if apps != ["RallyRaidGPS", "RallyRaidPlanner", "RallyRaidRoadbook"]:
        raise SystemExit(f"zip should have the three HUD apps (GPS, Roadbook, Planner), has: {apps}")

    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path, rel in files:
            # arcname is the path inside the zip: no wrapper folder
            zf.write(path, arcname=rel)

    if not include_rally and any(rel.startswith(p) or rel == p for rel in have for p in RALLY_PREFIXES):
        raise SystemExit("zip still contains rally mode files")
    if not include_rally_events and any(rel.startswith(p) for rel in have for p in RALLY_EVENT_PREFIXES):
        raise SystemExit("zip still contains rally event files")
    junk = [rel for rel in have if rel.endswith(JUNK_SUFFIXES) or "lupa" in rel.lower()]
    if junk:
        raise SystemExit(f"zip contains junk files: {junk}")
    if include_rally:
        for n in ("lua/ge/extensions/rallyRaid/rally.lua", "ui/modules/apps/RallyRaidGPS/rally.css"):
            if n not in have:
                raise SystemExit(f"rally build is missing {n}")

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    size = output.stat().st_size
    kind = ("dev (events included)" if include_events else "public (events omitted)") + (", rally mode included" if include_rally else ", rally mode omitted") + (", rally events included" if include_rally_events else "")
    print(f"Wrote {output} ({kind})")
    print(f"  files: {len(files)}")
    print(f"  HUD apps: {', '.join(apps)}")
    print(f"  top-level folders: {', '.join(tops)}")
    print(f"  size: {size} bytes")
    print(f"  sha256: {digest}")
    print("This zip was not uploaded or published.")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--include-events", action="store_true", help="include the unreleased Events app and official.lua")
    ap.add_argument("--include-rally", action="store_true", help="include RALLY MODE (B10, experimental): rally.lua and the GPS app RALLY panel styles (rally files need --include-rally-events)")
    ap.add_argument("--include-rally-events", action="store_true", help="also include rally files (rallyraid/rallies/); needs --include-rally")
    ap.add_argument("--output", "-o", type=Path, default=DEFAULT_OUT, help="zip path (default: dist/rallyraid_earth.zip)")
    args = ap.parse_args(argv)
    build(args.output if args.output.is_absolute() else (Path.cwd() / args.output), args.include_events, args.include_rally, args.include_rally_events)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
