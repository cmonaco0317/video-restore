#!/usr/bin/env python3
"""Run one of the research probe pages headless and print its output.

These are measurements, not pass/fail checks — they answer a question before any
code is written for it. Kept out of test/run.py deliberately: a sweep that takes
minutes and produces numbers is not a regression check.

    python3 tools/probe.py sweep-auto      # stage strength vs source quality
    python3 tools/probe.py probe-chroma    # can chroma be driven without a reference?
    python3 tools/probe.py probe-deblock   # real detail vs artifact, separated
"""

import importlib.util
import os
import re
import subprocess
import sys
import html as htmllib

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "vu_run", os.path.join(HERE, "..", "test", "run.py")
)
vu_run = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vu_run)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    page = sys.argv[1].removesuffix(".html")
    path = os.path.join(HERE, "..", "test", page + ".html")
    if not os.path.exists(path):
        print(f"no such probe page: test/{page}.html", file=sys.stderr)
        return 2
    if not os.path.exists(vu_run.CHROME):
        print(f"Google Chrome not found at {vu_run.CHROME}", file=sys.stderr)
        return 2

    port = vu_run.free_port()
    srv = vu_run.serve(port)
    try:
        proc = subprocess.run(
            [
                vu_run.CHROME,
                "--headless=new",
                "--no-sandbox",
                "--enable-unsafe-swiftshader",
                "--disable-dev-shm-usage",
                # These render hundreds of full frames on a software rasteriser.
                "--virtual-time-budget=900000",
                "--dump-dom",
                f"http://127.0.0.1:{port}/test/{page}.html",
            ],
            capture_output=True,
            text=True,
            timeout=1800,
        )
        m = re.search(r'<pre id="log">(.*?)</pre>', proc.stdout, re.S)
        if not m:
            print(f"could not read output from test/{page}.html", file=sys.stderr)
            print(proc.stderr[-2000:], file=sys.stderr)
            return 1
        log = htmllib.unescape(re.sub(r"<[^>]+>", "", m.group(1)))
        print(log.strip())
        return 0 if "DONE" in log else 1
    finally:
        srv.shutdown()


if __name__ == "__main__":
    sys.exit(main())
