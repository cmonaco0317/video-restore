#!/usr/bin/env python3
"""Generate the extension icons with no third-party deps.

Draws a rounded dark tile with a cyan upward chevron over a coarse->fine pixel
row, 3x supersampled, and writes real PNGs via zlib.
"""

import math, os, struct, zlib

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")

BG_TOP = (24, 30, 46)
BG_BOTTOM = (13, 16, 26)
ACCENT = (91, 200, 255)
ACCENT2 = (143, 107, 255)


def rounded(px, py, w, h, r):
    """Signed coverage test for a rounded rect covering the whole tile."""
    x = min(max(px, r), w - r)
    y = min(max(py, r), h - r)
    return math.hypot(px - x, py - y) <= r


def seg_dist(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    L = vx * vx + vy * vy
    t = 0.0 if L == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / L))
    return math.hypot(px - (ax + vx * t), py - (ay + vy * t))


def shade(u, v, S):
    """Colour at normalised coords u,v in [0,1). Returns (r,g,b,a)."""
    x, y = u * S, v * S
    if not rounded(x, y, S, S, S * 0.22):
        return (0, 0, 0, 0)

    t = v
    bg = tuple(int(BG_TOP[i] * (1 - t) + BG_BOTTOM[i] * t) for i in range(3))

    # chevron
    cw = S * 0.115
    ax, ay = S * 0.26, S * 0.545
    mx, my = S * 0.50, S * 0.295
    bx, by = S * 0.74, S * 0.545
    d = min(seg_dist(x, y, ax, ay, mx, my), seg_dist(x, y, mx, my, bx, by))
    if d <= cw * 0.5:
        k = min(1.0, max(0.0, (x / S - 0.26) / 0.48))
        return tuple(int(ACCENT[i] * (1 - k) + ACCENT2[i] * k) for i in range(3)) + (
            255,
        )

    # pixel row: three blocks going coarse -> fine
    by0, bh = S * 0.66, S * 0.135
    for i, (bx0, bw) in enumerate(((0.24, 0.155), (0.425, 0.115), (0.575, 0.075))):
        if bx0 * S <= x < (bx0 + bw) * S and by0 <= y < by0 + bh:
            a = 90 + i * 55
            return ACCENT + (a,)
    if 0.67 * S <= x < 0.76 * S and by0 <= y < by0 + bh:
        return ACCENT + (255,)

    return bg + (255,)


def render(size, ss=3):
    rows = []
    for py in range(size):
        row = bytearray()
        for px in range(size):
            r = g = b = a = 0
            for sy in range(ss):
                for sx in range(ss):
                    u = (px + (sx + 0.5) / ss) / size
                    v = (py + (sy + 0.5) / ss) / size
                    cr, cg, cb, ca = shade(u, v, size)
                    r += cr * ca
                    g += cg * ca
                    b += cb * ca
                    a += ca
            n = ss * ss
            if a == 0:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes(
                    (min(255, r // a), min(255, g // a), min(255, b // a), a // n)
                )
        rows.append(bytes(row))
    return rows


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for s in (16, 32, 48, 128):
        p = os.path.join(OUT, f"icon{s}.png")
        write_png(p, s, render(s))
        print(f"wrote {p} ({os.path.getsize(p)} bytes)")
