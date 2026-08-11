#!/usr/bin/env python3
"""Structural validation of the unpacked extension.

Catches the failure mode where the code is fine but Chrome refuses to load the
folder: bad manifest, a file referenced but missing, a JS file that does not
parse, or an icon that is not actually a PNG.

    python3 tools/check-package.py
"""

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# source-probe.js is pulled in by the worker via importScripts rather than by
# the manifest, so nothing else here would notice it going missing or breaking.
JS = ["core.js", "content.js", "background.js", "options.js", "source-probe.js"]

fails = []


def ok(msg):
    print(f"  ok    {msg}")


def bad(msg):
    print(f"  FAIL  {msg}")
    fails.append(msg)


def main():
    print("extension package")

    mpath = os.path.join(ROOT, "manifest.json")
    try:
        with open(mpath) as f:
            m = json.load(f)
        ok("manifest.json parses")
    except Exception as e:
        bad(f"manifest.json does not parse: {e}")
        return 1

    if m.get("manifest_version") == 3:
        ok("manifest_version is 3")
    else:
        bad(f"manifest_version is {m.get('manifest_version')}, expected 3")

    for key in ("name", "version", "description", "action", "background"):
        if key in m:
            ok(f"manifest has {key}")
        else:
            bad(f"manifest missing required key: {key}")

    # every file the manifest points at must exist
    refs = [m.get("background", {}).get("service_worker")]
    refs.append(m.get("options_ui", {}).get("page"))
    refs += list(m.get("icons", {}).values())
    refs += list(
        m.get("action", {}).get("default_icon", {}).items()
        and m["action"]["default_icon"].values()
        or []
    )
    for r in [x for x in refs if x]:
        p = os.path.join(ROOT, r)
        if os.path.exists(p):
            ok(f"referenced file exists: {r}")
        else:
            bad(f"manifest references a missing file: {r}")

    # content scripts are injected programmatically, so assert they exist too
    for f in JS:
        p = os.path.join(ROOT, f)
        if not os.path.exists(p):
            bad(f"missing source file: {f}")
            continue
        r = subprocess.run(["node", "--check", p], capture_output=True, text=True)
        if r.returncode == 0:
            ok(f"{f} parses")
        else:
            bad(f"{f} has a syntax error: {r.stderr.strip().splitlines()[:1]}")

    # icons must be real PNGs, not empty or placeholder files
    for size, rel in sorted(m.get("icons", {}).items()):
        p = os.path.join(ROOT, rel)
        if not os.path.exists(p):
            continue
        with open(p, "rb") as fh:
            head = fh.read(8)
        if head == b"\x89PNG\r\n\x1a\n" and os.path.getsize(p) > 100:
            ok(f"icon {size} is a real PNG ({os.path.getsize(p)} bytes)")
        else:
            bad(f"icon {size} is not a valid PNG: {rel}")

    # the broad host grant must stay disabled unless deliberately turned on
    if "host_permissions" in m:
        print("  note  host_permissions is ENABLED (broad grant, opted in)")
    else:
        ok("broad host_permissions stays opt-in (not granted)")

    print()
    if fails:
        print(f"{len(fails)} problem(s)")
        return 1
    print("package is loadable")
    return 0


if __name__ == "__main__":
    sys.exit(main())
