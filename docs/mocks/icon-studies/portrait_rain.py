"""Round 4 of the icon studies: the original Patton portrait (the icon up to v1.39.0) drawn in falling digits.

His ask (24 Nov): "take the original image we had of patton then do matrix style, like n1 but more subtle
so see more background nos". The portrait's ink sets how bright each digit is; columns of falling digits
run behind it everywhere.

Run: python3 docs/mocks/icon-studies/portrait_rain.py <out dir>
Writes p1.svg, p2.svg, p3.svg (1024 grid, macOS tile); render them to PNG with headless Chrome.
"""
import io
import random
import subprocess
import sys
from pathlib import Path

from PIL import Image

import icons

REPO = str(Path(__file__).resolve().parents[3])
GRID = 56                      # digits across and down the 824 body
CELL = 824 / GRID
FONT = 'font-family="Menlo, IBM Plex Mono, monospace" font-weight="700" text-anchor="middle"'


def portrait_ink():
    """Ink per grid cell, 0..1, from the v1.39.0 icon: lines are ink, paper is none."""
    png = subprocess.run(["git", "-C", REPO, "show", "v1.39.0:build/icon.iconset/icon_256x256@2x.png"],
                         capture_output=True, check=True).stdout
    img = Image.open(io.BytesIO(png)).convert("L")
    ink = Image.eval(img, lambda v: 255 - v)
    canvas = Image.new("L", (824, 824), 0)
    canvas.paste(ink.resize((764, 764), Image.LANCZOS), (30, 34))
    small = canvas.resize((GRID, GRID), Image.BOX)
    return [[small.getpixel((c, r)) / 255 for c in range(GRID)] for r in range(GRID)]


def digits(seed, ink, strength, trail_max, base, rain_col, face_col, head_col, boost=3.2, head_alpha=0.95):
    rng = random.Random(seed)
    heads = [rng.randint(-4, GRID + 10) for _ in range(GRID)]
    lengths = [rng.randint(8, 24) for _ in range(GRID)]
    rain_out, face_out = [], []
    for r in range(GRID):
        y = 100 + CELL * r + CELL * 0.78
        for c in range(GRID):
            x = 100 + CELL * c + CELL / 2
            d = heads[c] - r
            if d == 0:
                bg = head_alpha
            elif 0 < d < lengths[c]:
                bg = trail_max * (1 - d / lengths[c]) + base
            else:
                bg = base * rng.uniform(0.6, 1.3)
            p = min(1.0, ink[r][c] * boost) ** 0.8 * strength
            ch = rng.choice("0123456789")
            if p > bg:
                face_out.append(f'<text x="{x:.1f}" y="{y:.1f}" fill="{face_col}" fill-opacity="{p:.2f}">{ch}</text>')
            else:
                col = head_col if d == 0 else rain_col
                rain_out.append(f'<text x="{x:.1f}" y="{y:.1f}" fill="{col}" fill-opacity="{bg:.2f}">{ch}</text>')
    size = f'font-size="{CELL * 0.98:.1f}"'
    return f'<g {FONT} {size}>{"".join(rain_out)}</g>', f'<g {FONT} {size}>{"".join(face_out)}</g>'


def tile_svg(key, ink, strength, trail_max, base, bg1, bg2, rain_col, face_col, head_col, boost=3.2, head_alpha=0.95, glow=0.55):
    rain_g, face_g = digits(7, ink, strength, trail_max, base, rain_col, face_col, head_col, boost, head_alpha)
    defs = (icons.SHARED_DEFS + icons.lg(f"{key}-bg", bg1, bg2)
            + f'<filter id="{key}-glow" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="6"/></filter>')
    inner = f'<rect x="100" y="100" width="824" height="824" fill="url(#{key}-bg)"/>'
    inner += rain_g
    inner += f'<g filter="url(#{key}-glow)" opacity="{glow}">{face_g}</g>'
    inner += face_g
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
            f'<defs>{defs}</defs>{icons.tile(f"{key}-bg", inner)}</svg>')


VARIANTS = {
    # name: (strength, trail_max, base, bg1, bg2, rain, face, head)
    "p1": (0.95, 0.42, 0.10, "#07110A", "#020503", "#2FCB62", "#8DFFAE", "#D8FFE2"),
    "p2": (0.72, 0.52, 0.13, "#07110A", "#020503", "#2FCB62", "#8DFFAE", "#D8FFE2"),
    "p3": (0.95, 0.42, 0.10, "#140F05", "#060402", "#E0A231", "#FFD27A", "#FFF0CC"),
    # Round 5 (24 Nov 16:14, P1 in his Dock: "background green isnt clear enough, just looks like the icon,
    # needs to be more subtle"): quieter rain so the portrait stands out.
    "q1": (0.95, 0.20, 0.05, "#07110A", "#020503", "#2FCB62", "#8DFFAE", "#D8FFE2", 3.2, 0.45, 0.55),
    "q2": (0.95, 0.11, 0.03, "#07110A", "#020503", "#2FCB62", "#8DFFAE", "#D8FFE2", 3.2, 0.30, 0.55),
    "q3": (1.00, 0.14, 0.035, "#07110A", "#020503", "#2FCB62", "#A8FFC2", "#D8FFE2", 4.6, 0.35, 0.85),
}

if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    ink = portrait_ink()
    for key, v in VARIANTS.items():
        (out / f"{key}.svg").write_text(tile_svg(key, ink, *v))
        print(out / f"{key}.svg")
