"""Outline the bundled Anton font into the panel's two SVG wordmarks.

Build-only dependency: fonttools (tested with 4.64.0). No runtime font install.
Anton copyright: 2020 The Anton Project Authors
https://github.com/googlefonts/AntonFont.git — SIL Open Font License.
"""
from pathlib import Path
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

plugin = Path(__file__).resolve().parents[1] / "plugin"
font = TTFont(plugin / "fonts/anton-latin-400.woff")
glyphs = font.getGlyphSet()
cmap = font.getBestCmap()
scale = 22 / font["head"].unitsPerEm
metrics = font["hhea"]
baseline = (22 - (metrics.ascent - metrics.descent) * scale) / 2 + metrics.ascent * scale
paths = []
x = 0
for char in "PXD/LS studio":
    name = cmap[ord(char)]
    pen = SVGPathPen(glyphs, ntos=lambda n: f"{n:.3f}".rstrip("0").rstrip(".") or "0")
    glyphs[name].draw(TransformPen(pen, (scale, 0, 0, -scale, x, baseline)))
    paths.append(pen.getCommands())
    x += font["hmtx"][name][0] * scale + 0.44

for theme, color in [("dark", "#E8E6EF"), ("light", "#14131B")]:
    svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="133" height="22" viewBox="0 0 133 22">
<!-- Outlined from bundled Anton; Copyright 2020 The Anton Project Authors, SIL OFL. -->
<path fill="{color}" d="{' '.join(paths)}"/>
<path fill="#F43D3F" d="M128 7L132 9L128 11Z"/>
</svg>
'''
    (plugin / f"icons/wordmark-{theme}.svg").write_text(svg)
    print(f"wordmark-{theme}.svg: {len(svg)} bytes")
