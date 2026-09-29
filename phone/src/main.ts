// PhoneMic 手机端：采集麦克风 → Opus(可用时)/PCM → WebSocket 推流到桌面端。
import {
  buildAudioFrame,
  FRAME_OPUS,
  FRAME_PCM_F32,
  SAMPLE_RATE,
  type AudioMode,
  type ServerText,
} from "../../shared/protocol";
import "./ui.css";

type Phase = "idle" | "connecting" | "live" | "reconnecting" | "error";

const state = {
  phase: "idle" as Phase,
  running: false,
  mode: "pcm-f32" as AudioMode,
  ws: null as WebSocket | null,
  ctx: null as AudioContext | null,
  stream: null as MediaStream | null,
  node: null as AudioWorkletNode | null,
  encoder: null as any, // AudioEncoder (WebCodecs, Chrome/新 Safari)
  seq: 0,
  t0: 0,
  rttMs: null as number | null,
  level: 0,
  reconnectAttempts: 0,
  wakeLock: null as any,
  pingTimer: 0 as ReturnType<typeof setInterval>,
  // 远程（中继+E2EE）模式
  remote: null as { code: string; deskPub: string } | null,
  aesKey: null as CryptoKey | null,
  e2eeSent: false,
  sendChain: Promise.resolve() as Promise<void>,
};

// ---------- DOM ----------
const app = document.querySelector("#app")!;
app.innerHTML = `
  <header><div class="logo">🎙 PhoneMic</div><div class="sub" id="phase">未连接</div></header>
  <main>
    <button id="mic" aria-label="开始/停止">
      <svg viewBox="0 0 24 24" width="44" height="44"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg>
    </button>
    <div class="meter"><div id="meterFill"></div></div>
    <div class="stats" id="stats">点击开始，把手机对准自己说话</div>
    <div class="hint" id="hint">传输中请保持屏幕常亮与电脑同一 Wi-Fi</div>
  </main>
`;
const $phase = document.querySelector<HTMLElement>("#phase")!;
const $mic = document.querySelector<HTMLButtonElement>("#mic")!;
const $fill = document.querySelector<HTMLElement>("#meterFill")!;
const $stats = document.querySelector<HTMLElement>("#stats")!;
const $micSvg = $mic.querySelector("svg")!;

function setPhase(p: Phase, text?: string) {
  state.phase = p;
  const labels: Record<Phase, string> = {
    idle: "未连接",
    connecting: "连接中…",
    live: "直播中",
    reconnecting: "重连中…",
    error: "出错",
  };
  $phase.textContent = text ?? labels[p];
  $mic.classList.toggle("on", p === "live");
  document.body.classList.toggle("live", p === "live");
  if (p !== "live") {
    state.level = 0;
    $fill.style.width = "0%";
  }
}

function renderStats() {
  const rtt = state.rttMs != null ? `${state.rttMs.toFixed(0)} ms` : "–";
  const db = state.level > 0 ? `${(20 * Math.log10(state.level)).toFixed(0)} dB` : "静音";
  const enc = state.mode === "opus" ? "Opus" : "PCM";
  $stats.textContent = state.remote
    ? `远程·E2EE · 延迟 ${rtt} · 电平 ${db} · ${enc}`
    : `延迟 ${rtt} · 电平 ${db} · ${enc}`;
}

requestAnimationFrame(function loop() {
  if (state.phase === "live" && state.level > 0) {
    const pct = Math.min(100, Math.max(2, (20 * Math.log10(state.level) + 60) * (100 / 60)));
    $fill.style.width = `${pct.toFixed(0)}%`;
  }
  requestAnimationFrame(loop);
});

// ---------- 协议 ----------
// HTTP + 非本机来源 = 非安全上下文，麦克风会被浏览器拒绝 → 带上 token 跳引导页
if (!window.isSecureContext) {
  location.replace(`/setup${location.hash}`);
}

// 远程模式：hash 形如 #p=<配对码>&k=<桌面公钥>
function parseRemote(): { code: string; deskPub: string } | null {
  const p = location.hash.match(/[?&#]p=([A-Za-z0-9_-]{16,64})/);
  const k = location.hash.match(/[?&#]k=([A-Za-z0-9_-]{40,200})/);
  return p && k ? { code: p[1], deskPub: k[1] } : null;
}

function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

function bytesToB64u(u8: Uint8Array): string {
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const te = new TextEncoder();

/** E2EE：手机临时 P-256 密钥对 + 桌面公钥（二维码带外可信）→ HKDF → AES-GCM */
async function initRemoteCrypto(deskPubB64u: string, pairCode: string): Promise<string> {
  const deskKey = await crypto.subtle.importKey("raw", b64uToBytes(deskPubB64u), { name: "ECDH", namedCurve: "P-256" }, false, []);
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: deskKey } as any, kp.privateKey, 256));
  const hk = await crypto.subtle.importKey("raw", shared as any, "HKDF", false, ["deriveBits"]);
  const keyRaw = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: te.encode(pairCode), info: te.encode("phonemic/v1") },
    hk,
    256,
  );
  state.aesKey = await crypto.subtle.importKey("raw", keyRaw, "AES-GCM", false, ["encrypt"]);
  return bytesToB64u(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
}

/** 远程模式加密发送（promise 链保证帧顺序） */
function sendEncryptedFrame(plain: Uint8Array) {
  const ws = state.ws;
  if (!ws || !state.aesKey) return;
  state.sendChain = state.sendChain.then(async () => {
    if (ws.readyState !== WebSocket.OPEN) return;
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as any }, state.aesKey!, plain.subarray(7) as any));
    const f = plain.slice();
    f[0] |= 0x80;
    f.set(nonce, 7);
    f.set(ct, 7 + 12);
    ws.send(f);
  }).catch(() => {});
}

function token(): string {
  const m = location.hash.match(/token=([A-Za-z0-9_-]+)/);
  return m ? m[1] : new URLSearchParams(location.search).get("token") ?? "";
}

function wsUrl(): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  if (state.remote) return `${proto}://${location.host}/ws/pair/${state.remote.code}`;
  return `${proto}://${location.host}/ws?token=${encodeURIComponent(token())}`;
}

async function pickMode(): Promise<AudioMode> {
  const AE = (window as any).AudioEncoder;
  if (AE?.isConfigSupported) {
    try {
      const s = await AE.isConfigSupported({
        codec: "opus",
        sampleRate: SAMPLE_RATE,
        numberOfChannels: 1,
        bitrate: 64000,
      });
      if (s.supported) return "opus";
    } catch {
      /* 回退 PCM */
    }
  }
  return "pcm-f32";
}

function sendJson(obj: unknown) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(obj));
}

function sendAudio(tsMs: number, f32: Float32Array | null, opusBytes: Uint8Array | null) {
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  const kind = opusBytes ? FRAME_OPUS : FRAME_PCM_F32;
  const payload: any = opusBytes ?? f32!;
  const frame = buildAudioFrame(kind, state.seq, tsMs, payload);
  state.seq = (state.seq + 1) & 0xffff;
  if (state.remote && state.aesKey) {
    sendEncryptedFrame(frame);
  } else {
    state.ws.send(frame as any);
  }
}

// ---------- 连接 ----------
function connect() {
  if (state.ws) {
    try {
      state.ws.close();
    } catch {}
    state.ws = null;
  }
  setPhase(state.reconnectAttempts > 0 ? "reconnecting" : "connecting");
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    setPhase("error", "无法创建连接");
    return;
  }
  ws.binaryType = "arraybuffer";
  state.ws = ws;

  ws.onopen = () => {
    sendJson({ type: "hello", mode: state.mode, sampleRate: SAMPLE_RATE, channels: 1 });
  };
  ws.onmessage = async (ev) => {
    if (typeof ev.data !== "string") return;
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    // 远程模式握手：配对就绪后先发 E2EE 公钥再发 hello
    if (msg.type === "roomState" && msg.state === "ready" && state.remote && !state.e2eeSent) {
      state.e2eeSent = true;
      try {
        const myPub = await initRemoteCrypto(state.remote.deskPub, state.remote.code);
        ws.send(JSON.stringify({ type: "e2eeInit", pub: myPub }));
      } catch {
        setPhase("error", "加密初始化失败");
        state.running = false;
        return;
      }
      sendJson({ type: "hello", mode: state.mode, sampleRate: SAMPLE_RATE, channels: 1 });
      return;
    }
    if (msg.type === "error") {
      setPhase("error", msg.code === "EXPIRED" ? "二维码已过期，请在电脑端重新生成" : `中继错误: ${msg.code ?? ""}`);
      state.running = false;
      return;
    }
    if (msg.type === "bye") {
      setPhase("idle", state.remote ? "会话已结束，请刷新二维码" : "对方已断开");
      state.running = false;
      return;
    }
    if (msg.type === "welcome") {
      if (!msg.ok) {
        setPhase("error", msg.message || "被服务端拒绝");
        state.running = false;
        return;
      }
      state.reconnectAttempts = 0;
      state.mode = (msg.mode as AudioMode) || state.mode;
      state.t0 = performance.now();
      state.seq = 0;
      void startAudio();
      clearInterval(state.pingTimer);
      state.pingTimer = setInterval(() => sendJson({ type: "ping", t: performance.now() }), 1000);
    } else if (msg.type === "pong") {
      const rtt = performance.now() - msg.t;
      state.rttMs = state.rttMs == null ? rtt : state.rttMs * 0.7 + rtt * 0.3;
      sendJson({ type: "report", rttMs: Math.round(state.rttMs) });
      renderStats();
    }
  };
  ws.onclose = () => {
    clearInterval(state.pingTimer);
    if (state.running && !state.remote) {
      state.reconnectAttempts += 1;
      const delay = Math.min(8000, 500 * 2 ** Math.min(4, state.reconnectAttempts - 1));
      setPhase("reconnecting");
      setTimeout(() => state.running && connect(), delay);
    } else if (state.running && state.remote) {
      setPhase("error", "远程连接断开，请在电脑端重新生成二维码");
      state.running = false;
    }
  };
  ws.onerror = () => {};
}

// ---------- 采集 ----------
async function startAudio() {
  if (state.ctx && state.stream) {
    // 复用已有采集，仅重连了 WS
    setPhase("live");
    return;
  }
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: SAMPLE_RATE,
      },
    });
  } catch (err: any) {
    const name = err?.name ?? "";
    let hint: string;
    if (name === "NotAllowedError" || name === "SecurityError") {
      hint = "麦克风权限被拒：请在浏览器中允许本页面使用麦克风后重试";
    } else if (!window.isSecureContext) {
      hint = "连接不安全：请从电脑端二维码进入（https 链接）";
    } else {
      hint = "麦克风不可用：若浏览器提示证书问题，需先点“高级 → 继续访问”";
    }
    setPhase("error", hint);
    state.running = false;
    return;
  }

  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  await ctx.resume();
  await ctx.audioWorklet.addModule(new URL("./pcm-pump.worklet.js", import.meta.url));

  const src = ctx.createMediaStreamSource(state.stream);
  const node = new AudioWorkletNode(ctx, "pcm-pump");
  // 连接到静音增益再接 destination：既驱动 worklet 运转，也兼作 iOS 后台保活的音频会话。
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  if (state.mode === "opus") {
    const enc = new (window as any).AudioEncoder({
      output: (chunk: any) => {
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);
        sendAudio(Math.round(chunk.timestamp / 1000), null, buf);
      },
      error: (e: unknown) => console.error("encoder", e),
    });
    enc.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: 64000 });
    state.encoder = enc;
  }

  node.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    const f32 = ev.data;
    // 本地电平（RMS）
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / f32.length);
    state.level = state.level * 0.6 + rms * 0.4;
    if (state.mode === "opus") {
      const ad = new (window as any).AudioData({
        format: "f32",
        sampleRate: SAMPLE_RATE,
        numberOfFrames: f32.length,
        numberOfChannels: 1,
        timestamp: Math.round((performance.now() - state.t0) * 1000),
        data: f32,
      });
      state.encoder.encode(ad);
      ad.close();
    } else {
      sendAudio(Math.round(performance.now() - state.t0), f32, null);
    }
  };

  state.ctx = ctx;
  state.node = node;
  setPhase("live");
  renderStats();
  keepAwake();
}

async function stopAudio() {
  clearInterval(state.pingTimer);
  state.running = false;
  try {
    state.ws?.close();
  } catch {}
  state.ws = null;
  try {
    state.encoder?.close();
  } catch {}
  state.encoder = null;
  state.node?.port.close();
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
  await state.ctx?.close().catch(() => {});
  state.ctx = null;
  state.node = null;
  state.reconnectAttempts = 0;
  state.rttMs = null;
  state.aesKey = null;
  state.e2eeSent = false;
  await state.wakeLock?.release?.().catch(() => {});
  state.wakeLock = null;
  setPhase("idle");
  renderStats();
}

async function keepAwake() {
  try {
    if ("wakeLock" in navigator && state.running) {
      state.wakeLock = await (navigator as any).wakeLock.request("screen");
    }
  } catch {}
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.running) {
    state.ctx?.resume();
    keepAwake();
  }
});

// ---------- UI 事件 ----------
$mic.addEventListener("click", async () => {
  if (state.running) {
    await stopAudio();
    return;
  }
  state.running = true;
  state.mode = await pickMode();
  connect();
});

// 远程模式（hash 携带 p=/k=）或自动开始
state.remote = parseRemote();
if (state.remote) {
  document.querySelector<HTMLElement>(".hint")!.textContent =
    "跨网络模式 · 端到端加密 · 语音经 Cloudflare 中继转发";
}
const autoStart =
  state.remote != null || new URLSearchParams(location.search).get("autostart") === "1";
if (autoStart) {
  state.running = true;
  pickMode().then((m) => {
    state.mode = m;
    connect();
  });
}
