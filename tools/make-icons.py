#!/usr/bin/env python3
"""
Generate Wake's PWA icons.

Kept in the repo so the icons are reproducible rather than mystery binaries.
The mark is a sun cresting a horizon — literal for "Wake", and legible at 32px
where anything more detailed turns to mush. Drawn at 8x and downsampled, which
is cheaper than fighting PIL's aliasing.
"""
from PIL import Image, ImageDraw
import os

INK    = (10, 10, 12, 255)
ACCENT = (233, 162, 59, 255)
DIM    = (233, 162, 59, 90)
S      = 8  # supersample factor

def draw(size, *, padding=0.0, rounded=True, transparent_bg=False):
    n = size * S
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if not transparent_bg:
        if rounded:
            d.rounded_rectangle([0, 0, n - 1, n - 1], radius=int(n * 0.225), fill=INK)
        else:
            d.rectangle([0, 0, n, n], fill=INK)

    # Content box, inset for maskable safe area when asked.
    pad = n * padding
    cw = n - 2 * pad
    cx = n / 2
    horizon = pad + cw * 0.615
    r = cw * 0.235

    # Sun, clipped to sit on the horizon.
    sun = [cx - r, horizon - r, cx + r, horizon + r]
    d.pieslice(sun, start=180, end=360, fill=ACCENT)

    # Horizon: a full-width hairline, plus a shorter dim line beneath it so the
    # mark reads as layered rather than flat.
    lw = max(1, int(cw * 0.052))
    d.rounded_rectangle(
        [pad + cw * 0.10, horizon - lw / 2, pad + cw * 0.90, horizon + lw / 2],
        radius=lw / 2, fill=ACCENT)
    d.rounded_rectangle(
        [pad + cw * 0.255, horizon + lw * 2.15, pad + cw * 0.745, horizon + lw * 3.15],
        radius=lw / 2, fill=DIM)

    return img.resize((size, size), Image.LANCZOS)

out = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
os.makedirs(out, exist_ok=True)

draw(192).save(f"{out}/icon-192.png")
draw(512).save(f"{out}/icon-512.png")
# Maskable icons get cropped to a circle by some launchers: keep the mark inside
# the 80% safe zone and let the background bleed to the edges.
draw(512, padding=0.16, rounded=False).save(f"{out}/icon-maskable-512.png")
# iOS applies its own mask and does not want a transparent or rounded source.
draw(180, rounded=False).save(f"{out}/apple-touch-icon.png")

with open(f"{out}/icon.svg", "w") as f:
    f.write('''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="115" fill="#0a0a0c"/>
  <path d="M136 315a120 120 0 0 1 240 0Z" fill="#e9a23b"/>
  <rect x="51" y="302" width="410" height="27" rx="13" fill="#e9a23b"/>
  <rect x="131" y="360" width="250" height="27" rx="13" fill="#e9a23b" opacity=".35"/>
</svg>''')

print("wrote", len(os.listdir(out)), "icons")
