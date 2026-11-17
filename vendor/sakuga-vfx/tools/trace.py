# Trace the lettering sprites in art/words/ into SVG path data and write them into core.js, between the WORDS markers.
# The sprites are solid shapes on transparency, so tracing them loses nothing and the components carry no image files.
#
#   uv run --with potracer --with pillow --with numpy python tools/trace.py
import json, re, sys
from pathlib import Path
import numpy as np, potrace
from PIL import Image

root = Path(__file__).resolve().parent.parent
words = {}
for f in sorted((root / 'art/words').glob('*.webp')):
    a = np.array(Image.open(f).convert('RGBA'))
    h, w = a.shape[:2]
    m = a[..., 3] <= 128                     # potracer traces the False pixels
    path = potrace.Bitmap(m).trace(turdsize=8, alphamax=1.0, opticurve=True, opttolerance=0.5)
    n = lambda v: str(int(round(v)))
    p = lambda q: n(q.x) + ' ' + n(q.y)
    d = []
    for c in path:
        d.append('M' + p(c.start_point))
        for s in c.segments:
            d.append(('L' + p(s.c) + 'L' + p(s.end_point)) if s.is_corner else ('C' + p(s.c1) + ' ' + p(s.c2) + ' ' + p(s.end_point)))
        d.append('Z')
    words[f.stem] = [w, h, re.sub(r' -', '-', ''.join(d))]
    print(f.stem, w, h, len(words[f.stem][2]), file=sys.stderr)

core = root / 'core.js'
src = core.read_text()
block = 'const WORDS = ' + json.dumps(words, separators=(',', ':')) + ';'
src, k = re.subn(r'(// >>> words.*?\n).*?(\n\s*// <<< words)', lambda m: m.group(1) + block + m.group(2), src, flags=re.S)
if not k: sys.exit('no WORDS markers in core.js')
core.write_text(src)
