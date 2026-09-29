// 赛马升级端到端测试：模拟手机先连云端（E2EE）→ 再探测局域网直连 → 切换发送通道。
// 验证：云端会话建立 → 升级到本地明文会话 → 桌面端继续收到音频。
// 用法: node upgrade_race.mjs <云端URL（含 p/k/l/t）>
import WebSocket from "ws";
import { buildAudioFramePcm } from "./frame.mjs";

const url = process.argv[2];
const hash = url.split("#")[1] ?? "";
const p = hash.match(/p=([A-Za-z0-9_-]+)/)?.[1];
const k = hash.match(/k=([A-Za-z0-9_-]+)/)?.[1];
const l = hash.match(/l=([A-Za-z0-9_.:-]+)/)?.[1];
const t = hash.match(/t=([A-Za-z0-9]+)/)?.[1];
if (!p || !k || !l || !t) {
  console.error("URL 需包含 p/k/l/t 参数");
  process.exit(1);
}
const te = new TextEncoder();
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// 云端 E2EE
const deskKey = await crypto.subtle.importKey("raw", b64uToBytes(k), { name: "ECDH", namedCurve: "P-256" }, false, []);
const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: deskKey }, kp.privateKey, 256));
const hk = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
const keyRaw = await crypto.subtle.deriveBits(
  { name: "HKDF", hash: "SHA-256", salt: te.encode(p), info: te.encode("phonemic/v1") },
  hk,
  256,
);
const aesKey = await crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["encrypt"]);
let myPubB64u = "";
for (const b of new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))) myPubB64u += String.fromCharCode(b);
myPubB64u = btoa(myPubB64u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let seq = 0;
let sentVia = "cloud";
let cloudFrames = 0;
let localFrames = 0;

function makeFrame() {
  const f32 = new Float32Array(960);
  for (let i = 0; i < 960; i++) f32[i] = Math.sin((2 * Math.PI * 440 * ((seq * 960 + i) % 48000)) / 48000) * 0.3;
  return buildAudioFramePcm(seq++ & 0xffff, Date.now() % 2 ** 31, f32);
}

async function sendEncrypted(ws, plain) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plain.subarray(7)));
  const f = new Uint8Array(7 + 12 + ct.length);
  f.set(plain.subarray(0, 7), 0);
  f[0] = plain[0] | 0x80;
  f.set(nonce, 7);
  f.set(ct, 19);
  ws.send(f);
}

// 1. 云端连接
const cloud = new WebSocket(`wss://relay.dyzyzj.top/ws/pair/${p}`);
cloud.binaryType = "arraybuffer";
cloud.onmessage = async (ev) => {
  const m = JSON.parse(String(ev.data));
  if (m.type === "roomState" && m.state === "ready") {
    console.log("✓ 云端房间就绪");
    cloud.send(JSON.stringify({ type: "e2eeInit", pub: myPubB64u }));
    cloud.send(JSON.stringify({ type: "hello", mode: "pcm-f32", sampleRate: 48000, channels: 1 }));
  } else if (m.type === "welcome") {
    console.log("✓ 云端会话建立（E2EE），开始推流");
    startStreaming(cloud, "cloud");
    // 2. 800ms 后探测局域网（模拟手机页 probeLanUpgrade）
    setTimeout(() => probeLocal(), 800);
  }
};
await new Promise((r) => (cloud.onopen = r));

let timer;
function startStreaming(ws, via) {
  if (timer) clearInterval(timer);
  timer = setInterval(async () => {
    const f = makeFrame();
    if (via === "cloud") {
      await sendEncrypted(ws, f);
      cloudFrames++;
    } else {
      ws.send(f);
      localFrames++;
    }
  }, 20);
}

// 3. 局域网探测与切换
function probeLocal() {
  const probe = new WebSocket(`wss://${l}/ws?token=${t}`, { rejectUnauthorized: false });
  probe.onopen = () => probe.send(JSON.stringify({ type: "hello", mode: "pcm-f32", sampleRate: 48000, channels: 1 }));
  probe.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.type === "welcome" && m.ok) {
      console.log("✓ 局域网直连探测成功，切换发送通道");
      startStreaming(probe, "local");
      sentVia = "local";
      cloud.onclose = null;
      cloud.close();
      // 6 秒后结束
      setTimeout(() => {
        clearInterval(timer);
        console.log(`结果: 云端帧 ${cloudFrames}，本地帧 ${localFrames}，最终路径 ${sentVia}`);
        const ok = localFrames > 50;
        console.log(ok ? "✅ 升级赛马 PASS" : "❌ 本地帧不足");
        process.exit(ok ? 0 : 1);
      }, 6000);
    }
  };
  probe.onerror = () => console.log("（局域网探测失败——保留云端路径）");
}
