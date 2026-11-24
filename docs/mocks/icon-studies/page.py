"""Builds the Patton icon studies page from icons.py's symbols and today's icon PNGs.

Run: python3 docs/mocks/icon-studies/page.py docs/mocks/icon-studies.html
"""
import base64
import sys

import icons

from pathlib import Path

ICONSET = str(Path(__file__).resolve().parents[3] / "build" / "icon.iconset") + "/"


def png(name):
    return "data:image/png;base64," + base64.b64encode(open(ICONSET + name, "rb").read()).decode()


# Display order: the figure first, then general-meets-terminal, then his marks.
OPTIONS = [
    ("a", "Helmet", "Today's helmet and three stars, without the face. The nearest to what you have now.", "the helmet, the three stars"),
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


round2 = []
for sym, label, name, desc in ROUND2:
    round2.append(
        f'<article class="variant" aria-labelledby="h-{sym}">{use(sym, 150, "big")}'
        f'<div class="meta"><h3 id="h-{sym}"><span class="letter wide">{label}</span>{name}</h3><p>{desc}</p>'
        f'{sizes_row(lambda px, s=sym: use(s, px))}</div></article>')


def dock(theme, entries=None):
    if entries is None:
        entries = [(sym, name, LETTERS[i]) for i, (sym, name, _, _) in enumerate(OPTIONS)]
    items = [f'<li><img src="{TODAY[64]}" width="64" height="64" alt="Today\'s icon"><span>Now</span></li>']
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

.today {{ display: flex; gap: 28px; align-items: center; flex-wrap: wrap; padding-block: 24px; border-block: 1px solid var(--line); }}
.today .art {{ width: 128px; height: 128px; border-radius: 8px; }}
.today .text {{ flex: 1 1 280px; display: grid; gap: 6px; max-width: 60ch; }}
.today .label {{ font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--brass); }}
.today p {{ margin: 0; }}

.grid {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }}
.option {{ display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 22px; align-items: start;
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 20px; }}
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
.variant {{ display: grid; grid-template-rows: auto 1fr; gap: 12px; background: var(--surface); border: 1px solid var(--line);
  border-radius: 14px; padding: 16px; }}
.variant .meta {{ grid-template-rows: auto 1fr auto; }}
.variant .big {{ width: 150px; height: 150px; max-width: 100%; justify-self: center; }}
h3 {{ margin: 0; font-size: 16px; font-weight: 600; display: flex; align-items: baseline; gap: 8px; }}
.letter.wide {{ width: auto; padding-inline: 7px; }}
.variant .sizes {{ gap: 12px; }}

.reply {{ display: grid; gap: 6px; max-width: 68ch; border-top: 1px solid var(--line); padding-top: 24px; }}
.reply p {{ margin: 0; }}
.reply strong {{ font-weight: 600; }}

@media (max-width: 860px) {{
  .grid {{ grid-template-columns: minmax(0, 1fr); }}
  .variants {{ grid-template-columns: minmax(0, 1fr); }}
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

  <section class="round2" aria-labelledby="r2-head">
    <div class="section-head">
      <h2 id="r2-head">Round 2 · A, less curved</h2>
      <p>You picked A and said the helmet shouldn't be too curved. Here are four flatter versions beside the first: a flatter brim, a flatter crown, both, and a straight brim.</p>
    </div>
    <div class="variants">{"".join(round2)}</div>
    {dock("light", [(sym, name, label) for sym, label, name, _ in ROUND2])}
    {dock("dark", [(sym, name, label) for sym, label, name, _ in ROUND2])}
  </section>

  <section class="today" aria-label="Today's icon">
    <img class="art" src="{TODAY['big']}" width="128" height="128" alt="Today's Patton icon: a pen portrait of a general in a helmet">
    <div class="text">
      <span class="label">Today</span>
      <p>A fine-line pen portrait on a plain white square. It has no rounded tile like other current Mac icons, and its thin lines fade at small sizes.</p>
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
      <p>All ten at Dock size beside today's icon, on a light and a dark desktop.</p>
    </div>
    {dock("light")}
    {dock("dark")}
  </section>

  <section class="reply" aria-label="How to choose">
    <p><strong>Reply with A1 to A5,</strong> or a part of one on another, such as A5's brim under A1's crown.</p>
    <p>The one you pick becomes Patton's icon file in every size, and ships with the fixes from the walk-through, so it arrives in the same install.</p>
  </section>
</div>
"""

open(sys.argv[1], "w").write(HTML)
print(len(HTML))
