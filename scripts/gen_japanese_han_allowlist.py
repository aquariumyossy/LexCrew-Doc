#!/usr/bin/env python3
"""Fill the Japanese Han allowlist from the Python codecs.

The chat pane and the write-tool check share one allowlist:

- src/shared/japaneseHanData.ts

This repository has no Rust copy (nothing under src-tauri matches HAN_BMP
or japanese_han). The script reads the TypeScript file, then turns on every
CJK ideograph that Python's codecs decode:

- ``shift_jis``: JIS X 0208 kanji (6,356 ideographs in CPython)
- ``cp932``: Windows-31J, which adds the NEC and IBM extension kanji
  (including U+9AD9 髙)

U+20BB7 (𠮷, tsuchi-yoshi) is not in either codec, so it is added by hand.
Simplified forms that those codecs do not contain, such as 们这说话门问题,
stay off. Bits that are already on are left on.

Run from the repository root:

    python3 scripts/gen_japanese_han_allowlist.py
    python3 scripts/gen_japanese_han_allowlist.py --check
"""

from __future__ import annotations

import base64
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TS_PATH = ROOT / "src/shared/japaneseHanData.ts"

HAN_BMP_A0 = 0x3400
HAN_BMP_B0 = 0xF900
# 𠮷. Neither shift_jis nor cp932 emits this scalar.
TSUCHI_YOSHI = 0x20BB7
# Simplified forms the codecs do not contain. They must stay off.
STAY_OFF = "们这说话门问题"
# Hangul is a foreign script, not a Han allowlist hit.
HANGUL = "기타"


def is_cjk(cp: int) -> bool:
    return (
        0x3400 <= cp <= 0x4DBF
        or 0x4E00 <= cp <= 0x9FFF
        or 0xF900 <= cp <= 0xFAFF
        or 0x20000 <= cp <= 0x2A6DF
        or 0x2A700 <= cp <= 0x2B73F
        or 0x2B740 <= cp <= 0x2B81F
        or 0x2B820 <= cp <= 0x2CEAF
        or 0x2CEB0 <= cp <= 0x2EBEF
        or 0x30000 <= cp <= 0x3134F
        or 0x31350 <= cp <= 0x323AF
    )


def collect(encoding: str) -> set[int]:
    points: set[int] = set()
    leads = list(range(0x81, 0xA0)) + list(range(0xE0, 0xFD))
    seconds = list(range(0x40, 0x7F)) + list(range(0x80, 0xFD))
    for lead in leads:
        for second in seconds:
            try:
                text = bytes((lead, second)).decode(encoding)
            except UnicodeDecodeError:
                continue
            if len(text) != 1:
                continue
            cp = ord(text)
            if is_cjk(cp):
                points.add(cp)
    return points


def bit_at(table: bytearray, index: int) -> bool:
    return (table[index >> 3] & (1 << (index & 7))) != 0


def set_bit(table: bytearray, index: int) -> None:
    table[index >> 3] |= 1 << (index & 7)


def load_ts(text: str) -> tuple[bytearray, bytearray, list[int]]:
    a = re.search(r'HAN_BMP_A =\s*"([^"]+)"', text, re.S)
    b = re.search(r'HAN_BMP_B =\s*"([^"]+)"', text, re.S)
    extra = re.search(r"HAN_EXTRA = \[(.*?)\];", text, re.S)
    if not a or not b or not extra:
        raise SystemExit("japaneseHanData.ts is missing HAN_BMP_A, HAN_BMP_B, or HAN_EXTRA")
    bmp_a = bytearray(base64.b64decode(a.group(1)))
    bmp_b = bytearray(base64.b64decode(b.group(1)))
    nums = [int(item) for item in re.findall(r"\d+", extra.group(1))]
    return bmp_a, bmp_b, nums


def already(cp: int, bmp_a: bytearray, bmp_b: bytearray, extra: set[int]) -> bool:
    if HAN_BMP_A0 <= cp < HAN_BMP_A0 + len(bmp_a) * 8:
        return bit_at(bmp_a, cp - HAN_BMP_A0)
    if HAN_BMP_B0 <= cp < HAN_BMP_B0 + len(bmp_b) * 8:
        return bit_at(bmp_b, cp - HAN_BMP_B0)
    return cp in extra


def allow(cp: int, bmp_a: bytearray, bmp_b: bytearray, extra: set[int]) -> bool:
    """True when this code point was newly turned on."""
    if already(cp, bmp_a, bmp_b, extra):
        return False
    if HAN_BMP_A0 <= cp < HAN_BMP_A0 + len(bmp_a) * 8:
        set_bit(bmp_a, cp - HAN_BMP_A0)
        return True
    if HAN_BMP_B0 <= cp < HAN_BMP_B0 + len(bmp_b) * 8:
        set_bit(bmp_b, cp - HAN_BMP_B0)
        return True
    extra.add(cp)
    return True


def wrap_numbers(nums: list[int]) -> str:
    lines: list[str] = []
    line = "  "
    for index, num in enumerate(nums):
        piece = str(num) + ("," if index + 1 < len(nums) else "")
        if len(line) + len(piece) + 1 > 100:
            lines.append(line.rstrip())
            line = "  " + piece + " "
        else:
            line += piece + " "
    lines.append(line.rstrip())
    return "\n".join(lines)


def render_ts(bmp_a: bytes, bmp_b: bytes, extra: list[int]) -> str:
    a = base64.b64encode(bmp_a).decode("ascii")
    b = base64.b64encode(bmp_b).decode("ascii")
    return f"""/* Japanese Han allowlist.
 * Base: Joyo, jinmeiyo, and JIS/vendor Japanese sources (Unihan), including
 * JIS X 0208 拡張新字体 whose kyujitai is not in J0 (嘘, 蝉, 躯, …).
 * scripts/gen_japanese_han_allowlist.py turns on every CJK ideograph that
 * Python's shift_jis (JIS X 0208) and cp932 (NEC and IBM extensions, including
 * U+9AD9 髙) decode, plus U+20BB7 (𠮷), which neither codec emits.
 * Simplified forms those codecs do not contain stay off. Nothing is removed. */
export const HAN_BMP_A0 = 0x3400;
export const HAN_BMP_B0 = 0xf900;
export const HAN_BMP_A =
  "{a}";
export const HAN_BMP_B =
  "{b}";
export const HAN_EXTRA = [
{wrap_numbers(extra)}
];
"""


def write_ts(bmp_a: bytes, bmp_b: bytes, extra: list[int]) -> None:
    TS_PATH.write_text(render_ts(bmp_a, bmp_b, extra))


def required_points() -> tuple[set[int], set[int], set[int]]:
    jis = collect("shift_jis")
    cp932 = collect("cp932")
    return jis, cp932, jis | cp932 | {TSUCHI_YOSHI}


def show(points: list[int]) -> str:
    return " ".join(f"U+{cp:04X}" for cp in points)


def check() -> None:
    bmp_a, bmp_b, extra_list = load_ts(TS_PATH.read_text())
    extra = set(extra_list)
    jis, cp932, required = required_points()
    missing = [cp for cp in sorted(required) if not already(cp, bmp_a, bmp_b, extra)]
    wrongly_on = [ord(ch) for ch in STAY_OFF if already(ord(ch), bmp_a, bmp_b, extra)]
    hangul_on = [ord(ch) for ch in HANGUL if already(ord(ch), bmp_a, bmp_b, extra)]
    print(f"shift_jis kanji: {len(jis)}")
    print(f"cp932 kanji: {len(cp932)}")
    print(f"required code points: {len(required)}")
    if len(jis) < 6356 or len(cp932) < 6716:
        raise SystemExit(
            f"codec sweep is short (shift_jis {len(jis)}, cp932 {len(cp932)}); "
            "expected at least 6356 and 6716"
        )
    if missing or wrongly_on or hangul_on:
        if missing:
            print(f"missing {len(missing)}: {show(missing)}", file=sys.stderr)
        if wrongly_on:
            print(f"simplified forms turned on: {show(wrongly_on)}", file=sys.stderr)
        if hangul_on:
            print(f"hangul turned on: {show(hangul_on)}", file=sys.stderr)
        raise SystemExit(1)
    print("allowlist covers shift_jis, cp932, and U+20BB7")
    print(f"still off: {STAY_OFF}")
    print(f"hangul not in the allowlist: {HANGUL}")


def generate() -> None:
    bmp_a, bmp_b, extra_list = load_ts(TS_PATH.read_text())
    extra = set(extra_list)
    jis, cp932, required = required_points()
    added = [cp for cp in sorted(required) if allow(cp, bmp_a, bmp_b, extra)]
    write_ts(bytes(bmp_a), bytes(bmp_b), sorted(extra))
    print(f"shift_jis kanji: {len(jis)}")
    print(f"cp932 kanji: {len(cp932)}")
    print(f"added code points: {len(added)}")
    print("added:", show(added))


def main() -> None:
    if len(sys.argv) > 2 or (len(sys.argv) == 2 and sys.argv[1] != "--check"):
        raise SystemExit("usage: python3 scripts/gen_japanese_han_allowlist.py [--check]")
    if len(sys.argv) == 2:
        check()
    else:
        generate()


if __name__ == "__main__":
    main()
