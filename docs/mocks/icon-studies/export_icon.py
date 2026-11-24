"""Writes one icon study as a standalone 1024 SVG, the source for build/icon.iconset.

Run: python3 docs/mocks/icon-studies/export_icon.py a2 build/icon.svg
"""
import sys

import icons

key, out = sys.argv[1], sys.argv[2]
svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
       f'<defs>{icons.SHARED_DEFS}{icons.HELMET_DEFS if key.startswith("a") and key != "a" else ""}</defs>'
       f'{icons.symbols[key]}</svg>')
open(out, "w").write(svg)
print(out, len(svg))
