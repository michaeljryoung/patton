"""Round 4 of the icon studies: the original Patton portrait (the icon up to v1.39.0) drawn in falling digits.

His ask (24 Nov): "take the original image we had of patton then do matrix style, like n1 but more subtle
so see more background nos". The portrait's ink sets how bright each digit is; columns of falling digits
run behind it everywhere.

Run: python3 docs/mocks/icon-studies/portrait_rain.py <out dir>
Writes the p, r, f (round 6), g (round 7) and k (round 8) SVGs (1024 grid, macOS tile); render them to PNG with headless
Chrome: python3 docs/mocks/icon-studies/render_round.py <svg dir> <round dir> g1 g2 g3 g4
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


def portrait_ink(grid=GRID):
    """Ink per grid cell, 0..1, from the v1.39.0 icon: lines are ink, paper is none."""
    png = subprocess.run(["git", "-C", REPO, "show", "v1.39.0:build/icon.iconset/icon_256x256@2x.png"],
                         capture_output=True, check=True).stdout
    img = Image.open(io.BytesIO(png)).convert("L")
    ink = Image.eval(img, lambda v: 255 - v)
    canvas = Image.new("L", (824, 824), 0)
    canvas.paste(ink.resize((764, 764), Image.LANCZOS), (30, 34))
    small = canvas.resize((grid, grid), Image.BOX)
    return [[small.getpixel((c, r)) / 255 for c in range(grid)] for r in range(grid)]


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


def face_in_rain(seed, ink, face_gain, floor, gap, boost, face_floor, rain_col, face_col, head_col, grid=GRID,
                 rain_gain=0.30, keep=None):
    """Round 6 (his 24 Nov 16:24: "isnt the point that the face is part of the falling numbers, and is made up of
    falling numbers, not just behind numbers"): every digit belongs to a falling stream (two or three drops per
    column, each a bright head and a fading trail); the portrait only brightens and lightens the streams where they
    pass through it, so the face is drawn by the rain itself."""
    cell = 824 / grid
    rng = random.Random(seed)
    drops = []
    for _ in range(grid):
        n = rng.choice((3, 3, 4))
        drops.append([(rng.randint(-6, grid + 6), rng.randint(10, 26)) for _ in range(n)])
    out = []
    for r in range(grid):
        y = 100 + cell * r + cell * 0.78
        for c in range(grid):
            x = 100 + cell * c + cell / 2
            level, is_head = gap, False
            for head, length in drops[c]:
                d = head - r
                if d == 0:
                    level, is_head = 1.0, True
                elif 0 < d < length:
                    level = max(level, 0.85 * (1 - d / length) + 0.08)
            f = min(1.0, ink[r][c] * boost) ** 0.8
            alpha = floor + level * (rain_gain + face_gain * f)
            alpha = min(1.0, alpha + face_floor * f)
            col = head_col if is_head else (face_col if f > 0.35 else rain_col)
            if keep is not None and not keep(r, c):
                rng.choice("0123456789")
                continue
            out.append(f'<text x="{x:.1f}" y="{y:.1f}" fill="{col}" fill-opacity="{alpha:.2f}">{rng.choice("0123456789")}</text>')
    return f'<g {FONT} font-size="{cell * 0.98:.1f}">{"".join(out)}</g>'


def face_tile_svg(key, ink, face_gain, floor, gap, boost, face_floor, bg=("#07110A", "#020503"), grid=GRID,
                  rain_gain=0.30, glow=0.0):
    """glow > 0 lays a blurred copy of the digits under them at that opacity (round 7: lit at Dock size)."""
    defs = icons.SHARED_DEFS + icons.lg(f"{key}-bg", *bg)
    inner = f'<rect x="100" y="100" width="824" height="824" fill="url(#{key}-bg)"/>'
    rain = face_in_rain(7, ink, face_gain, floor, gap, boost, face_floor, "#2FCB62", "#9DFFB8", "#E2FFE9", grid, rain_gain)
    if glow > 0:
        defs += f'<filter id="{key}-glow" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="7"/></filter>'
        inner += f'<g filter="url(#{key}-glow)" opacity="{glow}">{rain}</g>'
    inner += rain
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
            f'<defs>{defs}</defs>{icons.tile(f"{key}-bg", inner)}</svg>')


FACE_VARIANTS = {
    # name: (face_gain, floor, gap, boost, face_floor)
    "f1": (1.00, 0.05, 0.09, 3.6, 0.42),
    "f2": (0.80, 0.05, 0.08, 3.4, 0.30),
    "f3": (0.60, 0.04, 0.08, 3.2, 0.20),
}

def two_scale_tile_svg(key, fine_grid, coarse_grid, cut, face_gain, floor, gap, boost, face_floor, bg, rain_gain, glow):
    """Round 8 (his 26 Nov "make the green in the background just bigger"): the background rain in big digits
    (coarse_grid across), the face still drawn by fine falling digits (fine_grid across). A coarse cell is face when
    any fine cell under it has ink above cut; the fine layer draws only the fine cells whose centre lies in a face
    coarse cell, so the two layers meet without a gap."""
    fine_ink, coarse_ink = portrait_ink(fine_grid), portrait_ink(coarse_grid)
    fc, cc = 824 / fine_grid, 824 / coarse_grid

    def coarse_of(r, c):
        return min(coarse_grid - 1, int((r + 0.5) * fc / cc)), min(coarse_grid - 1, int((c + 0.5) * fc / cc))

    face = set()
    for r in range(fine_grid):
        for c in range(fine_grid):
            if fine_ink[r][c] > cut:
                face.add(coarse_of(r, c))
    defs = icons.SHARED_DEFS + icons.lg(f"{key}-bg", *bg)
    inner = f'<rect x="100" y="100" width="824" height="824" fill="url(#{key}-bg)"/>'
    rain = face_in_rain(11, coarse_ink, 0.0, floor, gap, boost, 0.0, "#2FCB62", "#9DFFB8", "#E2FFE9", coarse_grid,
                        rain_gain, keep=lambda r, c: (r, c) not in face)
    rain += face_in_rain(7, fine_ink, face_gain, floor, gap, boost, face_floor, "#2FCB62", "#9DFFB8", "#E2FFE9",
                         fine_grid, rain_gain, keep=lambda r, c: coarse_of(r, c) in face)
    if glow > 0:
        defs += f'<filter id="{key}-glow" x="-5%" y="-5%" width="110%" height="110%"><feGaussianBlur stdDeviation="7"/></filter>'
        inner += f'<g filter="url(#{key}-glow)" opacity="{glow}">{rain}</g>'
    inner += rain
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
            f'<defs>{defs}</defs>{icons.tile(f"{key}-bg", inner)}</svg>')


# Round 7 (26 Nov, F3 in his Dock: "it just looks black"): F3's face drawn by the rain, the rain brighter
# (rain_gain) and lit by a blurred copy of the digits under them (glow), each step brighter than the last.
FACE_VARIANTS_R7 = {
    # name: (face_gain, floor, gap, boost, face_floor, bg, grid, rain_gain, glow)
    "g1": (0.60, 0.06, 0.10, 3.2, 0.20, ("#07110A", "#020503"), GRID, 0.60, 0.7),
    "g2": (0.85, 0.06, 0.10, 3.4, 0.32, ("#07110A", "#020503"), GRID, 0.60, 0.7),
    "g3": (0.85, 0.08, 0.12, 3.4, 0.32, ("#0B2414", "#030A05"), GRID, 0.70, 0.8),
    "g4": (0.85, 0.10, 0.14, 3.4, 0.34, ("#0F2E1A", "#050F08"), GRID, 0.85, 0.9),
}

# Round 8 (26 Nov, "make the green in the background just bigger"): G3 with bigger digits. k1 and k2 enlarge every
# digit (fewer across); k3 and k4 enlarge only the background rain and keep the face in G3's fine digits.
# name: ("all", grid) or ("two", fine_grid, coarse_grid, cut); the rest of G3's settings stay.
ROUND8 = {
    "k1": ("all", 48),
    "k2": ("all", 42),
    "k3": ("two", GRID, 34, 0.10),
    "k4": ("two", GRID, 28, 0.10),
}


def round8_svg(key):
    face_gain, floor, gap, boost, face_floor, bg, _, rain_gain, glow = FACE_VARIANTS_R7["g3"]
    kind = ROUND8[key]
    if kind[0] == "all":
        grid = kind[1]
        return face_tile_svg(key, portrait_ink(grid), face_gain, floor, gap, boost, face_floor, bg, grid, rain_gain, glow)
    _, fine, coarse, cut = kind
    return two_scale_tile_svg(key, fine, coarse, cut, face_gain, floor, gap, boost, face_floor, bg, rain_gain, glow)

VARIANTS = {
    # name: (strength, trail_max, base, bg1, bg2, rain, face, head)
    "p1": (0.95, 0.42, 0.10, "#07110A", "#020503", "#2FCB62", "#8DFFAE", "#D8FFE2"),
    "p2": (0.72, 0.52, 0.13, "#07110A", "#020503", "#2FCB62", "#8DFFAE", "#D8FFE2"),
    "p3": (0.95, 0.42, 0.10, "#140F05", "#060402", "#E0A231", "#FFD27A", "#FFF0CC"),
    # Round 5 (24 Nov 16:14 and 16:17, P1 in his Dock: "background green isnt clear enough, just looks like the
    # icon, needs to be more subtle", then of P2 "even further than this with more background"): stronger falling
    # digits, a fainter portrait, each step past P2.
    "r1": (0.58, 0.62, 0.17, "#07110A", "#020503", "#2FCB62", "#8DFFAE", "#D8FFE2", 3.2, 0.95, 0.45),
    "r2": (0.48, 0.72, 0.21, "#07110A", "#020503", "#2FCB62", "#8DFFAE", "#D8FFE2", 3.2, 0.95, 0.35),
    "r3": (0.40, 0.82, 0.25, "#07110A", "#020503", "#2FCB62", "#8DFFAE", "#D8FFE2", 3.2, 0.95, 0.25),
}

if __name__ == "__main__":
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    ink = portrait_ink()
    for key, v in VARIANTS.items():
        (out / f"{key}.svg").write_text(tile_svg(key, ink, *v))
    for key, v in FACE_VARIANTS.items():
        (out / f"{key}.svg").write_text(face_tile_svg(key, ink, *v))
        print(out / f"{key}.svg")
    for key, v in FACE_VARIANTS_R7.items():
        (out / f"{key}.svg").write_text(face_tile_svg(key, ink, *v))
        print(out / f"{key}.svg")
    for key in ROUND8:
        (out / f"{key}.svg").write_text(round8_svg(key))
        print(out / f"{key}.svg")
