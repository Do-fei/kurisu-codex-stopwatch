#!/usr/bin/env python3
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent
SOURCE = (
    WORKSPACE
    / "codex-apple-watch"
    / "CodexWatchCompanion"
    / "Assets.xcassets"
    / "hatchling-spritesheet-v4.imageset"
    / "hatchling-spritesheet-v4.png"
)
HEADER = ROOT / "firmware" / "include" / "hatchling_assets.h"
PREVIEW = ROOT / "docs" / "hatchling-preview.png"

FRAME_W = 192
FRAME_H = 208
COLS = 8


@dataclass(frozen=True)
class FrameSpec:
    name: str
    row: int
    columns: tuple[int, ...]


FRAME_SPECS = (
    FrameSpec("idle", 0, (0, 1, 2, 3, 4, 5)),
    FrameSpec("running", 7, (0,)),
    FrameSpec("waiting", 6, (0,)),
    FrameSpec("failed", 5, (0,)),
    FrameSpec("review", 8, (0,)),
)


def rgb565(r: int, g: int, b: int) -> int:
    return ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)


def frame_names() -> list[str]:
    return [f"{spec.name}_{column}" for spec in FRAME_SPECS for column in spec.columns]


def crop_frames(sheet: Image.Image) -> list[Image.Image]:
    frames: list[Image.Image] = []
    for spec in FRAME_SPECS:
        for column in spec.columns:
            x = column * FRAME_W
            y = spec.row * FRAME_H
            frames.append(sheet.crop((x, y, x + FRAME_W, y + FRAME_H)).convert("RGBA"))
    return frames


def encode_frame(frame: Image.Image) -> list[tuple[int, int, int, int]]:
    runs: list[tuple[int, int, int, int]] = []
    for y in range(FRAME_H):
        x = 0
        while x < FRAME_W:
            r, g, b, a = frame.getpixel((x, y))
            if a < 96:
                x += 1
                continue
            color = rgb565(r, g, b)
            start_x = x
            x += 1
            while x < FRAME_W:
                nr, ng, nb, na = frame.getpixel((x, y))
                if na < 96 or rgb565(nr, ng, nb) != color:
                    break
                x += 1
            runs.append((start_x, y, x - start_x, color))
    return runs


def chunks(values: Iterable[str], count: int) -> Iterable[list[str]]:
    current: list[str] = []
    for value in values:
        current.append(value)
        if len(current) == count:
            yield current
            current = []
    if current:
        yield current


def write_header(frames: list[Image.Image]) -> None:
    names = frame_names()
    encoded = [encode_frame(frame) for frame in frames]
    offsets: list[int] = []
    run_count = 0
    for runs in encoded:
        offsets.append(run_count)
        run_count += len(runs)

    enum_lines = [f"  k{name.title().replace('_', '')} = {index}," for index, name in enumerate(names)]
    frame_lines = [
        f"  {{ {offsets[index]}, {len(encoded[index])} }},  // {names[index]}"
        for index in range(len(names))
    ]
    run_values = [
        f"{{ {x}, {y}, {length}, 0x{color:04X} }}"
        for runs in encoded
        for x, y, length, color in runs
    ]

    HEADER.write_text(
        "\n".join(
            [
                "#pragma once",
                "",
                "#include <Arduino.h>",
                "#include <pgmspace.h>",
                "",
                "namespace hatchling {",
                "",
                f"constexpr uint16_t kFrameWidth = {FRAME_W};",
                f"constexpr uint16_t kFrameHeight = {FRAME_H};",
                f"constexpr uint8_t kFrameCount = {len(names)};",
                "",
                "enum FrameId : uint8_t {",
                *enum_lines,
                "};",
                "",
                "struct FrameRun {",
                "  uint16_t x;",
                "  uint16_t y;",
                "  uint16_t len;",
                "  uint16_t color;",
                "};",
                "",
                "struct FrameInfo {",
                "  uint32_t runOffset;",
                "  uint16_t runCount;",
                "};",
                "",
                "const FrameInfo kFrames[] PROGMEM = {",
                *frame_lines,
                "};",
                "",
                "const FrameRun kRuns[] PROGMEM = {",
                *[",\n".join(group) + ("," if index < (len(run_values) - 1) // 4 else "") for index, group in enumerate(chunks(run_values, 4))],
                "};",
                "",
                "}  // namespace hatchling",
                "",
            ]
        )
    )

    print(f"wrote {HEADER}")
    print(f"frames={len(names)} runs={run_count}")


def write_preview(frames: list[Image.Image]) -> None:
    cols = 6
    rows = (len(frames) + cols - 1) // cols
    scale = 0.5
    tile_w = int(FRAME_W * scale)
    tile_h = int(FRAME_H * scale)
    preview = Image.new("RGBA", (cols * tile_w, rows * tile_h), (16, 10, 18, 255))
    draw = ImageDraw.Draw(preview)
    for index, frame in enumerate(frames):
        x = (index % cols) * tile_w
        y = (index // cols) * tile_h
        preview.alpha_composite(frame.resize((tile_w, tile_h), Image.Resampling.NEAREST), (x, y))
        draw.text((x + 4, y + 4), frame_names()[index], fill=(255, 255, 255, 220))
    preview.save(PREVIEW)
    print(f"wrote {PREVIEW}")


def main() -> None:
    sheet = Image.open(SOURCE).convert("RGBA")
    if sheet.size != (FRAME_W * COLS, FRAME_H * 9):
        raise SystemExit(f"unexpected spritesheet size: {sheet.size}")
    frames = crop_frames(sheet)
    write_header(frames)
    write_preview(frames)


if __name__ == "__main__":
    main()
