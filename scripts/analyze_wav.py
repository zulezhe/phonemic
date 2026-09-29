#!/usr/bin/env python3
"""分析 WAV：RMS + 440Hz/1000Hz Goertzel 能量比。用法: analyze_wav.py <file.wav>"""
import math
import struct
import sys
import wave

path = sys.argv[1]
with wave.open(path) as w:
    n, sr, ch = w.getnframes(), w.getframerate(), w.getnchannels()
    data = w.readframes(n)

fmt = {1: "h", 2: "h", 4: "f"}.get(w.getsampwidth())  # 16bit int / 32bit float
if fmt == "f":
    samples = struct.unpack(f"<{len(data)//4}f", data)
    scale = 1.0
else:
    samples = struct.unpack(f"<{len(data)//2}h", data)
    scale = 32768.0
mono = samples[::ch]

def goertzel(freq):
    k = 2 * math.pi * freq / sr
    c = 2 * math.cos(k)
    s0 = s1 = s2 = 0.0
    for s in mono:
        s0 = s + c * s1 - s2
        s2 = s1
        s1 = s0
    return (s1 * s1 + s2 * s2 - c * s1 * s2) / max(len(mono), 1)

rms = math.sqrt(sum(s * s for s in mono) / max(len(mono), 1)) / scale
p440, p1k = goertzel(440), goertzel(1000)
ratio = p440 / max(p1k, 1e-12)
print(f"时长 {n/sr:.1f}s  RMS {rms:.4f}  440Hz/1000Hz 能量比 {ratio:.0f}x")
ok = n / sr > 3 and rms > 0.01
print("==> " + ("PASS ✅ 有音频" if ok else "FAIL ❌ 静音或过短"))
sys.exit(0 if ok else 1)
