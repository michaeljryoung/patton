"""Patton icon studies: ten candidate icons as SVG symbols (1024 grid, macOS body 824 at 100, r 186)."""
import math

CREAM = "#EFEBDD"
AMBER = "#F4B844"
BODY = '<rect x="100" y="100" width="824" height="824" rx="186"/>'


def star(cx, cy, R, ratio=0.382, rot=-90):
    pts = []
    for i in range(10):
        a = math.radians(rot + i * 36)
        rad = R if i % 2 == 0 else R * ratio
        pts.append(f"{cx + rad * math.cos(a):.1f},{cy + rad * math.sin(a):.1f}")
    return " ".join(pts)


def star_el(cx, cy, R, fill, extra=""):
    # star's box is 1.809R tall with its centre 0.095R above the point centre: shift down to centre the box
    return (f'<polygon points="{star(cx, cy + 0.095 * R, R)}" fill="{fill}" stroke="{fill}" '
            f'stroke-width="{max(2, R * 0.08):.1f}" stroke-linejoin="round" {extra}/>')


def lg(id_, c1, c2, x1=0, y1=0, x2=0, y2=1):
    return (f'<linearGradient id="{id_}" x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}">'
            f'<stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></linearGradient>')


def arc(cx, cy, r, a1, a2):
    x1, y1 = cx + r * math.cos(math.radians(a1)), cy + r * math.sin(math.radians(a1))
    x2, y2 = cx + r * math.cos(math.radians(a2)), cy + r * math.sin(math.radians(a2))
    large = 1 if (a2 - a1) % 360 > 180 else 0
    return f"M {x1:.1f},{y1:.1f} A {r} {r} 0 {large} 1 {x2:.1f},{y2:.1f}"


SHARED_DEFS = (
    '<clipPath id="pi-body">' + BODY + '</clipPath>'
    '<filter id="pi-ds" x="-10%" y="-10%" width="120%" height="125%">'
    '<feDropShadow dx="0" dy="12" stdDeviation="13" flood-color="#000" flood-opacity="0.28"/></filter>'
    '<filter id="pi-ds-s" x="-20%" y="-20%" width="140%" height="150%">'
    '<feDropShadow dx="0" dy="8" stdDeviation="9" flood-color="#000" flood-opacity="0.32"/></filter>'
    '<filter id="pi-soft" x="-30%" y="-100%" width="160%" height="300%"><feGaussianBlur stdDeviation="14"/></filter>'
    '<filter id="pi-grain" x="0" y="0" width="100%" height="100%">'
    '<feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7"/>'
    '<feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.09 0"/></filter>'
    + '<linearGradient id="pi-sheen" x1="0" y1="0" x2="0" y2="1">'
    '<stop offset="0" stop-color="#ffffff" stop-opacity="0.16"/>'
    '<stop offset="0.55" stop-color="#ffffff" stop-opacity="0"/></linearGradient>'
    + lg("pi-brass", "#F8DC86", "#C08A2A")
    + lg("pi-steel", "#F2F4F5", "#9AA1A8", 0, 0, 1, 1)
)


def tile(bg_id, inner, sheen=True):
    """A macOS body filled with a gradient, contents clipped to it, a soft drop shadow under it."""
    s = f'<g filter="url(#pi-ds)"><rect x="100" y="100" width="824" height="824" rx="186" fill="url(#{bg_id})"/></g>'
    s += f'<g clip-path="url(#pi-body)">{inner}'
    if sheen:
        s += '<rect x="100" y="100" width="824" height="824" fill="url(#pi-sheen)"/>'
    s += '</g>'
    return s


# Helmet, front three-quarter view: dome with the rim lower at the sides, a brim band that flares at the ends.
DOME = ("M 252,640 C 236,392 360,262 512,262 C 664,262 788,392 772,640 "
        "C 700,604 610,590 512,590 C 414,590 324,604 252,640 Z")
BRIM = ("M 206,662 C 318,600 414,584 512,584 C 610,584 706,600 818,662 "
        "C 828,680 818,702 798,702 C 700,652 608,638 512,638 C 416,638 324,652 226,702 "
        "C 206,702 196,680 206,662 Z")
BRIM_EDGE = "M 214,664 C 322,604 416,588 512,588 C 608,588 702,604 810,664"
HIGHLIGHT = "M 318,452 C 324,362 388,300 462,284 C 408,318 364,374 348,456 Z"

symbols = {}

# A — Helmet
defs = lg("pa-bg", "#ECE3C8", "#CBBC90") + lg("pa-shell", "#6C7943", "#38421F", 0.2, 0, 0.8, 1) + lg("pa-brim", "#4C5731", "#2A3118")
inner = '<rect x="100" y="100" width="824" height="824" fill="url(#pa-bg)"/>'
inner += '<g transform="translate(0,30)">'
inner += '<ellipse cx="512" cy="722" rx="290" ry="24" fill="#3a3320" opacity="0.28" filter="url(#pi-soft)"/>'
inner += f'<path d="{DOME}" fill="url(#pa-shell)"/>'
inner += f'<path d="{HIGHLIGHT}" fill="#ffffff" opacity="0.2"/>'
for x in (402, 512, 622):
    inner += star_el(x, 440, 46, "#F4F0E3")
inner += f'<path d="{BRIM}" fill="url(#pa-brim)"/>'
inner += f'<path d="{BRIM_EDGE}" fill="none" stroke="#ffffff" stroke-opacity="0.2" stroke-width="6" stroke-linecap="round"/>'
inner += '</g>'
symbols["a"] = defs + tile("pa-bg", inner)

# B — Three stars
defs = lg("pb-bg", "#5C6941", "#2D361F", 0, 0, 0.6, 1)
inner = '<rect x="100" y="100" width="824" height="824" fill="url(#pb-bg)"/>'
inner += '<g filter="url(#pi-ds-s)">'
for x in (300, 512, 724):
    inner += star_el(x, 512, 96, "url(#pi-brass)")
inner += '</g>'
symbols["b"] = defs + tile("pb-bg", inner)

# C — Under the brim: helmet as one line, a prompt where the face was
defs = lg("pc-bg", "#252B25", "#0C0F0C")
inner = '<rect x="100" y="100" width="824" height="824" fill="url(#pc-bg)"/>'
inner += '<g transform="translate(0,40)">'
inner += ('<path d="M 300,476 C 292,326 392,240 512,240 C 632,240 732,326 724,476" fill="none" '
          f'stroke="{CREAM}" stroke-width="36" stroke-linecap="round"/>')
inner += ('<path d="M 236,512 C 350,452 436,438 512,438 C 588,438 674,452 788,512" fill="none" '
          f'stroke="{CREAM}" stroke-width="36" stroke-linecap="round"/>')
for x in (436, 512, 588):
    inner += star_el(x, 352, 30, CREAM)
inner += (f'<polyline points="384,598 456,650 384,702" fill="none" stroke="{AMBER}" stroke-width="40" '
          'stroke-linecap="round" stroke-linejoin="round"/>')
inner += f'<rect x="494" y="672" width="146" height="38" rx="7" fill="{AMBER}"/>'
inner += '</g>'
symbols["c"] = defs + tile("pc-bg", inner)

# D — Star cursor
defs = lg("pd-bg", "#212822", "#0A0D0B") + (
    '<radialGradient id="pd-glow" cx="0.5" cy="0.5" r="0.5">'
    '<stop offset="0" stop-color="#F4B844" stop-opacity="0.32"/><stop offset="1" stop-color="#F4B844" stop-opacity="0"/>'
    '</radialGradient>')
inner = '<rect x="100" y="100" width="824" height="824" fill="url(#pd-bg)"/>'
inner += '<circle cx="652" cy="526" r="230" fill="url(#pd-glow)"/>'
inner += (f'<polyline points="268,372 428,512 268,652" fill="none" stroke="{CREAM}" stroke-width="76" '
          'stroke-linecap="round" stroke-linejoin="round"/>')
inner += star_el(652, 512, 142, "url(#pi-brass)")
symbols["d"] = defs + tile("pd-bg", inner)

# E — Window stars
defs = lg("pe-bg", "#6B7849", "#394326", 0, 0, 0.5, 1)
inner = '<rect x="100" y="100" width="824" height="824" fill="url(#pe-bg)"/>'
inner += '<g filter="url(#pi-ds-s)"><rect x="196" y="262" width="632" height="500" rx="58" fill="#141814"/></g>'
inner += '<path d="M 196,320 A 58 58 0 0 1 254,262 H 770 A 58 58 0 0 1 828,320 V 352 H 196 Z" fill="#242A22"/>'
for x in (264, 334, 404):
    inner += star_el(x, 307, 24, "url(#pi-brass)")
inner += f'<rect x="276" y="410" width="340" height="20" rx="10" fill="{CREAM}" opacity="0.2"/>'
inner += f'<rect x="276" y="452" width="230" height="20" rx="10" fill="{CREAM}" opacity="0.13"/>'
inner += (f'<polyline points="282,520 342,562 282,604" fill="none" stroke="{AMBER}" stroke-width="30" '
          'stroke-linecap="round" stroke-linejoin="round"/>')
inner += f'<rect x="372" y="584" width="96" height="28" rx="5" fill="{AMBER}"/>'
symbols["e"] = defs + tile("pe-bg", inner)

# F — Stencil star: the WWII vehicle star in a ring, stencil breaks between the points
defs = lg("pf-bg", "#5A673B", "#3A4425", 0, 0, 0.4, 1)
inner = '<rect x="100" y="100" width="824" height="824" fill="url(#pf-bg)"/>'
inner += '<rect x="100" y="100" width="824" height="824" filter="url(#pi-grain)"/>'
gap = math.degrees(36 / 318) / 2
bridges = [-54, 18, 90, 162, 234]
for i, b in enumerate(bridges):
    nb = bridges[(i + 1) % 5] + (360 if i == 4 else 0)
    inner += f'<path d="{arc(512, 512, 318, b + gap, nb - gap)}" fill="none" stroke="{CREAM}" stroke-width="40"/>'
inner += f'<polygon points="{star(512, 512, 280)}" fill="{CREAM}"/>'
symbols["f"] = defs + tile("pf-bg", inner)

# G — Stencil P with three stars
defs = lg("pg-bg", "#4D5933", "#262E18", 0, 0, 0.5, 1)
inner = '<rect x="100" y="100" width="824" height="824" fill="url(#pg-bg)"/>'
inner += '<g transform="translate(-16,0)" filter="url(#pi-ds-s)">'
inner += '<rect x="318" y="262" width="124" height="500" rx="10" fill="url(#pi-brass)"/>'
inner += ('<path fill-rule="evenodd" fill="url(#pi-brass)" d="M 466,262 H 566 A 172 172 0 0 1 566,606 H 466 Z '
          'M 466,368 H 558 A 66 66 0 0 1 558,500 H 466 Z"/>')
for x in (556, 636, 716):
    inner += star_el(x, 706, 34, CREAM)
inner += '</g>'
symbols["g"] = defs + tile("pg-bg", inner)

# H — Silhouette: the general in profile, one shape, medal-like
defs = lg("ph-bg", "#E7DCBE", "#B9A87C")
FIGURE = ("M 452,520 C 446,580 440,640 436,700 C 420,760 330,800 250,840 C 200,866 170,900 160,940 "
          "L 864,940 C 850,900 812,872 762,852 C 700,826 640,800 626,760 L 640,722 "
          "C 680,722 712,712 718,690 C 724,676 714,664 712,652 C 722,646 726,636 716,628 "
          "C 726,620 724,610 716,604 C 728,598 736,590 742,580 C 746,568 750,556 754,546 "
          "C 740,534 728,520 722,506 C 724,494 722,484 716,474 L 600,470 Z")
HELMET_P = ("M 286,548 C 268,410 352,280 508,268 C 640,258 724,336 738,444 L 778,456 "
            "C 784,468 776,478 760,478 C 700,476 640,480 580,492 C 480,510 400,532 330,556 "
            "C 304,564 282,566 270,560 C 268,554 276,550 286,548 Z")
inner = '<rect x="100" y="100" width="824" height="824" fill="url(#ph-bg)"/>'
inner += '<circle cx="512" cy="512" r="372" fill="none" stroke="#2B3020" stroke-opacity="0.18" stroke-width="10"/>'
inner += f'<path d="{FIGURE}" fill="#23271C"/>'
inner += f'<path d="{HELMET_P}" fill="#465230"/>'
inner += '<path d="M 330,420 C 360,340 420,300 480,292" fill="none" stroke="#ffffff" stroke-opacity="0.18" stroke-width="12" stroke-linecap="round"/>'
for x, y in ((470, 404), (548, 396), (626, 400)):
    inner += star_el(x, y, 28, CREAM)
symbols["h"] = defs + tile("ph-bg", inner)

# I — Dog tag
defs = lg("pi2-bg", "#5F6C41", "#333C22", 0, 0, 0.5, 1)
INK = "#4A5057"
inner = '<rect x="100" y="100" width="824" height="824" fill="url(#pi2-bg)"/>'
inner += '<g transform="rotate(-12 512 512)">'
inner += '<g filter="url(#pi-ds-s)"><rect x="222" y="352" width="580" height="320" rx="78" fill="url(#pi-steel)" stroke="#7E858C" stroke-width="4"/></g>'
inner += '<rect x="246" y="376" width="532" height="272" rx="58" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="6"/>'
inner += '<rect x="250" y="380" width="532" height="272" rx="58" fill="none" stroke="#6E757C" stroke-opacity="0.45" stroke-width="4"/>'
inner += '<circle cx="292" cy="512" r="24" fill="#4C5833" stroke="#7E858C" stroke-width="4"/>'
for k in range(14):
    bx, by = 292 - 13.3 * k, 512 - 20 * k
    inner += f'<circle cx="{bx}" cy="{by}" r="10" fill="url(#pi-steel)" stroke="#6E757C" stroke-width="2"/>'
text = ('<text x="{x}" y="{y}" font-family="IBM Plex Mono, ui-monospace, Menlo, monospace" font-weight="600" '
        'font-size="72" letter-spacing="12" fill="{f}">PATTON</text>')
inner += text.format(x=352, y=472, f="#ffffff") .replace('fill="#ffffff"', 'fill="#ffffff" fill-opacity="0.7"')
inner += text.format(x=350, y=470, f=INK)
inner += (f'<polyline points="362,540 418,578 362,616" fill="none" stroke="{INK}" stroke-width="24" '
          'stroke-linecap="round" stroke-linejoin="round"/>')
inner += f'<rect x="444" y="600" width="104" height="22" rx="4" fill="{INK}"/>'
for x in (642, 692, 742):
    inner += star_el(x, 578, 20, INK)
inner += '</g>'
symbols["i"] = defs + tile("pi2-bg", inner)

# J — Patton tank (the M48 was named after him)
defs = lg("pj-bg", "#ECE3C8", "#C7B788")
inner = '<rect x="100" y="100" width="824" height="824" fill="url(#pj-bg)"/>'
inner += '<g transform="translate(-24,14) translate(512,560) scale(1.1) translate(-512,-560)">'
inner += '<ellipse cx="500" cy="702" rx="320" ry="22" fill="#3a3320" opacity="0.3" filter="url(#pi-soft)"/>'
inner += '<rect x="226" y="566" width="540" height="128" rx="64" fill="#262B1C"/>'
for k in range(6):
    cx = 298 + 79 * k
    inner += f'<circle cx="{cx}" cy="630" r="40" fill="#4D5935"/><circle cx="{cx}" cy="630" r="13" fill="#2B311F"/>'
inner += '<path d="M 204,566 L 248,500 H 768 L 812,566 Z" fill="#4F5B32"/>'
inner += '<path d="M 204,566 L 248,500 H 768 L 812,566" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="5"/>'
inner += '<rect x="648" y="428" width="208" height="26" rx="8" fill="#4F5B32"/>'
inner += '<rect x="836" y="420" width="38" height="42" rx="7" fill="#434E2A"/>'
inner += '<path d="M 372,500 C 380,430 436,392 520,390 L 600,390 C 656,392 690,430 698,500 Z" fill="#5C6939"/>'
inner += '<rect x="470" y="372" width="70" height="24" rx="8" fill="#4F5B32"/>'
inner += star_el(540, 446, 34, CREAM)
inner += '</g>'
symbols["j"] = defs + tile("pj-bg", inner)


def sprite():
    out = ['<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>', SHARED_DEFS]
    for k, body in symbols.items():
        out.append(f'<symbol id="icon-{k}" viewBox="0 0 1024 1024">{body}</symbol>')
    out.append('</defs></svg>')
    return "".join(out)


if __name__ == "__main__":
    import sys
    # contact sheet for checking the drawings
    cells = "".join(
        f'<div><svg width="300" height="300"><use href="#icon-{k}"/></svg><svg width="64" height="64"><use href="#icon-{k}"/></svg>'
        f'<svg width="32" height="32"><use href="#icon-{k}"/></svg><svg width="16" height="16"><use href="#icon-{k}"/></svg><b>{k.upper()}</b></div>'
        for k in symbols)
    html = ('<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@600&display=swap">'
            '<style>body{margin:0;background:#d9dcd3;font:20px sans-serif}main{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}'
            'div{display:flex;flex-direction:column;align-items:center;gap:4px}</style>'
            + sprite() + '<main>' + cells + '</main>')
    open(sys.argv[1], "w").write(html)
