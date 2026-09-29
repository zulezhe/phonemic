#!/usr/bin/env python3
"""生成 1024x1024 应用图标（纯 stdlib：深色底 + 麦克风图形）。"""
import struct
import zlib

SIZE = 1024


def px(x, y):
    """返回 (x,y) 处的 RGBA。"""
    cx, cy = SIZE / 2, SIZE / 2
    # 背景纵向渐变
    t = y / SIZE
    r = int(22 + 14 * t)
    g = int(26 + 16 * t)
    b = int(36 + 22 * t)
    a = 255

    def put(color):
        return (*color, 255)

    # 圆角矩形边界（内缩 0，整体即图标）
    m = 0
    radius = 180
    dx = min(x - m, (SIZE - 1 - m) - x)
    dy = min(y - m, (SIZE - 1 - m) - y)
    if dx < radius and dy < radius and (dx - radius) ** 2 + (dy - radius) ** 2 > radius**2:
        return (0, 0, 0, 0)

    teal = (61, 220, 151)
    white = (240, 244, 248)

    # 麦克风头：竖直胶囊，中心 (cx, 400)，宽 190，高 300，圆角 95
    hw, hh = 95, 150
    mx, my = cx, 400
    ndx = abs(x - mx) - (hw - 95)
    ndy = abs(y - my) - (hh - 95)
    if abs(x - mx) <= hw and abs(y - my) <= hh and (max(ndx, 0) ** 2 + max(ndy, 0) ** 2) <= 95**2:
        return put(teal)

    # U 形支架：以 (cx, 430) 为圆心半径 230 的下半圆环，线宽 26
    d = ((x - cx) ** 2 + (y - 430) ** 2) ** 0.5
    if abs(d - 230) <= 13 and y >= 430:
        return put(teal)

    # 立柱
    if abs(x - cx) <= 13 and 660 <= y <= 770:
        return put(teal)
    # 底座
    if abs(x - cx) <= 110 and 770 <= y <= 796:
        return put(teal)

    return (r, g, b, a)


def main():
    rows = []
    for y in range(SIZE):
        row = bytearray([0])  # filter type 0
        for x in range(SIZE):
            row.extend(px(x, y))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
    with open("icon.png", "wb") as f:
        f.write(png)
    print("icon.png written")


if __name__ == "__main__":
    main()
