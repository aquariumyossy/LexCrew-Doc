"""LexCrew icon samples. Same blue circle as the current mark, four white glyphs."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BLUE = (2, 91, 151, 255)
WHITE = (255, 255, 255, 255)
SIZE = 2048
OUT = 512
HERE = Path(__file__).resolve().parent

# Circle matches src-tauri/icons/icon.png: ~10px inset on a 512 canvas.
INSET = int(SIZE * 10 / 512)


def layer() -> Image.Image:
    return Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))


def circle() -> Image.Image:
    im = layer()
    draw = ImageDraw.Draw(im)
    draw.ellipse((INSET, INSET, SIZE - 1 - INSET, SIZE - 1 - INSET), fill=BLUE)
    return im


def stamp(draw: ImageDraw.ImageDraw, points: list[tuple[float, float]], width: float, fill) -> None:
    if len(points) < 2:
        return
    radius = width / 2
    # Step well under the radius so the stroke stays solid.
    step = max(1.0, radius / 4)
    dense: list[tuple[float, float]] = []
    for (x1, y1), (x2, y2) in zip(points, points[1:]):
        dist = math.hypot(x2 - x1, y2 - y1)
        n = max(1, int(dist / step))
        for i in range(n):
            t = i / n
            dense.append((x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
    dense.append(points[-1])
    for x, y in dense:
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def stamp_var(
    draw: ImageDraw.ImageDraw,
    points: list[tuple[float, float]],
    width_at,
    fill,
) -> None:
    """width_at(t) returns stroke width, t from 0 at the start to 1 at the end."""
    if len(points) < 2:
        return
    lengths = [math.hypot(x2 - x1, y2 - y1) for (x1, y1), (x2, y2) in zip(points, points[1:])]
    total = sum(lengths) or 1.0
    step = 2.0
    traveled = 0.0
    for (x1, y1), (x2, y2), seg in zip(points, points[1:], lengths):
        n = max(1, int(seg / step))
        for i in range(n):
            t_seg = i / n
            t = (traveled + seg * t_seg) / total
            x = x1 + (x2 - x1) * t_seg
            y = y1 + (y2 - y1) * t_seg
            radius = width_at(t) / 2
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)
        traveled += seg
    radius = width_at(1) / 2
    x, y = points[-1]
    draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=fill)


def quad(p0, p1, p2, n=48) -> list[tuple[float, float]]:
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append(
            (
                u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0],
                u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1],
            )
        )
    return pts


def cubic(p0, p1, p2, p3, n=64) -> list[tuple[float, float]]:
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append(
            (
                u**3 * p0[0] + 3 * u**2 * t * p1[0] + 3 * u * t**2 * p2[0] + t**3 * p3[0],
                u**3 * p0[1] + 3 * u**2 * t * p1[1] + 3 * u * t**2 * p2[1] + t**3 * p3[1],
            )
        )
    return pts


def arc(cx, cy, r, a0, a1, n=96) -> list[tuple[float, float]]:
    """Screen angles: 0 is east, 90 is south, degrees."""
    pts = []
    for i in range(n + 1):
        t = i / n
        a = math.radians(a0 + (a1 - a0) * t)
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def center_on(glyph: Image.Image, dx: float = 0, dy: float = 0) -> Image.Image:
    """Shift so the opaque bounding box sits on the canvas center, plus a nudge."""
    bbox = glyph.getchannel("A").getbbox()
    if not bbox:
        return glyph
    cx = (bbox[0] + bbox[2]) / 2
    cy = (bbox[1] + bbox[3]) / 2
    shifted = layer()
    shifted.paste(
        glyph,
        (int(round(SIZE / 2 - cx + dx)), int(round(SIZE / 2 - cy + dy))),
        glyph,
    )
    return shifted


def compose(glyph: Image.Image, dx=0, dy=0) -> Image.Image:
    im = circle()
    im.alpha_composite(center_on(glyph, dx, dy))
    return im.resize((OUT, OUT), Image.Resampling.LANCZOS)


def rounded_l(draw, stem_x, top_y, bot_y, foot_x, stroke, fill, corner=None) -> None:
    """Uniform L. corner is the centerline radius of the elbow."""
    corner = stroke * 0.85 if corner is None else corner
    elbow_y = bot_y - corner
    elbow_x = stem_x + corner
    pts = [(stem_x, top_y), (stem_x, elbow_y)]
    pts += quad((stem_x, elbow_y), (stem_x, bot_y), (elbow_x, bot_y), 36)[1:]
    pts.append((foot_x, bot_y))
    stamp(draw, pts, stroke, fill)


def glyph_a() -> Image.Image:
    """Uniform rounded L. Stroke weight close to the thick part of ぐ."""
    g = layer()
    draw = ImageDraw.Draw(g)
    rounded_l(draw, 760, 420, 1580, 1500, 220, WHITE)
    return g


def glyph_b() -> Image.Image:
    """LC as one mark. Cap-height C, foot running just under it."""
    g = layer()
    draw = ImageDraw.Draw(g)
    stroke = 150
    stem_x, top_y, bot_y = 480, 360, 1620
    side = stroke * 0.42
    above = stroke * 0.55
    l_top = top_y - stroke / 2
    foot_top = bot_y - stroke / 2
    c_top = l_top
    c_bot = foot_top - above
    outer_r = (c_bot - c_top) / 2
    c_r = outer_r - stroke / 2
    cy = (c_top + c_bot) / 2
    cx = stem_x + stroke / 2 + side + outer_r
    # Foot stops under the C's bowl, short of the lower terminal.
    foot_x = cx + c_r * 0.15
    rounded_l(draw, stem_x, top_y, bot_y, foot_x, stroke, WHITE, corner=stroke * 0.9)
    stamp(draw, arc(cx, cy, c_r, 308, 308 - 256, 140), stroke, WHITE)
    return g


def page_polygon(x0, y0, x1, y1, radius, fold) -> list[tuple[float, float]]:
    """Page with three rounded corners and a straight fold at the top right."""
    r = radius
    pts: list[tuple[float, float]] = []
    pts += arc(x0 + r, y0 + r, r, 180, 270, 14)
    pts.append((x1 - fold, y0))
    pts.append((x1, y0 + fold))
    pts += arc(x1 - r, y1 - r, r, 0, 90, 14)
    pts += arc(x0 + r, y1 - r, r, 90, 180, 14)
    return pts


def glyph_c() -> Image.Image:
    """White page, folded corner, blue L."""
    g = layer()
    draw = ImageDraw.Draw(g)
    x0, y0, x1, y1 = 520, 300, 1520, 1740
    radius = 78
    fold = 280
    draw.polygon(page_polygon(x0, y0, x1, y1, radius, fold), fill=WHITE)
    # Crease just inside the page, parallel to the cut.
    d = 36
    nx, ny = -1 / math.sqrt(2), 1 / math.sqrt(2)
    a = (x1 - fold + 36, y0 + 36)
    b = (x1 - 36, y0 + fold - 36)
    stamp(
        draw,
        [
            (a[0] + nx * d, a[1] + ny * d),
            (b[0] + nx * d, b[1] + ny * d),
        ],
        22,
        BLUE,
    )
    # L on the page, clear of the fold.
    rounded_l(draw, 820, 700, 1520, 1280, 148, BLUE, corner=120)
    return g


def glyph_d() -> Image.Image:
    """Brush L: short entry hook, thick elbow, flicked exit. Same hand as ぐ."""
    g = layer()
    draw = ImageDraw.Draw(g)
    # Small beak into a straight stem, round elbow, foot that lifts at the tip.
    pts: list[tuple[float, float]] = []
    pts += cubic((1040, 380), (900, 300), (760, 360), (740, 560), 36)
    pts += [(740, 1280)]
    pts += cubic((740, 1280), (720, 1620), (980, 1680), (1280, 1580), 48)
    pts += cubic((1280, 1580), (1480, 1500), (1620, 1460), (1680, 1380), 24)

    def width_at(t: float) -> float:
        if t < 0.12:
            u = t / 0.12
            return 64 + (190 - 64) * u
        if t < 0.62:
            u = (t - 0.12) / 0.50
            return 190 + 36 * math.sin(u * math.pi)
        u = (t - 0.62) / 0.38
        return 210 - 120 * (u**1.15)

    stamp_var(draw, pts, width_at, WHITE)
    return g


def glyph_e() -> Image.Image:
    """Folded page. No letter. Two text bars so it reads as a document."""
    g = layer()
    draw = ImageDraw.Draw(g)
    x0, y0, x1, y1 = 500, 280, 1548, 1768
    radius, fold = 84, 300
    draw.polygon(page_polygon(x0, y0, x1, y1, radius, fold), fill=WHITE)
    d = 40
    nx, ny = -1 / math.sqrt(2), 1 / math.sqrt(2)
    a = (x1 - fold + 48, y0 + 48)
    b = (x1 - 48, y0 + fold - 48)
    stamp(
        draw,
        [(a[0] + nx * d, a[1] + ny * d), (b[0] + nx * d, b[1] + ny * d)],
        26,
        BLUE,
    )
    bar_h = 78
    left = x0 + 150
    top = y0 + fold + 90
    gap = 70
    widths = (x1 - left - 170, int((x1 - left - 170) * 0.72), int((x1 - left - 170) * 0.88))
    for i, w in enumerate(widths):
        y = top + i * (bar_h + gap)
        draw.rounded_rectangle((left, y, left + w, y + bar_h), radius=bar_h / 2, fill=BLUE)
    return g


def glyph_f() -> Image.Image:
    """One pen: round butt, straight barrel, nib in the same outline."""
    g = layer()
    draw = ImageDraw.Draw(g)
    tip = (540, 1620)
    butt = (1560, 480)
    dx, dy = butt[0] - tip[0], butt[1] - tip[1]
    length = math.hypot(dx, dy)
    ux, uy = dx / length, dy / length
    px, py = -uy, ux
    half = 118
    nib = 340
    start = (tip[0] + ux * nib, tip[1] + uy * nib)
    barrel = [
        (start[0] + px * half, start[1] + py * half),
        (butt[0] + px * half, butt[1] + py * half),
        (butt[0] - px * half, butt[1] - py * half),
        (start[0] - px * half, start[1] - py * half),
    ]
    draw.polygon(barrel, fill=WHITE)
    draw.ellipse(
        (butt[0] - half, butt[1] - half, butt[0] + half, butt[1] + half),
        fill=WHITE,
    )
    draw.polygon([tip, barrel[0], barrel[3]], fill=WHITE)
    return g


def bowl(cx: float, rim_y: float, radius: float, depth: float) -> list[tuple[float, float]]:
    """Downward bowl. The rim is a straight edge that can bite into the beam."""
    pts = []
    for i in range(40):
        ang = math.pi * i / 39
        pts.append((cx + radius * math.cos(math.pi - ang), rim_y + depth * math.sin(ang)))
    return pts


def glyph_g() -> Image.Image:
    """Beam, two deep bowls, and a fulcrum that shares the beam."""
    g = layer()
    draw = ImageDraw.Draw(g)
    beam_y = 820
    stamp(draw, [(480, beam_y), (1568, beam_y)], 140, WHITE)
    rim_y = beam_y + 10
    for cx in (560, 1488):
        draw.polygon(bowl(cx, rim_y, 250, 340), fill=WHITE)
    # Point sits in the beam. Base is the foot of the fulcrum.
    draw.polygon([(1024, beam_y - 30), (1210, 1460), (838, 1460)], fill=WHITE)
    return g


def person(draw: ImageDraw.ImageDraw, cx, head_cy, head_r, body_top, body_w, body_bot) -> None:
    draw.ellipse(
        (cx - head_r, head_cy - head_r, cx + head_r, head_cy + head_r),
        fill=WHITE,
    )
    draw.rounded_rectangle(
        (cx - body_w / 2, body_top, cx + body_w / 2, body_bot),
        radius=body_w / 2,
        fill=WHITE,
    )


def glyph_h() -> Image.Image:
    """Three people. Sides first, center figure in front."""
    g = layer()
    draw = ImageDraw.Draw(g)
    person(draw, 620, 900, 150, 1080, 420, 1680)
    person(draw, 1428, 900, 150, 1080, 420, 1680)
    person(draw, 1024, 780, 185, 1000, 520, 1760)
    return g


def save_sheet(samples: dict[str, Image.Image], labels: list[str], filename: str) -> None:
    """128 / 32 / 16 on white and on near-black, so ribbon and tray both show."""
    font = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 28)
    cell = 160
    pad = 24
    cols = len(samples)
    band_h = 36 + 128 + 16 + 32 + 12 + 16 + 28
    sheet_w = pad + cols * cell
    sheet = Image.new("RGB", (sheet_w, band_h * 2), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)

    def band(origin_y: int, bg: tuple[int, int, int]) -> None:
        draw.rectangle((0, origin_y, sheet_w, origin_y + band_h), fill=bg)
        ink = (32, 32, 32) if bg[0] > 128 else (235, 235, 235)
        y = origin_y + 8
        for i, label in enumerate(labels):
            draw.text((pad + i * cell, y), label, font=font, fill=ink)
        y += 36
        for scale, gap in ((128, 8), (32, 16), (16, 20)):
            for i, im in enumerate(samples.values()):
                thumb = im.resize((scale, scale), Image.Resampling.LANCZOS)
                x = pad + i * cell + (128 - scale) // 2
                sheet.paste(thumb, (x, y), thumb)
            y += scale + gap

    band(0, (255, 255, 255))
    band(band_h, (32, 32, 32))
    sheet.save(HERE / filename)
    print(filename, sheet.size)


def save_all() -> None:
    HERE.mkdir(parents=True, exist_ok=True)
    letters = {
        "a-l.png": compose(glyph_a()),
        "b-lc.png": compose(glyph_b()),
        "c-document.png": compose(glyph_c()),
        "d-brush-l.png": compose(glyph_d()),
    }
    images = {
        "e-page.png": compose(glyph_e()),
        "f-pen.png": compose(glyph_f()),
        "g-scales.png": compose(glyph_g()),
        "h-crew.png": compose(glyph_h()),
    }
    for name, im in {**letters, **images}.items():
        im.save(HERE / name)
        print(name, im.size)
    save_sheet(letters, ["A  L", "B  LC", "C  page+L", "D  brush"], "compare.png")
    save_sheet(images, ["E  page", "F  pen", "G  scales", "H  crew"], "compare-image.png")


if __name__ == "__main__":
    save_all()
