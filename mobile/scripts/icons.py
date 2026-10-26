"""Draws OurTube's app icons from the website's mark (web/public/favicon.svg).

The mark, on a 32x32 grid: a circle at (21, 16) r 9 in the accent at 45% opacity, a circle at (13, 16) r 11 in the
accent, and a white play triangle M10 11.2 v9.6 l7.6 -4.8.

    python scripts/icons.py assets
"""
import sys
from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else 'assets'
ACCENT = (124, 77, 255)
BG = (14, 13, 22)
WHITE = (255, 255, 255)
SS = 4  # supersampling


def mark(size, scale, mono=False):
    """The mark on a transparent square of `size` px, `scale` px per grid unit, centred on the grid's centre (16, 16)."""
    S = size * SS
    k = scale * SS
    ox = oy = S / 2 - 16 * k

    def circle(cx, cy, r):
        return [ox + (cx - r) * k, oy + (cy - r) * k, ox + (cx + r) * k, oy + (cy + r) * k]

    color = WHITE if mono else ACCENT
    faint = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(faint).ellipse(circle(21, 16, 9), fill=color + (115,))
    full = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(full).ellipse(circle(13, 16, 11), fill=color + (255,))
    im = Image.alpha_composite(faint, full)
    tri = [(ox + 10 * k, oy + 11.2 * k), (ox + 10 * k, oy + 20.8 * k), (ox + 17.6 * k, oy + 16 * k)]
    if mono:
        # A monochrome icon is all alpha: the play button is cut out of the circle.
        hole = Image.new('L', (S, S), 255)
        ImageDraw.Draw(hole).polygon(tri, fill=0)
        r, g, b, a = im.split()
        a = Image.composite(a, Image.new('L', (S, S), 0), hole)
        im = Image.merge('RGBA', (r, g, b, a))
    else:
        ImageDraw.Draw(im).polygon(tri, fill=WHITE + (255,))
    return im


def save(im, size, name, mode='RGBA'):
    im.resize((size, size), Image.LANCZOS).convert(mode).save(f'{OUT}/{name}')
    print('wrote', name)


def on_background(size, scale):
    bg = Image.new('RGBA', (size * SS, size * SS), BG + (255,))
    return Image.alpha_composite(bg, mark(size, scale))


# Legacy launcher icon: the mark on the page color, filling about two thirds of the square.
save(on_background(1024, 1024 * 0.62 / 28), 1024, 'icon.png', 'RGB')
# Splash and favicon: the mark alone, as wide as the canvas allows.
save(mark(1024, 1024 / 29), 1024, 'splash-icon.png')
save(mark(48, 48 / 29), 48, 'favicon.png')
# Adaptive icon: the page color behind, the mark inside the 66/108 safe zone in front.
save(Image.new('RGBA', (512 * SS, 512 * SS), BG + (255,)), 512, 'android-icon-background.png')
save(mark(512, 512 * 0.56 / 28), 512, 'android-icon-foreground.png')
save(mark(432, 432 * 0.56 / 28, mono=True), 432, 'android-icon-monochrome.png')
