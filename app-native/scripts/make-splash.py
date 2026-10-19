#!/usr/bin/env python3
"""Draws the iPhone launch image (ios/App/App/Assets.xcassets/Splash.imageset, 2732px square, shown scaled to fill
the screen) from the same sources the web page paints its first frame with, so the hand-off doesn't jump:
- the background is index.html's .splash gradient, linear-gradient(160deg,#BFE7C6,#7CC79B 55%,#1F5A3A), on a
  2732px square (the page draws it on a max(100vw,100vh) square centred, exactly how the image is scaled to fill);
- the logo is index.html's .boot-mark SVG (outlined wordmark, coral l, yellow dot), 774px wide, centred, its
  baseline 65px below centre. app.js alignToLaunchImage() and index.html's .boot-mark rule use these numbers.
Usage: python3 make-splash.py <repo root>
"""
import re, sys, math, os
import numpy as np
from PIL import Image, ImageDraw

ROOT = sys.argv[1] if len(sys.argv) > 1 else "."
N, SS = 2732, 4                       # image size, supersampling for the logo
BOX_W, BASE_DY = 774, 65              # logo box width (4300 units) and baseline offset below centre
U = BOX_W / 4300                      # px per logo unit
LEFT, BASE = (N - BOX_W) / 2, N / 2 + BASE_DY

# --- background: CSS linear-gradient(160deg, ...) on the square, sRGB interpolation like browsers
th = math.radians(160); dx, dy = math.sin(th), -math.cos(th); L = abs(N * dx) + abs(N * dy)
yy, xx = np.mgrid[0:N, 0:N].astype(np.float64) + 0.5
t = np.clip(((xx - N / 2) * dx + (yy - N / 2) * dy) / L + 0.5, 0, 1)
stops = [(0.0, (191, 231, 198)), (0.55, (124, 199, 155)), (1.0, (31, 90, 58))]
img = np.zeros((N, N, 3))
for (a, ca), (b, cb) in zip(stops, stops[1:]):
    sel = (t >= a) & (t <= b); k = ((t - a) / (b - a))[sel]
    for i in range(3): img[..., i][sel] = ca[i] + (cb[i] - ca[i]) * k
im = Image.fromarray(np.round(img).astype(np.uint8))

# --- logo shapes from index.html
html = open(os.path.join(ROOT, "index.html")).read()
svg = re.search(r'<svg class="boot-mark"[^>]*>(.*?)</svg>', html, re.S).group(1)
paths = re.findall(r'<path fill="(#[0-9A-Fa-f]{6})" d="([^"]+)"', svg)
cx, cy, r, cfill = re.search(r'<circle cx="([-\d.]+)" cy="([-\d.]+)" r="([-\d.]+)" fill="(#[0-9A-Fa-f]{6})"', svg).groups()

def subpaths(d):
    toks = re.findall(r'[MLHVQZ]|-?\d*\.?\d+', d); i = 0; cmd = None; cur = []; out = []; x = y = 0
    num = lambda: float(toks[i])
    while i < len(toks):
        if re.match(r'[MLHVQZ]', toks[i]): cmd = toks[i]; i += 1
            # implicit repeats keep the last command (M repeats as L)
        if cmd == 'Z':
            if cur: out.append(cur); cur = []
            cmd = None; continue
        if cmd == 'M':
            if cur: out.append(cur)
            x, y = float(toks[i]), float(toks[i + 1]); i += 2; cur = [(x, y)]; cmd = 'L'
        elif cmd == 'L': x, y = float(toks[i]), float(toks[i + 1]); i += 2; cur.append((x, y))
        elif cmd == 'H': x = float(toks[i]); i += 1; cur.append((x, y))
        elif cmd == 'V': y = float(toks[i]); i += 1; cur.append((x, y))
        elif cmd == 'Q':
            x1, y1, x2, y2 = (float(v) for v in toks[i:i + 4]); i += 4
            for s in range(1, 13):
                k = s / 12; m = 1 - k
                cur.append((m * m * x + 2 * m * k * x1 + k * k * x2, m * m * y + 2 * m * k * y1 + k * k * y2))
            x, y = x2, y2
        else: i += 1
    if cur: out.append(cur)
    return out

# logo region, supersampled
X0, Y0, X1, Y1 = int(LEFT) - 20, int(BASE - 1000 * U) - 20, int(LEFT + BOX_W) + 20, int(BASE + 300 * U) + 20
W, H = (X1 - X0) * SS, (Y1 - Y0) * SS
def to_px(x, y_up): return ((LEFT + x * U - X0) * SS, (BASE - y_up * U - Y0) * SS)   # path is drawn under scale(1,-1)
def blend(mask_ss, rgb):
    a = mask_ss.resize((X1 - X0, Y1 - Y0), Image.LANCZOS)
    patch = im.crop((X0, Y0, X1, Y1)); patch.paste(Image.new("RGB", patch.size, rgb), (0, 0), a); im.paste(patch, (X0, Y0))
hexrgb = lambda h: tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))
def fill_nonzero(contours):
    """Scanline fill with the nonzero winding rule, as fonts are drawn: overlapping strokes (the F's arms) and
    self-crossing outlines (the e's bar) stay solid, reversed contours (counters) cut holes."""
    E = []
    for pts in contours:
        for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
            if y0 != y1: E.append((x0, y0, x1, y1))
    E = np.array(E); x0, y0, x1, y1 = E.T; up = np.where(y1 > y0, 1, -1); ylo, yhi = np.minimum(y0, y1), np.maximum(y0, y1)
    out = np.zeros((H, W), dtype=np.uint8); cols = np.arange(W) + 0.5
    for row in range(H):
        yc = row + 0.5; on = (ylo <= yc) & (yc < yhi)
        if not on.any(): continue
        xs = x0[on] + (yc - y0[on]) * (x1[on] - x0[on]) / (y1[on] - y0[on]); d = up[on]; o = np.argsort(xs); xs, d = xs[o], d[o]
        w = np.cumsum(d); inside = w != 0
        for xa, xb in zip(xs[:-1][inside[:-1]], xs[1:][inside[:-1]]): out[row, (cols >= xa) & (cols < xb)] = 255
    return Image.fromarray(out)
for fill, d in paths:
    blend(fill_nonzero([[to_px(*p) for p in sp] for sp in subpaths(d)]), hexrgb(fill))
mask = Image.new("L", (W, H), 0)
ccx, ccy, rr = LEFT + float(cx) * U, N / 2 + BASE_DY + float(cy) * U, float(r) * U   # circle is outside the flip
ImageDraw.Draw(mask).ellipse(((ccx - rr - X0) * SS, (ccy - rr - Y0) * SS, (ccx + rr - X0) * SS, (ccy + rr - Y0) * SS), fill=255)
blend(mask, hexrgb(cfill))

out = os.path.join(ROOT, "app-native/ios/App/App/Assets.xcassets/Splash.imageset")
for f in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"): im.save(os.path.join(out, f), optimize=True)
print("wrote launch image; dot centre", round(ccx, 2), round(ccy, 2), "r", round(rr, 2))
