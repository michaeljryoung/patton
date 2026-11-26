"""Renders icon-study SVGs to <round dir>/<key>-512.png with headless Chrome (transparent ground, 1024, Lanczos to 512).

Run: python3 docs/mocks/icon-studies/render_round.py <svg dir> <round dir> g1 g2 g3 g4
"""
import subprocess
import sys
from pathlib import Path

from PIL import Image

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)
for key in sys.argv[3:]:
    svg, full = src / f"{key}.svg", src / f"{key}-1024.png"
    subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", f"--screenshot={full}",
                    "--window-size=1024,1024", "--default-background-color=00000000", svg.resolve().as_uri()],
                   capture_output=True, timeout=90, check=True)
    Image.open(full).convert("RGBA").resize((512, 512), Image.LANCZOS).save(dst / f"{key}-512.png", optimize=True)
    print(dst / f"{key}-512.png")
