from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(r"C:\GURI")
ASSETS = ROOT / "assets"
TAURI = ROOT / "src-tauri" / "icons"
AZURE = (2, 91, 151, 255)
WHITE = (255, 255, 255, 255)
FONT = r"C:\Windows\Fonts\yumindb.ttf"
MASTER = 512
GLYPH_RATIO = 0.70
# Explorer picks 16 for details view, 20/24 at higher DPI, 32/48 for tiles.
ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
PNG_SIZES = [16, 32, 64, 80, 128, 256]


def stroke_for(size: int) -> int:
    """Mincho hairlines vanish below ~32px, so thicken the glyph for small frames."""
    if size <= 20:
        return 12
    if size <= 32:
        return 8
    return 0


def render(stroke: int) -> Image.Image:
    im = Image.new("RGBA", (MASTER, MASTER), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    pad = round(MASTER * 0.02)
    draw.ellipse((pad, pad, MASTER - 1 - pad, MASTER - 1 - pad), fill=AZURE)
    font = ImageFont.truetype(FONT, round(MASTER * GLYPH_RATIO))
    bbox = draw.textbbox((0, 0), "ぐ", font=font, stroke_width=stroke)
    x = (MASTER - (bbox[2] - bbox[0])) / 2 - bbox[0]
    y = (MASTER - (bbox[3] - bbox[1])) / 2 - bbox[1] + MASTER * 0.02
    draw.text((x, y), "ぐ", font=font, fill=WHITE, stroke_width=stroke, stroke_fill=WHITE)
    return im


MASTERS = {s: render(s) for s in {stroke_for(x) for x in ICO_SIZES + PNG_SIZES + [512]}}


def frame(size: int) -> Image.Image:
    return MASTERS[stroke_for(size)].resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    plain = MASTERS[0]
    plain.save(ASSETS / "guri-logo.png")
    flat = Image.new("RGBA", plain.size, (255, 255, 255, 255))
    flat.alpha_composite(plain)
    flat.convert("RGB").save(ASSETS / "logo-filled.png")

    for size in PNG_SIZES:
        img = frame(size)
        img.save(ASSETS / f"icon-{size}.png")
        img.save(ASSETS / f"guri-{size}.png")

    # Pillow skips requested sizes larger than the base image, so save from the
    # largest frame. Explorer's small-icon path cannot read PNG-compressed ICO
    # entries, hence bitmap_format="bmp" (32-bit DIB for every frame).
    frames = {s: frame(s) for s in ICO_SIZES}
    largest = max(ICO_SIZES)
    frames[largest].save(
        TAURI / "icon.ico",
        format="ICO",
        bitmap_format="bmp",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=[frames[s] for s in ICO_SIZES if s != largest],
    )
    for name, size in (
        ("32x32.png", 32),
        ("64x64.png", 64),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 512),
    ):
        frame(size).save(TAURI / name)


if __name__ == "__main__":
    main()
