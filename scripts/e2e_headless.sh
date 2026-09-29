#!/bin/bash
# M1 端到端验证：headless Edge 假麦克风 → 手机页面 → WS → Rust 解码 → WAV 转储。
# 判定标准：stats.json 有帧流入，且转储 WAV 能量集中 ~440Hz（与假音源一致）。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/target/debug/phonemic-server"
EDGE="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
PORT=9430
DUMP=/tmp/pm-e2e-dump.wav
FAKE=/tmp/pm-fake-mic.wav
PROFILE=$(mktemp -d)
SERVER_PID=""

cleanup() {
  [ -n "$SERVER_PID" ] && kill -INT "$SERVER_PID" 2>/dev/null
  pkill -f "user-data-dir=$PROFILE" 2>/dev/null
}
trap cleanup EXIT

echo "== 1. 生成假麦克风音源（440Hz 正弦，12s）"
python3 - <<'PYEOF'
import math, struct, wave
sr = 48000
with wave.open("/tmp/pm-fake-mic.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    buf = bytearray()
    for i in range(sr * 12):
        buf += struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / sr)))
    w.writeframes(bytes(buf))
print("   ok")
PYEOF

echo "== 2. 启动 phonemic-server（--dev 跳过 token）"
"$BIN" --dev --port "$PORT" --dump "$DUMP" >/tmp/pm-e2e-server.log 2>&1 &
SERVER_PID=$!
sleep 1.5
if curl -sf "http://127.0.0.1:$PORT/" | grep -q "PhoneMic"; then
  echo "   ok: 页面可访问"
else
  echo "   FAIL: 页面不可访问"; tail -20 /tmp/pm-e2e-server.log; exit 1
fi

echo "== 3. headless Edge 打开手机页面并自动开播"
"$EDGE" --headless=new --no-sandbox --disable-gpu --mute-audio --no-first-run --no-default-browser-check --disable-sync \
  --user-data-dir="$PROFILE" \
  --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
  --use-file-for-fake-audio-capture="$FAKE" \
  --autoplay-policy=no-user-gesture-required \
  "http://127.0.0.1:$PORT/?autostart=1" >/tmp/pm-e2e-edge.log 2>&1 &

echo "== 4. 采集 10s 统计"
sleep 10
STATS=$(curl -sf "http://127.0.0.1:$PORT/stats.json" || echo "{}")
echo "   $STATS" | head -c 400; echo

echo "== 5. 停止"
kill -INT "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null
SERVER_PID=""

echo "== 6. 校验转储 WAV"
python3 - "$DUMP" "$STATS" <<'PYEOF'
import json, math, struct, sys

# 解析 hound 写出的 f32 WAV
raw = open(sys.argv[1], "rb").read()
assert raw[:4] == b"RIFF" and raw[8:12] == b"WAVE", "不是 WAV"
pos, fmt, data = 12, None, None
while pos + 8 <= len(raw):
    cid = raw[pos:pos+4]; size = struct.unpack("<I", raw[pos+4:pos+8])[0]
    body = raw[pos+8:pos+8+size]
    if cid == b"fmt " and fmt is None: fmt = body
    elif cid == b"data":
        data = body if size > 0 else raw[pos+8:]
        break
    pos += 8 + size + (size & 1)
if fmt is None or not data: raise SystemExit("   FAIL: WAV 缺少 fmt/data 块")
ch = struct.unpack("<H", fmt[2:4])[0]
rate = struct.unpack("<I", fmt[4:8])[0]
bits = struct.unpack("<H", fmt[14:16])[0]
samples = struct.unpack(f"<{len(data)//4}f", data)
n = len(samples)
rms = math.sqrt(sum(s*s for s in samples) / max(n,1))

def goertzel(freq):
    k = 2 * math.pi * freq / rate
    c = 2 * math.cos(k)
    s0 = s1 = s2 = 0.0
    for s in samples:
        s0 = s + c*s1 - s2; s2 = s1; s1 = s0
    return (s1*s1 + s2*s2 - c*s1*s2) / n

p440, p1000 = goertzel(440), goertzel(1000)
stats = json.loads(sys.argv[2])
frames = stats.get("frames_in", 0)

print(f"   格式: {ch}ch {rate}Hz {bits}bit  样本数: {n}  时长: {n/rate:.1f}s")
print(f"   RMS: {rms:.4f}  440Hz 能量: {p440:.6f}  1000Hz 能量: {p1000:.6f}  比值: {p440/max(p1000,1e-12):.0f}x")
print(f"   服务端收帧: {frames}")

ok = True
if frames < 100: print("   FAIL: 帧数不足"); ok = False
if n < rate * 3: print("   FAIL: 转储时长不足 3s"); ok = False
if rms < 0.05: print("   FAIL: RMS 过低（近乎静音）"); ok = False
if p440 < 10 * p1000: print("   FAIL: 440Hz 分量不明显"); ok = False
print("   ==> E2E " + ("PASS ✅" if ok else "FAIL ❌"))
sys.exit(0 if ok else 1)
PYEOF
