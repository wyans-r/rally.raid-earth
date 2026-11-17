#!/usr/bin/env python3
"""Build the rally.raid Earth BeamNG.drive zip.

Default (public) build:
  - Top-level folders inside the zip are lua, ui, scripts, settings, rallyraid
    (no wrapper folder named after the mod).
  - Leaves out the unreleased rally.raid Earth Event app, official.lua and sha256.lua.
  - Leaves out RALLY MODE (B10, experimental, untested in game): the Rally app, rally.lua and
    rallyraid/rallies/ (core.lua runs without them). --include-rally puts them in.
  - Leaves out README / LICENSE / docs (BeamNG.com asks you not to pack a readme;
    put the description on the listing instead). Credits are shown in the apps.

This script only writes a zip on disk. It does not upload it, does not copy it
to the website download folder, and does not submit it to BeamNG.com.

The public zip should be published only after wyans has said the in-game test
of the repair + planner + resume build is OK.

Usage:
  python3 scripts/build_public_zip.py
  python3 scripts/build_public_zip.py --include-events --output dist/rallyraid_earth_dev.zip
  python3 scripts/build_public_zip.py --include-events --include-rally --output /workspace/rallyraid_earth_b10_dev.zip
"""
from __future__ import annotations

import argparse
import hashlib
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

# RALLY MODE (B10, EXPERIMENTAL): only with --include-rally
RALLY_PREFIXES = (
    "ui/modules/apps/RallyRaidRally/",
    "lua/ge/extensions/rallyRaid/rally.lua",
    "rallyraid/rallies/",
)

SKIP_NAMES = {".DS_Store", "Thumbs.db"}
SKIP_SUFFIXES = (".bak", ".bak-trackfix")


def should_skip(rel: str, include_events: bool, include_rally: bool = False) -> bool:
    name = rel.split("/")[-1]
    if name in SKIP_NAMES or name.startswith("."):
        return True
    if any(name.endswith(s) or rel.endswith(s) for s in SKIP_SUFFIXES):
        return True
    if name.endswith(".bak-trackfix"):
        return True
    if not include_events:
        for p in PUBLIC_EXCLUDE_PREFIXES:
            if rel == p.rstrip("/") or rel.startswith(p):
                return True
    if not include_rally:
        for p in RALLY_PREFIXES:
            if rel == p.rstrip("/") or rel.startswith(p):
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


def build(output: Path, include_events: bool, include_rally: bool = False) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        output.unlink()

    files = []
    for path, rel in iter_files():
        if should_skip(rel, include_events, include_rally):
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
        "ui/modules/apps/RallyRaidRepair/app.js",
        "rallyraid/stages/moab-sand-flats-ss1.json",
    ]
    have = {rel for _, rel in files}
    missing = [n for n in needed if n not in have]
    if missing:
        raise SystemExit(f"zip is missing required files: {missing}")

    if not include_events:
        forbidden = [rel for rel in have if should_skip(rel, include_events=False, include_rally=include_rally)]
        if forbidden:
            raise SystemExit(f"public zip still contains excluded files: {forbidden}")
        if any("RallyRaidEvent" in rel or rel.endswith("official.lua") or rel.endswith("sha256.lua") for rel in have):
            raise SystemExit("public zip still contains Events files")

    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path, rel in files:
            # arcname is the path inside the zip: no wrapper folder
            zf.write(path, arcname=rel)

    if not include_rally and any(rel.startswith(p) or rel == p for rel in have for p in RALLY_PREFIXES):
        raise SystemExit("zip still contains rally mode files")
    if include_rally:
        for n in ("lua/ge/extensions/rallyRaid/rally.lua", "ui/modules/apps/RallyRaidRally/app.js"):
            if n not in have:
                raise SystemExit(f"rally build is missing {n}")

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    size = output.stat().st_size
    kind = ("dev (events included)" if include_events else "public (events omitted)") + (", rally mode included" if include_rally else ", rally mode omitted")
    print(f"Wrote {output} ({kind})")
    print(f"  files: {len(files)}")
    print(f"  top-level folders: {', '.join(tops)}")
    print(f"  size: {size} bytes")
    print(f"  sha256: {digest}")
    print("This zip was not uploaded or published.")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--include-events", action="store_true", help="include the unreleased Events app and official.lua")
    ap.add_argument("--include-rally", action="store_true", help="include RALLY MODE (B10, experimental): Rally app, rally.lua, rallyraid/rallies/")
    ap.add_argument("--output", "-o", type=Path, default=DEFAULT_OUT, help="zip path (default: dist/rallyraid_earth.zip)")
    args = ap.parse_args(argv)
    build(args.output if args.output.is_absolute() else (Path.cwd() / args.output), args.include_events, args.include_rally)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
