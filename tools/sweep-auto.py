#!/usr/bin/env python3
"""Run test/sweep-auto.html headless and print its table.

A research sweep, not a check — it answers "does the optimal denoise / deband /
chroma strength move with source quality?", which decides whether auto-tuning
those stages is worth building at all. Reuses test/run.py's serving and Chrome
invocation rather than duplicating them.

    python3 tools/sweep-auto.py
"""

import os
import re
import subprocess
import sys
import html as htmllib

sys.path.insert(
    0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test")
)
import importlib.util

_spec = importlib.util.spec_from_file_location(
    "vu_run",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test", "run.py"),
)
vu_run = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vu_run)


def main():
    if not os.path.exists(vu_run.CHROME):
        print(f"Google Chrome not found at {vu_run.CHROME}", file=sys.stderr)
        return 2
    port = vu_run.free_port()
    srv = vu_run.serve(port)
    try:
        url = f"http://127.0.0.1:{port}/test/sweep-auto.html"
        proc = subprocess.run(
            [
                vu_run.CHROME,
                "--headless=new",
                "--no-sandbox",
                "--enable-unsafe-swiftshader",
                "--disable-dev-shm-usage",
                # The sweep renders ~140 full frames on a software rasteriser.
                "--virtual-time-budget=600000",
                "--dump-dom",
                url,
            ],
            capture_output=True,
            text=True,
            timeout=900,
        )
        m = re.search(r'<pre id="log">(.*?)</pre>', proc.stdout, re.S)
        if not m:
            print("could not read the sweep output", file=sys.stderr)
            print(proc.stderr[-2000:], file=sys.stderr)
            return 1
        log = htmllib.unescape(re.sub(r"<[^>]+>", "", m.group(1)))
        print(log.strip())
        return 0 if "DONE" in log else 1
    finally:
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
