"""Regenerate the two bitmaps the Windows installer displays.

NSIS predates transparency and alpha channels: the header strip and the welcome
sidebar must be flat 24-bit BMPs at exact pixel sizes, or makensis substitutes its
own and the installer arrives wearing the NullSoft globe. Nothing else in the
project ships a BMP, so they are generated here from the same logo the application
icon comes from rather than hand-drawn and left to drift.

The background is the dashboard's own --bg (#05060b) instead of white, so the
installer reads as the same product as the window it installs.

    uv run --with pillow python scripts/build_installer_art.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src-tauri" / "icons" / "icon.png"
OUTPUT = ROOT / "src-tauri" / "installer"

# Fixed by NSIS. A bitmap of any other size is ignored rather than scaled.
HEADER = (150, 57)
SIDEBAR = (164, 314)

BACKGROUND = (5, 6, 11)


def compose(size: tuple[int, int], logo_height: int, center: bool) -> Image.Image:
    """Places the logo on a flat background at `size`, in RGB with no alpha."""
    canvas = Image.new("RGB", size, BACKGROUND)
    logo = Image.open(SOURCE).convert("RGBA")
    logo = logo.resize((logo_height, logo_height), Image.LANCZOS)

    x = (size[0] - logo_height) // 2 if center else size[0] - logo_height - 12
    y = (size[1] - logo_height) // 2 if center else (size[1] - logo_height) // 2
    # The logo keeps its own alpha, so the mask is what keeps the rounded stroke
    # from arriving as a black square.
    canvas.paste(logo, (x, y), logo)
    return canvas


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)

    compose(HEADER, logo_height=40, center=False).save(OUTPUT / "header.bmp")
    compose(SIDEBAR, logo_height=120, center=True).save(OUTPUT / "sidebar.bmp")

    for name in ("header.bmp", "sidebar.bmp"):
        written = OUTPUT / name
        print(f"  {written.relative_to(ROOT).as_posix()}  {Image.open(written).size}")


if __name__ == "__main__":
    main()
