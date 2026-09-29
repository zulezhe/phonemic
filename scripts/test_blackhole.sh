#!/bin/bash
# BlackHole 环回自检：把系统默认输出切到 BlackHole，播放 440Hz 测试音并从
# BlackHole 录音，频谱分析判定环回是否通。前置：brew install ffmpeg switchaudio-osx
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC=/tmp/pm-fake-mic.wav

[ -f "$SRC" ] || python3 - "$SRC" <<'PYEOF'
import math, struct, sys, wave
sr = 48000
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    buf = bytearray()
    for i in range(sr * 12):
        buf += struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / sr)))
    w.writeframes(bytes(buf))
PYEOF

PREV=$(SwitchAudioSource -c -t output)
echo "当前输出设备: $PREV"
trap 'SwitchAudioSource -t output -s "$PREV" >/dev/null' EXIT
SwitchAudioSource -t output -s "BlackHole 2ch" >/dev/null || { echo "❌ 找不到 BlackHole 2ch（驱动未加载？试试重启）"; exit 1; }
osascript -e 'set volume output volume 100' >/dev/null

ffmpeg -hide_banner -loglevel error -f avfoundation -i ":0" -t 6 -ar 48000 -ac 1 -y /tmp/bh-check.wav 2>/dev/null &
REC=$!
sleep 1
afplay -t 5 "$SRC" 2>/dev/null
wait $REC
echo "--- 结果 ---"
python3 "$ROOT/scripts/analyze_wav.py" /tmp/bh-check.wav
