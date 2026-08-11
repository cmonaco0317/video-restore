#!/usr/bin/env python3
"""Prove the upscaled picture actually reaches a SCREEN CAPTURE.

This is the testable third of the `output-paths` claim. Zoom, Meet and every
other screen-sharing tool read the same window-server composite that macOS's
`screencapture` reads, so if the overlay is in one it is in the other. HDMI and
AirPlay mirroring consume that same composite too — but those need hardware
attached, so this script does not claim them.

Why the question is not silly: a plain <video> does NOT always survive these
paths. Video can be handed to a hardware overlay plane or a protected pipeline
that the compositor never sees, which is exactly why screen recordings of some
players come out black. The whole design of this extension — composite a WebGL
canvas INTO the page rather than take over playback — exists to avoid that. This
checks the design actually behaves that way instead of assuming it.

Method: park a video on a FIXED frame, capture the window with the upscaler off,
capture it again with the upscaler on, and compare. Every frame of the fixture is
identical by construction, so the two captures can only differ if the overlay is
in the capture. A still fixture also removes the obvious false positive — motion
between captures would produce a difference all by itself.

    python3 tools/verify-screenshare.py [--keep]

Needs: macOS, Google Chrome, ffmpeg (to build the fixture once), and Screen
Recording permission for whatever runs this. It moves a Chrome window to the
front for a few seconds.
"""

import http.server
import os
import shutil
import socket
import socketserver
import struct
import subprocess
import sys
import threading
import time
import zlib

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
WORK = os.path.join(HERE, ".screenshare-probe")
WIN = (60, 110, 1400, 830)  # x, y, w, h in points

PAGE = """<!doctype html>
<meta charset="utf-8"><title>output-path probe</title>
<style>
 html,body{margin:0;background:#111;height:100%;overflow:hidden}
 video{position:absolute;left:0;top:0;width:100vw;height:100vh;object-fit:contain;background:#000}
 #tag{position:absolute;left:8px;top:6px;z-index:99;color:#0f0;font:13px monospace;background:#000a;padding:2px 6px}
</style>
<video id="v" src="clip.mp4" muted loop playsinline></video>
<div id="tag">loading…</div>
<script src="cnn-weights.js"></script>
<script src="core.js"></script>
<script>
const v = document.getElementById('v'), tag = document.getElementById('tag');
const VU = new URLSearchParams(location.search).get('vu') === '1';
function luma() {
  const c = document.createElement('canvas'); c.width = 160; c.height = 90;
  const x = c.getContext('2d');
  try { x.drawImage(v, 0, 0, 160, 90); } catch (e) { return -1; }
  const d = x.getImageData(0, 0, 160, 90).data;
  let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i]*0.2126 + d[i+1]*0.7152 + d[i+2]*0.0722;
  return s / (160*90);
}
let settled = false;
v.addEventListener('loadedmetadata', () => { v.currentTime = 1.0; });
v.addEventListener('seeked', () => {
  v.pause();
  if (settled) return;
  settled = true;
  // Print the frame and its brightness INTO the capture. A black frame would
  // make "no difference" indistinguishable from "the overlay never arrived",
  // so the evidence has to be visible in the artifact itself.
  tag.textContent = `vu=${VU?1:0} t=${v.currentTime.toFixed(1)} ${v.videoWidth}x${v.videoHeight} luma=${luma().toFixed(1)}`;
  if (VU) { const s = document.createElement('script'); s.src = 'content.js'; document.body.appendChild(s); }
});
v.load();
</script>
"""


def png_rgba(path):
    """Decode a PNG to (w, h, RGBA bytes). No PIL — this must run bare."""
    d = open(path, "rb").read()
    i, w, h, idat, ct = 8, None, None, b"", None
    while i < len(d):
        ln = struct.unpack(">I", d[i : i + 4])[0]
        typ = d[i + 4 : i + 8]
        if typ == b"IHDR":
            w, h, _bd, ct = struct.unpack(">IIBB", d[i + 8 : i + 18])
        elif typ == b"IDAT":
            idat += d[i + 8 : i + 8 + ln]
        elif typ == b"IEND":
            break
        i += 12 + ln
    raw = zlib.decompress(idat)
    nch = 4 if ct == 6 else 3
    stride = w * nch
    out = bytearray(w * h * nch)
    prev = bytearray(stride)
    pos = 0
    for y in range(h):
        f = raw[pos]
        pos += 1
        line = bytearray(raw[pos : pos + stride])
        pos += stride
        if f == 1:
            for x in range(nch, stride):
                line[x] = (line[x] + line[x - nch]) & 255
        elif f == 2:
            for x in range(stride):
                line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x - nch] if x >= nch else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x - nch] if x >= nch else 0
                c = prev[x - nch] if x >= nch else 0
                b = prev[x]
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out[y * stride : (y + 1) * stride] = line
        prev = line
    return w, h, bytes(out), nch


def shot(port, vu, dest):
    subprocess.run(["pkill", "-f", "screenshare-chrome"], capture_output=True)
    time.sleep(2)
    subprocess.Popen(
        [
            CHROME,
            f"--user-data-dir={WORK}/screenshare-chrome",
            "--no-first-run",
            "--no-default-browser-check",
            f"--window-size={WIN[2]},900",
            f"--window-position={WIN[0]},60",
            f"http://127.0.0.1:{port}/page.html?vu={vu}",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    time.sleep(14)
    subprocess.run(
        ["osascript", "-e", 'tell application "Google Chrome" to activate'],
        capture_output=True,
    )
    time.sleep(3)
    subprocess.run(
        ["screencapture", "-x", "-R", f"{WIN[0]},{WIN[1]},{WIN[2]},{WIN[3]}", dest],
        check=True,
    )


def main():
    if sys.platform != "darwin" or not os.path.exists(CHROME):
        print("needs macOS with Google Chrome installed")
        return 2
    os.makedirs(WORK, exist_ok=True)
    for f in ("core.js", "content.js", "cnn-weights.js"):
        shutil.copy(os.path.join(HERE, f), os.path.join(WORK, f))
    open(os.path.join(WORK, "page.html"), "w").write(PAGE)

    clip = os.path.join(WORK, "clip.mp4")
    if not os.path.exists(clip):
        # A still fixture on purpose: identical frames mean the diff cannot be
        # motion, and clean.png is a real film frame rather than a synthetic one.
        r = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-loop",
                "1",
                "-i",
                os.path.join(HERE, "test", "clean.png"),
                "-t",
                "4",
                "-r",
                "30",
                "-pix_fmt",
                "yuv420p",
                "-vf",
                "scale=960:400",
                "-c:v",
                "libx264",
                "-crf",
                "18",
                clip,
            ],
            capture_output=True,
        )
        if r.returncode != 0:
            print("ffmpeg failed:", r.stderr.decode()[:300])
            return 2

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    class Q(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k):
            super().__init__(*a, directory=WORK, **k)

        def log_message(self, *a):
            pass

        def handle_one_request(self):
            # Chrome is killed between the two runs mid-transfer, which raises
            # BrokenPipeError and prints an alarming traceback into the output of
            # a tool whose whole job is to say PASS or FAIL clearly.
            try:
                super().handle_one_request()
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True

    socketserver.TCPServer.allow_reuse_address = True
    srv = socketserver.TCPServer(("127.0.0.1", port), Q)
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    try:
        off = os.path.join(WORK, "off.png")
        on = os.path.join(WORK, "on.png")
        shot(port, 0, off)
        shot(port, 1, on)
    finally:
        subprocess.run(["pkill", "-f", "screenshare-chrome"], capture_output=True)
        srv.shutdown()

    w1, h1, A, n1 = png_rgba(off)
    w2, h2, B, n2 = png_rgba(on)
    if (w1, h1) != (w2, h2):
        print(f"captures differ in size {w1}x{h1} vs {w2}x{h2}")
        return 1

    # The panel lands bottom-right and would dominate any whole-frame average,
    # so the VIDEO region is measured on its own: the middle of the window,
    # away from browser chrome and away from the panel.
    x0, x1 = int(w1 * 0.05), int(w1 * 0.75)
    y0, y1 = int(h1 * 0.15), int(h1 * 0.80)
    tot = cnt = big = 0
    for y in range(y0, y1, 3):
        row = y * w1 * n1
        for x in range(x0, x1, 3):
            i = row + x * n1
            d = (
                abs(A[i] - B[i]) + abs(A[i + 1] - B[i + 1]) + abs(A[i + 2] - B[i + 2])
            ) / 3
            tot += d
            cnt += 1
            if d >= 2:
                big += 1
    mean = tot / max(cnt, 1)
    frac = big / max(cnt, 1)
    print(
        f"capture {w1}x{h1}, video region mean |off-on| = {mean:.2f}/255, "
        f"{100*frac:.1f}% of sampled pixels changed by >=2"
    )

    ok = mean >= 1.0 and frac >= 0.20
    print(
        "PASS" if ok else "FAIL",
        (
            " the upscaled picture is present in the screen capture"
            if ok
            else " the capture is unchanged — the overlay did NOT reach it"
        ),
    )
    if "--keep" in sys.argv:
        print(f"captures kept in {WORK}")
    else:
        shutil.rmtree(WORK, ignore_errors=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
