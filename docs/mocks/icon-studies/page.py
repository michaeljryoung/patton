"""Builds the Patton icon studies page from icons.py's symbols and today's icon PNGs.

Run: python3 docs/mocks/icon-studies/page.py docs/mocks/icon-studies.html
"""
import base64
import sys

import icons

from pathlib import Path



REPO = str(Path(__file__).resolve().parents[3])


def png(name):
    """The icon as it was before the A2 change: v1.39.0, the last release with the pen portrait."""
    import subprocess
    data = subprocess.run(["git", "-C", REPO, "show", f"v1.39.0:build/icon.iconset/{name}"],
                          capture_output=True, check=True).stdout
    return "data:image/png;base64," + base64.b64encode(data).decode()


# Display order: the figure first, then general-meets-terminal, then his marks.
OPTIONS = [
    ("a", "Helmet", "The old icon's helmet and three stars, without the face.", "the helmet, the three stars"),
    ("h", "Silhouette", "The general in profile as one solid shape, like the head on a medal.", "the portrait, the helmet, the stars"),
    ("c", "Under the brim", "The helmet drawn as a single line, with a terminal prompt where the face was.", "the helmet, the stars, the terminal"),
    ("d", "Star cursor", "A terminal prompt whose cursor is a general's star.", "a star, the terminal"),
    ("e", "Window stars", "A terminal window whose three window buttons are the three stars.", "the three stars, the terminal"),
    ("b", "Three stars", "Only the rank: three stars in brass on olive drab. The clearest at small sizes.", "the three stars"),
    ("f", "Stencil star", "The white star in a ring painted on American tanks in the Second World War, with stencil breaks in the ring.", "his army's marking"),
    ("g", "Stencil P", "A stencilled P, like the lettering on army crates, with the three stars beneath.", "the name, the three stars"),
    ("i", "Dog tag", "A steel identity tag stamped with the name, the stars and a prompt.", "the name, the stars, the terminal"),
    ("j", "Patton tank", "The M48 Patton tank, named after him, side on with its white star.", "the name, his army's marking"),
]
LETTERS = "ABCDEFGHIJ"

# Round 2: his pick A, "but cap shouldnt be too curved" (24 Nov).
ROUND2 = [
    ("a", "A1", "As first drawn", "The rim sweeps well down at the sides, under a round crown."),
    ("a2", "A2", "Flatter brim", "The same crown; the rim drops half as far at the sides."),
    ("a3", "A3", "Flatter crown", "A lower, broader top with steeper sides; the first rim."),
    ("a4", "A4", "Both flatter", "The lower crown on the flatter brim."),
    ("a5", "A5", "Straight brim", "A flat-topped crown on a straight brim, the most geometric."),
]

TODAY = {"big": png("icon_128x128@2x.png"), 64: png("icon_64x64@2x.png"), 32: png("icon_32x32@2x.png"), 16: png("icon_16x16@2x.png")}


def use(sym, size, cls=""):
    c = f' class="{cls}"' if cls else ""
    return f'<svg{c} width="{size}" height="{size}" viewBox="0 0 1024 1024" aria-hidden="true"><use href="#icon-{sym}"/></svg>'


def sizes_row(render):
    cells = []
    for px in (64, 32, 16):
        cells.append(f'<figure>{render(px)}<figcaption>{px}</figcaption></figure>')
    return '<div class="sizes">' + "".join(cells) + '</div>'


cards = []
for i, (sym, name, desc, keeps) in enumerate(OPTIONS):
    L = LETTERS[i]
    cards.append(
        f'<article class="option" id="opt-{L.lower()}" aria-labelledby="h-{L.lower()}">'
        f'{use(sym, 168, "big")}'
        f'<div class="meta"><h2 id="h-{L.lower()}"><span class="letter">{L}</span>{name}</h2>'
        f'<p>{desc}</p><p class="keeps"><span>Keeps</span> {keeps}</p>'
        f'{sizes_row(lambda px, s=sym: use(s, px))}</div></article>')


# Round 3: his "matrix numbers falling but making the shape of [the] helmet with the stars subtly" (24 Nov).
ROUND3 = [
    ("n1", "N1", "Green rain", "Falling digits across the whole tile, packed bright inside the helmet; the stars are dark cut-outs."),
    ("n2", "N2", "Helmet only", "The digits fall only inside the helmet, on plain black."),
    ("n3", "N3", "Amber rain", "N1 in amber, the colour of Patton's typing box and the brass stars."),
    ("n4", "N4", "A2 in digits", "Your A2 as it is, with faint falling digits worked into the helmet's surface."),
]

# Round 4: "the hat still looks like a bowler hat, can we maybe take the original image we had of patton then
# do matrix style, like n1 but more subtle so see more backgroun nos" (24 Nov). Rendered by portrait_rain.py.
ROUND4 = [
    ("p1", "P1", "Portrait in green", "The original portrait drawn in bright digits, with falling digits behind it across the whole tile."),
    ("p2", "P2", "Quieter portrait", "P1 with the portrait dimmer and the falling digits stronger."),
    ("p3", "P3", "Portrait in amber", "P1 in amber, the colour of Patton's typing box."),
]
# Each rendered icon is embedded once, as a symbol holding the image, and reused by <use> at every size.
for k, _, _, _ in ROUND4:
    data = base64.b64encode(open(f"{REPO}/docs/mocks/icon-studies/round4/{k}-512.png", "rb").read()).decode()
    icons.symbols[k] = f'<image href="data:image/png;base64,{data}" x="0" y="0" width="1024" height="1024"/>'

# Round 5: P1 in his Dock, "background green isnt clear enough, just looks like the icon, needs to be more
# subtle" (24 Nov 16:14): quieter falling digits so the portrait stands out.
ROUND5 = [
    ("r1", "R1", "More background", "A step past P2: the falling digits stronger, the portrait fainter."),
    ("r2", "R2", "Mostly background", "Further again: the rain fills the tile and the portrait sits inside it."),
    ("r3", "R3", "Ghost portrait", "The furthest: a busy wall of falling digits with the portrait just showing through."),
]
for k, _, _, _ in ROUND5:
    data = base64.b64encode(open(f"{REPO}/docs/mocks/icon-studies/round5/{k}-512.png", "rb").read()).decode()
    icons.symbols[k] = f'<image href="data:image/png;base64,{data}" x="0" y="0" width="1024" height="1024"/>'
# Round 6: "isnt the point that the face is part of the falling numbers, and is made up of falling numbers, not just
# behind numbers" (24 Nov 16:24): the falling streams themselves draw the face (portrait_rain.py face_in_rain).
ROUND6 = [
    ("f1", "F1", "Face in the rain", "Every digit is part of a falling stream; the streams brighten where they pass through the face."),
    ("f2", "F2", "Subtler", "The same streams, the face a step fainter."),
    ("f3", "F3", "Subtlest", "Mostly falling rain, the face just drawn out of it."),
]
for k, _, _, _ in ROUND6:
    data = base64.b64encode(open(f"{REPO}/docs/mocks/icon-studies/round6/{k}-512.png", "rb").read()).decode()
    icons.symbols[k] = f'<image href="data:image/png;base64,{data}" x="0" y="0" width="1024" height="1024"/>'
# Round 7: F3 in his Dock, "it just looks black" (26 Nov): the same face drawn by the rain, the rain brighter and lit
# by a soft glow of the digits under them (portrait_rain.py FACE_VARIANTS_R7), each step brighter than the last.
ROUND7 = [
    ("g1", "G1", "Lit rain", "F3's face, with the falling digits about twice as bright and a soft green glow under them."),
    ("g2", "G2", "Lit rain, clearer face", "G1 with the face a step clearer, about as strong as F2's."),
    ("g3", "G3", "Brighter", "G2 on a dark green ground instead of near black, the rain and glow a step stronger."),
    ("g4", "G4", "Brightest", "The rain and glow strongest, on a lighter green ground than G3."),
]
for k, _, _, _ in ROUND7:
    data = base64.b64encode(open(f"{REPO}/docs/mocks/icon-studies/round7/{k}-512.png", "rb").read()).decode()
    icons.symbols[k] = f'<image href="data:image/png;base64,{data}" x="0" y="0" width="1024" height="1024"/>'
round7 = []
for key, label, name, desc in ROUND7:
    round7.append(
        f'<article class="variant" aria-labelledby="h-{key}">{use(key, 150, "big")}'
        f'<div class="meta"><h3 id="h-{key}"><span class="letter wide">{label}</span>{name}</h3><p>{desc}</p>'
        f'{sizes_row(lambda px, k=key: use(k, px))}</div></article>')

# Round 8: "I think we need to make the green in the background just bigger" (26 Nov): G3 with bigger digits
# (portrait_rain.py ROUND8): K1 and K2 enlarge every digit, K3 and K4 only the background rain.
ROUND8 = [
    ("k1", "K1", "Bigger digits", "Every digit about a sixth bigger than G3's; the face a touch coarser."),
    ("k2", "K2", "Bigger still", "Every digit a third bigger than G3's; the face coarser again."),
    ("k3", "K3", "Big background", "Only the background rain bigger, its digits about two thirds bigger than G3's; the face keeps G3's fine digits."),
    ("k4", "K4", "Biggest background", "The background rain in digits twice G3's size; the face keeps G3's fine digits."),
]
for k, _, _, _ in ROUND8:
    data = base64.b64encode(open(f"{REPO}/docs/mocks/icon-studies/round8/{k}-512.png", "rb").read()).decode()
    icons.symbols[k] = f'<image href="data:image/png;base64,{data}" x="0" y="0" width="1024" height="1024"/>'
round8 = []
for key, label, name, desc in ROUND8:
    round8.append(
        f'<article class="variant" aria-labelledby="h-{key}">{use(key, 150, "big")}'
        f'<div class="meta"><h3 id="h-{key}"><span class="letter wide">{label}</span>{name}</h3><p>{desc}</p>'
        f'{sizes_row(lambda px, k=key: use(k, px))}</div></article>')

round6 = []
for key, label, name, desc in ROUND6:
    round6.append(
        f'<article class="variant" aria-labelledby="h-{key}">{use(key, 150, "big")}'
        f'<div class="meta"><h3 id="h-{key}"><span class="letter wide">{label}</span>{name}</h3><p>{desc}</p>'
        f'{sizes_row(lambda px, k=key: use(k, px))}</div></article>')

round5 = []
for key, label, name, desc in ROUND5:
    round5.append(
        f'<article class="variant" aria-labelledby="h-{key}">{use(key, 150, "big")}'
        f'<div class="meta"><h3 id="h-{key}"><span class="letter wide">{label}</span>{name}</h3><p>{desc}</p>'
        f'{sizes_row(lambda px, k=key: use(k, px))}</div></article>')

round4 = []
for key, label, name, desc in ROUND4:
    round4.append(
        f'<article class="variant" aria-labelledby="h-{key}">{use(key, 150, "big")}'
        f'<div class="meta"><h3 id="h-{key}"><span class="letter wide">{label}</span>{name}</h3><p>{desc}</p>'
        f'{sizes_row(lambda px, k=key: use(k, px))}</div></article>')

round2 = []
for sym, label, name, desc in ROUND2:
    round2.append(
        f'<article class="variant" aria-labelledby="h-{sym}">{use(sym, 150, "big")}'
        f'<div class="meta"><h3 id="h-{sym}"><span class="letter wide">{label}</span>{name}</h3><p>{desc}</p>'
        f'{sizes_row(lambda px, s=sym: use(s, px))}</div></article>')


round3 = []
for sym, label, name, desc in ROUND3:
    round3.append(
        f'<article class="variant" aria-labelledby="h-{sym}">{use(sym, 150, "big")}'
        f'<div class="meta"><h3 id="h-{sym}"><span class="letter wide">{label}</span>{name}</h3><p>{desc}</p>'
        f'{sizes_row(lambda px, s=sym: use(s, px))}</div></article>')


def dock(theme, entries=None):
    if entries is None:
        entries = [(sym, name, LETTERS[i]) for i, (sym, name, _, _) in enumerate(OPTIONS)]
    items = [f'<li><img src="{TODAY[64]}" width="64" height="64" alt="The icon before"><span>Before</span></li>']
    for sym, name, label in entries:
        items.append(f'<li title="{name}">{use(sym, 64)}<span>{label}</span></li>')
    return f'<div class="wall wall-{theme}"><ul class="dock" aria-label="{theme} Dock">' + "".join(items) + '</ul></div>'


HTML = f"""<title>Patton Icon Studies</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600&family=IBM+Plex+Sans:wght@400;500;600&family=Saira+Stencil+One&display=swap">
<style>
/* Layout: one 1080px column; today's icon as a reference strip, the ten as a two-up grid, then all of them in a real-size Dock */
:root {{
  --ground: #ECEEE7;
  --surface: #F8F9F4;
  --ink: #1C2016;
  --muted: #596050;
  --line: #D2D7C8;
  --brass: #8E6A17;
  --display: "Saira Stencil One", Impact, "Arial Narrow", sans-serif;
  --body: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, Menlo, monospace;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --ground: #11140F; --surface: #191D16; --ink: #E7EADF; --muted: #9CA392; --line: #2C3228; --brass: #D9AF4E;
    color-scheme: dark;
  }}
}}
:root[data-theme="dark"] {{
  --ground: #11140F; --surface: #191D16; --ink: #E7EADF; --muted: #9CA392; --line: #2C3228; --brass: #D9AF4E;
  color-scheme: dark;
}}
* {{ box-sizing: border-box; }}
body {{
  background: var(--ground); color: var(--ink); font: 16px/1.55 var(--body);
  padding-block: 40px 64px;
  padding-left: max(16px, env(safe-area-inset-left, 0px));
  padding-right: max(16px, env(safe-area-inset-right, 0px));
}}
.wrap {{ max-width: 1080px; margin: 0 auto; display: grid; gap: 48px; }}
header {{ display: grid; gap: 10px; max-width: 68ch; }}
.eyebrow, .keeps span, figcaption, .letter, .dock span, .today .label {{ font-family: var(--mono); font-weight: 500; }}
.eyebrow {{ margin: 0; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--brass); }}
h1 {{ margin: 0; font: 400 clamp(40px, 6vw, 64px)/1 var(--display); letter-spacing: .01em; text-wrap: balance; }}
.dek {{ margin: 0; color: var(--muted); font-size: 17px; }}
h2 {{ margin: 0; font-size: 19px; font-weight: 600; display: flex; align-items: baseline; gap: 10px; text-wrap: balance; }}
.section-head {{ display: grid; gap: 6px; }}
.section-head h2 {{ font-size: 15px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }}
.section-head p {{ margin: 0; color: var(--muted); max-width: 68ch; }}

.today {{ display: flex; gap: 28px; align-items: center; flex-wrap: wrap; padding-block: 24px; }}
.today .art {{ width: 128px; height: 128px; border-radius: 8px; }}
.today .text {{ flex: 1 1 280px; display: grid; gap: 6px; max-width: 60ch; }}
.today .label {{ font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--brass); }}
.today p {{ margin: 0; }}

.grid {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }}
.option {{ display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 22px; align-items: start;
  background: var(--surface); border-radius: 14px; padding: 20px; }}
.option .big {{ width: 168px; height: 168px; max-width: 100%; }}
.meta {{ display: grid; gap: 8px; }}
.meta p {{ margin: 0; }}
.letter {{ display: inline-grid; place-items: center; width: 28px; height: 28px; border-radius: 7px;
  font-size: 15px; font-weight: 600; color: var(--surface); background: var(--ink); flex: none; }}
.keeps {{ color: var(--muted); font-size: 14px; }}
.keeps span {{ font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: var(--brass); margin-right: 4px; }}
.sizes {{ display: flex; align-items: flex-end; gap: 18px; padding-top: 6px; }}
figure {{ margin: 0; display: grid; justify-items: center; gap: 4px; }}
figcaption {{ font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }}

.docks {{ display: grid; gap: 14px; }}
.wall {{ overflow-x: auto; border-radius: 14px; padding: 34px 20px 18px; }}
.wall-light {{ background: linear-gradient(160deg, #B9C7D6, #E4E2D8 70%); }}
.wall-dark {{ background: linear-gradient(160deg, #1D2533, #3A3448 75%); }}
.dock {{ list-style: none; margin: 0 auto; padding: 10px 14px 6px; display: flex; gap: 12px; width: max-content;
  border-radius: 24px; border: 1px solid rgba(255,255,255,.45); }}
.wall-light .dock {{ background: rgba(255,255,255,.42); }}
.wall-dark .dock {{ background: rgba(40,40,46,.55); border-color: rgba(255,255,255,.14); }}
.dock li {{ display: grid; justify-items: center; gap: 2px; }}
.dock li:first-child {{ padding-right: 12px; margin-right: 2px; border-right: 1px solid rgba(0,0,0,.16); }}
.wall-dark .dock li:first-child {{ border-right-color: rgba(255,255,255,.18); }}
.dock img {{ border-radius: 14px; }}
.dock span {{ font-size: 11px; }}
.wall-light .dock span {{ color: #2A2F36; }}
.wall-dark .dock span {{ color: #E6E8EC; }}

.round2 {{ display: grid; gap: 16px; }}
.variants {{ display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }}
.variants.three {{ grid-template-columns: repeat(3, minmax(0, 1fr)); }}
.variants.four {{ grid-template-columns: repeat(4, minmax(0, 1fr)); }}
.variant {{ display: grid; grid-template-rows: auto 1fr; gap: 12px; background: var(--surface);
  border-radius: 14px; padding: 16px; }}
.variant .meta {{ grid-template-rows: auto 1fr auto; }}
.variant .big {{ width: 150px; height: 150px; max-width: 100%; justify-self: center; }}
h3 {{ margin: 0; font-size: 16px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; }}
.letter.wide {{ width: auto; padding-inline: 7px; }}
.variant .sizes {{ gap: 12px; }}

.reply {{ display: grid; gap: 6px; max-width: 68ch; padding-top: 24px; }}
.reply p {{ margin: 0; }}
.reply strong {{ font-weight: 600; }}

@media (max-width: 860px) {{
  .grid {{ grid-template-columns: minmax(0, 1fr); }}
  .variants, .variants.four, .variants.three {{ grid-template-columns: minmax(0, 1fr); }}
  .variant {{ grid-template-columns: 120px minmax(0, 1fr); grid-template-rows: none; align-items: start; }}
  .variant .big {{ width: 120px; height: 120px; }}
}}
@media (max-width: 460px) {{
  .option {{ grid-template-columns: minmax(0, 1fr); justify-items: start; }}
  .option .big {{ width: 148px; height: 148px; }}
}}
</style>
{icons.sprite()}
<div class="wrap">
  <header>
    <p class="eyebrow">Patton · app icon</p>
    <h1>Ten icons for Patton</h1>
    <p class="dek">Ten directions for a sleeker icon that keeps the reference to the general: his helmet, his three stars, his name, and the tank named after him. Each sits on the rounded tile that current Mac apps use, shown full size and at 64, 32 and 16 pixels, three of the sizes Patton's icon file carries.</p>
  </header>

  <section class="round2" aria-labelledby="r8-head">
    <div class="section-head">
      <h2 id="r8-head">Round 8 · G3, bigger green</h2>
      <p>You asked for the green in the background to be bigger. K1 and K2 make every digit bigger, so the face gets coarser with them; K3 and K4 make only the background rain bigger and keep G3's fine face. G3 comes first in the Docks below.</p>
    </div>
    <div class="variants four">{"".join(round8)}</div>
    {dock("light", [("g3", "G3", "G3")] + [(k, name, label) for k, label, name, _ in ROUND8])}
    {dock("dark", [("g3", "G3", "G3")] + [(k, name, label) for k, label, name, _ in ROUND8])}
  </section>

  <section class="round2" aria-labelledby="r7-head">
    <div class="section-head">
      <h2 id="r7-head">Round 7 · F3, lit up</h2>
      <p>F3 in your Dock looks black: its digits are thin and mostly faint, so at Dock size they average out to the dark ground. These keep F3's face drawn by the falling digits and make the rain brighter, with a soft glow under it, each a step brighter than the last. F3 as it is now comes first in the Docks below.</p>
    </div>
    <div class="variants four">{"".join(round7)}</div>
    {dock("light", [("f3", "F3", "F3 now")] + [(k, name, label) for k, label, name, _ in ROUND7])}
    {dock("dark", [("f3", "F3", "F3 now")] + [(k, name, label) for k, label, name, _ in ROUND7])}
  </section>

  <section class="round2" aria-labelledby="r6-head">
    <div class="section-head">
      <h2 id="r6-head">Round 6 · The face made of falling digits</h2>
      <p>You said the face should be made of the falling numbers, not sit behind them. Here the same falling streams cover the whole tile and simply brighten where they pass through the face. P2, the one you liked, comes first in the Docks below.</p>
    </div>
    <div class="variants three">{"".join(round6)}</div>
    {dock("light", [("p2", "P2", "P2")] + [(k, name, label) for k, label, name, _ in ROUND6])}
    {dock("dark", [("p2", "P2", "P2")] + [(k, name, label) for k, label, name, _ in ROUND6])}
  </section>

  <section class="round2" aria-labelledby="r5-head">
    <div class="section-head">
      <h2 id="r5-head">Round 5 · More background, fainter face</h2>
      <p>You asked for P2's direction, further: more of the falling green, the portrait more subtle. Each step goes past P2. P1, as installed now, and P2 come first in the Docks below.</p>
    </div>
    <div class="variants three">{"".join(round5)}</div>
    {dock("light", [("p1", "P1", "P1"), ("p2", "P2", "P2")] + [(k, name, label) for k, label, name, _ in ROUND5])}
    {dock("dark", [("p1", "P1", "P1"), ("p2", "P2", "P2")] + [(k, name, label) for k, label, name, _ in ROUND5])}
  </section>

  <section class="round2" aria-labelledby="r4-head">
    <div class="section-head">
      <h2 id="r4-head">Round 4 · The portrait in falling digits</h2>
      <p>You said A2 still looks like a bowler hat. This round goes back to the original portrait and draws it in digits, like N1 but quieter, so more of the falling numbers behind it show.</p>
    </div>
    <div class="variants three">{"".join(round4)}</div>
    {dock("light", [("a2", "A2", "A2")] + [(k, name, label) for k, label, name, _ in ROUND4])}
    {dock("dark", [("a2", "A2", "A2")] + [(k, name, label) for k, label, name, _ in ROUND4])}
  </section>

  <section class="round2" aria-labelledby="r3-head">
    <div class="section-head">
      <h2 id="r3-head">Round 3 · Falling numbers</h2>
      <p>Your A2 helmet, now in the app, drawn from falling digits with the three stars showing faintly. Each is beside A2 in the Docks below.</p>
    </div>
    <div class="variants four">{"".join(round3)}</div>
    {dock("light", [("a2", "A2", "A2")] + [(sym, name, label) for sym, label, name, _ in ROUND3])}
    {dock("dark", [("a2", "A2", "A2")] + [(sym, name, label) for sym, label, name, _ in ROUND3])}
  </section>

  <section class="round2" aria-labelledby="r2-head">
    <div class="section-head">
      <h2 id="r2-head">Round 2 · A, less curved</h2>
      <p>You picked A and said the helmet shouldn't be too curved. Here are four flatter versions beside the first: a flatter brim, a flatter crown, both, and a straight brim.</p>
    </div>
    <div class="variants">{"".join(round2)}</div>
    {dock("light", [(sym, name, label) for sym, label, name, _ in ROUND2])}
    {dock("dark", [(sym, name, label) for sym, label, name, _ in ROUND2])}
  </section>

  <section class="today" aria-label="The icon before">
    <img class="art" src="{TODAY['big']}" width="128" height="128" alt="Patton's icon before: a pen portrait of a general in a helmet">
    <div class="text">
      <span class="label">Before</span>
      <p>A fine-line pen portrait on a plain white square, which macOS 26 clips into its rounded tile. Its thin lines fade at small sizes.</p>
    </div>
    <div class="sizes">
      <figure><img src="{TODAY[64]}" width="64" height="64" alt=""><figcaption>64</figcaption></figure>
      <figure><img src="{TODAY[32]}" width="32" height="32" alt=""><figcaption>32</figcaption></figure>
      <figure><img src="{TODAY[16]}" width="16" height="16" alt=""><figcaption>16</figcaption></figure>
    </div>
  </section>

  <section class="grid" aria-label="The ten options">
    {"".join(cards)}
  </section>

  <section class="docks" aria-labelledby="dock-head">
    <div class="section-head">
      <h2 id="dock-head">In the Dock</h2>
      <p>All ten at Dock size beside the icon before, on a light and a dark desktop.</p>
    </div>
    {dock("light")}
    {dock("dark")}
  </section>

  <section class="reply" aria-label="How to choose">
    <p><strong>Reply with K1, K2, K3 or K4</strong> to swap it in, or keep G3.</p>
    <p>A pick ships as a release and reaches your Dock at the next install, with Patton quit.</p>
  </section>
</div>
"""

open(sys.argv[1], "w").write(HTML)
print(len(HTML))
