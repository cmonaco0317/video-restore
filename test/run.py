#!/usr/bin/env python3
"""Headless test runner for Video Upscaler.

Serves the project on a free localhost port, drives both browser harnesses
through headless Chrome, parses their result logs, and exits non-zero if any
check FAILed.

SKIPped checks are printed but do not fail the run — they mark things this
environment genuinely cannot measure (see --virtual-time-budget note below).
They are also NOT counted as passes, so a harness that silently degrades to
all-skip will show it.

    python3 test/run.py
"""

import http.server
import os
import re
import socket
import socketserver
import subprocess
import sys
import threading
import html as htmllib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PAGES = [
    ("GPU pipeline", "test/harness.html"),
    ("DOM integration", "test/integration.html"),
    # The service worker's wiring — the three ways INTO the extension. Runs
    # against a mock chrome.* API; the real-browser half is a manual claim,
    # because Chrome 151 no longer honours --load-extension.
    ("service worker wiring", "test/background.html"),
    # Skips itself when WebGPU is absent, which it is under this runner's
    # software rasteriser. Its timings are only meaningful in a real window --
    # same caveat as the perf benchmark.
    ("WebGPU compute path", "test/webgpu.html"),
]

GREEN, RED, YELLOW, DIM, RESET = (
    "\033[32m",
    "\033[31m",
    "\033[33m",
    "\033[2m",
    "\033[0m",
)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Quiet(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass


def serve(port):
    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", port), Quiet)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def run_page(url):
    """Return the text of the harness <pre id="log"> block."""
    proc = subprocess.run(
        [
            CHROME,
            "--headless=new",
            "--no-sandbox",
            "--enable-unsafe-swiftshader",
            "--disable-dev-shm-usage",
            "--autoplay-policy=no-user-gesture-required",
            # Fast-forwards timers so the page finishes without a real wall-clock
            # wait. Side effect: performance.now() deltas are not real time, which
            # is why the perf check reports SKIP under this runner.
            #
            # Generous rather than tight: the WebGPU page waits on an adapter, a
            # fetch and real GPU work, and a budget that expires mid-flight makes
            # a page emit nothing at all — which reads as a failure and made the
            # suite flaky. Virtual time costs nothing when the page finishes
            # early, so there is no reason to be stingy.
            "--virtual-time-budget=60000",
            "--dump-dom",
            url,
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )
    m = re.search(r'<pre id="log">(.*?)</pre>', proc.stdout, re.S)
    if not m:
        return None
    return htmllib.unescape(re.sub(r"<[^>]+>", "", m.group(1)))


def main():
    if not os.path.exists(CHROME):
        print(f"Google Chrome not found at {CHROME}", file=sys.stderr)
        return 2

    port = free_port()
    srv = serve(port)
    total_pass = total_fail = total_skip = 0
    try:
        for label, path in PAGES:
            url = f"http://127.0.0.1:{port}/{path}"
            print(f"\n=== {label} ({path}) ===")
            log = run_page(url)
            if log is None:
                print(f"{RED}could not read results from {url}{RESET}")
                total_fail += 1
                continue
            print(log.strip())
            names = re.findall(r"^(PASS|FAIL|SKIP)\b", log, re.M)
            if not names:
                print(f"{RED}harness produced no checks at all{RESET}")
                total_fail += 1
                continue
            total_pass += names.count("PASS")
            total_fail += names.count("FAIL")
            total_skip += names.count("SKIP")
    finally:
        srv.shutdown()

    colour = RED if total_fail else GREEN
    print(
        f"\n{colour}{total_pass} passed, {total_fail} failed"
        f"{f', {total_skip} skipped' if total_skip else ''}{RESET}"
    )
    if total_skip:
        print(f"{DIM}SKIP = not measurable headlessly; see the detail line.{RESET}")
    if total_pass == 0:
        print(f"{RED}no checks passed — treating as failure{RESET}")
        return 1
    return 1 if total_fail else 0


if __name__ == "__main__":
    sys.exit(main())
