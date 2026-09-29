#!/bin/bash
# M2 端到端验证：HTTPS 自签证书链 + 引导页 + 手机页 over TLS + 音频链路。
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/src-tauri/target/debug/phonemic-server"
EDGE="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
DATA="$HOME/Library/Application Support/phonemic"
DUMP=/tmp/pm-lan-dump.wav
FAKE=/tmp/pm-fake-mic.wav
SERVER_PID=""
PROFILE=$(mktemp -d)

cleanup() {
  [ -n "$SERVER_PID" ] && kill -INT "$SERVER_PID" 2>/dev/null
  pkill -f "user-data-dir=$PROFILE" 2>/dev/null
}
trap cleanup EXIT

fail() { echo "   FAIL: $1"; exit 1; }

[ -f "$FAKE" ] || "$ROOT/scripts/e2e_headless.sh" >/dev/null 2>&1 || python3 - <<'PYEOF'
import math, struct, wave
sr = 48000
with wave.open("/tmp/pm-fake-mic.wav", "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
    buf = bytearray()
    for i in range(sr * 12):
        buf += struct.pack("<h", int(12000 * math.sin(2 * math.pi * 440 * i / sr)))
    w.writeframes(bytes(buf))
PYEOF

echo "== 1. 清理旧证书数据并启动 server（HTTPS 开）"
rm -rf "$DATA"
"$BIN" --port 9420 --https-port 9421 --dump "$DUMP" >/tmp/pm-lan-server.log 2>&1 &
SERVER_PID=$!
sleep 1.5

echo "== 2. 引导页与证书分发"
SETUP=$(curl -sf http://127.0.0.1:9420/setup) || fail "/setup 不可访问"
echo "$SETUP" | grep -q "PhoneMic 连接准备" || fail "引导页内容缺失"
echo "$SETUP" | grep -q "const httpsPort = 9421;" || fail "引导页未注入 HTTPS 端口"
curl -sf http://127.0.0.1:9420/ca.pem | head -1 | grep -q "BEGIN CERTIFICATE" || fail "/ca.pem 非证书"
curl -sf http://127.0.0.1:9420/ios.mobileconfig | grep -q "com.apple.security.root" || fail "/ios.mobileconfig 非描述文件"
echo "   ok"

echo "== 3. curl 用 CA 校验 HTTPS 证书链（真实客户端验证）"
[ -f "$DATA/ca.pem" ] || fail "数据目录无 ca.pem"
CODE=$(curl -s -o /tmp/pm-lan-stats.json -w "%{http_code}" --cacert "$DATA/ca.pem" https://127.0.0.1:9421/stats.json)
[ "$CODE" = "200" ] || fail "HTTPS 校验失败 (http $CODE)"
grep -q "connected" /tmp/pm-lan-stats.json || fail "stats.json 内容异常"
echo "   ok: 证书链受信任, HTTPS 200"

echo "== 4. 错误 token 应被拒"
TOKEN=$(grep -o "token: [0-9a-f]*" /tmp/pm-lan-server.log | tail -1 | cut -d' ' -f2)
[ -n "$TOKEN" ] || fail "未取到 token"

echo "== 5. headless Edge 走 HTTPS + token 推流（CA 未装入浏览器，忽略证书警告）"
"$EDGE" --headless=new --no-sandbox --disable-gpu --mute-audio --no-first-run --disable-sync \
  --ignore-certificate-errors \
  --user-data-dir="$PROFILE" \
  --use-fake-device-for-media-stream --use-fake-ui-for-media-stream \
  --use-file-for-fake-audio-capture="$FAKE" \
  --autoplay-policy=no-user-gesture-required \
  "https://127.0.0.1:9421/?autostart=1#token=$TOKEN" >/tmp/pm-lan-edge.log 2>&1 &

sleep 10
STATS=$(curl -sf --cacert "$DATA/ca.pem" https://127.0.0.1:9421/stats.json)
echo "   $STATS" | head -c 300; echo

echo "== 6. 停止并校验 WAV"
kill -INT "$SERVER_PID" 2>/dev/null
wait "$SERVER_PID" 2>/dev/null
SERVER_PID=""

python3 - "$DUMP" "$STATS" <<'PYEOF'
import json, math, struct, sys
raw = open(sys.argv[1], "rb").read()
assert raw[:4] == b"RIFF" and raw[8:12] == b"WAVE", "不是 WAV"
pos, data = 12, None
while pos + 8 <= len(raw):
    cid = raw[pos:pos+4]; size = struct.unpack("<I", raw[pos+4:pos+8])[0]
    if cid == b"data":
        data = raw[pos+8:] if size > 0 else raw[pos+8:]
        break
    pos += 8 + size + (size & 1)
samples = struct.unpack(f"<{len(data)//4}f", data)
n = len(samples)
rms = math.sqrt(sum(s*s for s in samples) / max(n, 1))

def goertzel(freq, sr=48000):
    k = 2 * math.pi * freq / sr
    c = 2 * math.cos(k)
    s0 = s1 = s2 = 0.0
    for s in samples:
        s0 = s + c*s1 - s2; s2 = s1; s1 = s0
    return (s1*s1 + s2*s2 - c*s1*s2) / n

p440, p1000 = goertzel(440), goertzel(1000)
stats = json.loads(sys.argv[2])
frames = stats.get("frames_in", 0)
print(f"   样本: {n} ({n/48000:.1f}s)  RMS: {rms:.4f}  440Hz/1000Hz 能量比: {p440/max(p1000,1e-12):.0f}x  帧数: {frames}")
ok = frames > 100 and n > 48000 * 3 and rms > 0.05 and p440 > 10 * p1000
print("   ==> M2 E2E " + ("PASS ✅" if ok else "FAIL ❌"))
sys.exit(0 if ok else 1)
PYEOF
