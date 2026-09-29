// 假手机：模拟手机页的远程模式全流程（WebCrypto E2EE → CF 中继 → 桌面端）。
// 用法: node fake_phone.mjs "https://relay.dyzyzj.top/#p=<code>&k=<pub>" [秒数]
import { buildAudioFramePcm } from "./frame.mjs";

const url = process.argv[2];
const seconds = Number(process.argv[3] ?? 6);
if (!url) {
  console.error("用法: node fake_phone.mjs <远程配对URL> [秒数]");
  process.exit(1);
}
const hash = url.split("#")[1] ?? "";
const p = hash.match(/p=([A-Za-z0-9_-]+)/)?.[1];
const k = hash.match(/k=([A-Za-z0-9_-]+)/)?.[1];
if (!p || !k) {
  console.error("URL 缺少 p=/k= 参数");
  process.exit(1);
}
const origin = new URL(url).origin;
const te = new TextEncoder();
const b64uToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// E2EE：与手机页 initRemoteCrypto 相同
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
const myPubB = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
let myPubB64u = "";
for (const b of myPubB) myPubB64u += String.fromCharCode(b);
myPubB64u = btoa(myPubB64u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
console.log(`E2EE 密钥已派生（配对码 ${p.slice(0, 8)}…）`);

// 连接中继房间
const ws = new WebSocket(`${origin.replace("https", "wss")}/ws/pair/${p}`);
ws.binaryType = "arraybuffer";
let seq = 0;
const t0 = Date.now();
let sent = 0;
let pongs = 0;

ws.onmessage = async (ev) => {
  if (typeof ev.data !== "string") return;
  const msg = JSON.parse(ev.data);
  if (msg.type === "roomState" && msg.state === "ready") {
    console.log("房间就绪，发送 e2eeInit + hello");
    ws.send(JSON.stringify({ type: "e2eeInit", pub: myPubB64u }));
    ws.send(JSON.stringify({ type: "hello", mode: "pcm-f32", sampleRate: 48000, channels: 1 }));
  } else if (msg.type === "welcome") {
    console.log(`桌面端应答: ${JSON.stringify(msg)}`);
    // 以 20ms 节奏发送加密的 440Hz 正弦 PCM
    const timer = setInterval(async () => {
      if (ws.readyState !== WebSocket.OPEN) return clearInterval(timer);
      const f32 = new Float32Array(960);
      for (let i = 0; i < 960; i++) {
        f32[i] = Math.sin((2 * Math.PI * 440 * ((seq * 960 + i) % 48000)) / 48000) * 0.3;
      }
      const plain = buildAudioFramePcm(seq & 0xffff, Date.now() - t0, f32);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plain.subarray(7)));
      const f = new Uint8Array(7 + 12 + ct.length);
      f.set(plain.subarray(0, 7), 0);
      f[0] = plain[0] | 0x80;
      f.set(nonce, 7);
      f.set(ct, 19);
      ws.send(f);
      seq++;
      sent++;
      if (seq % 50 === 0) ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
    }, 20);
    setTimeout(() => {
      clearInterval(timer);
      console.log(`发送完毕: ${sent} 帧，收到 pong ${pongs} 次`);
      ws.close();
      process.exit(0);
    }, seconds * 1000);
  } else if (msg.type === "pong") {
    pongs++;
  } else {
    console.log("←", JSON.stringify(msg).slice(0, 100));
  }
};
ws.onopen = () => console.log(`已连接中继 ${origin}（角色 phone）`);
ws.onerror = () => {
  console.error("连接失败");
  process.exit(1);
};
