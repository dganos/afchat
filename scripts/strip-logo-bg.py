"""Make the off-white background of the Aristo logo transparent.

Strategy: sample the corner pixel as the background color, then for every pixel
fade alpha by how close it is to that color in RGB space. This preserves the
soft blue glow around the orb instead of producing a hard cutout.
"""
import sys
from pathlib import Path
from PIL import Image

SRC = Path("public/aristo-logo.jpg")
DST = Path("public/aristo-logo.png")

# Tunables
TOLERANCE = 18      # distances <= this become fully transparent
FEATHER = 55        # distances within (TOLERANCE, TOLERANCE+FEATHER] fade in


def main() -> int:
    if not SRC.exists():
        print(f"missing {SRC}", file=sys.stderr)
        return 1

    img = Image.open(SRC).convert("RGBA")
    w, h = img.size
    pixels = img.load()

    # Background colour: average the four corners — robust against a stray speck
    corners = [pixels[0, 0], pixels[w - 1, 0], pixels[0, h - 1], pixels[w - 1, h - 1]]
    br = sum(c[0] for c in corners) // 4
    bg_g = sum(c[1] for c in corners) // 4
    bb = sum(c[2] for c in corners) // 4

    for y in range(h):
        for x in range(w):
            r, g, b, a = pixels[x, y]
            dr, dg, db = r - br, g - bg_g, b - bb
            dist = (dr * dr + dg * dg + db * db) ** 0.5
            if dist <= TOLERANCE:
                pixels[x, y] = (r, g, b, 0)
            elif dist <= TOLERANCE + FEATHER:
                t = (dist - TOLERANCE) / FEATHER  # 0..1
                pixels[x, y] = (r, g, b, int(255 * t))

    img.save(DST, "PNG", optimize=True)
    print(f"wrote {DST} ({DST.stat().st_size // 1024} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
