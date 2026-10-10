# Regenerate with: python3 -m venv /tmp/v && /tmp/v/bin/pip install fonttools && /tmp/v/bin/python tools/make-icon-font.py media/vakt-icons.woff
# Build media/vakt-icons.woff: one glyph (the VAKT mark) for $(vakt-logo).
import sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path

D = "M377.796 297.235C436.896 297.235 485.433 343.934 487.714 402.989L499.764 714.92C499.764 727.88 509.445 733.28 528.807 733.28C548.168 733.28 556.236 727.88 556.236 714.92L572.371 149H887L774.056 905H281.944L169 297.235H377.796Z"
UPM, W, H = 1000, 1056, 1055
s = UPM / W
fb = FontBuilder(UPM, isTTF=False)
fb.setupGlyphOrder([".notdef", "vakt"])
fb.setupCharacterMap({0xE000: "vakt"})
pen = T2CharStringPen(UPM, None)
# SVG is y-down; fonts are y-up. Fill the em box: x*s, (H - y)*s - small offset to centre.
parse_path(D, TransformPen(pen, (s, 0, 0, -s, 0, H * s - (H * s - UPM) / 2)))
empty = T2CharStringPen(UPM, None)
fb.setupCFF("VAKTIcons", {"FullName": "VAKT Icons"}, {".notdef": empty.getCharString(), "vakt": pen.getCharString()}, {})
fb.setupHorizontalMetrics({".notdef": (UPM, 0), "vakt": (UPM, 0)})
fb.setupHorizontalHeader(ascent=UPM, descent=0)
fb.setupNameTable({"familyName": "VAKT Icons", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=UPM, sTypoDescender=0, usWinAscent=UPM, usWinDescent=0)
fb.setupPost()
fb.font.flavor = "woff"
fb.save(sys.argv[1])
