// PhoneMic 手机端：采集麦克风 → Opus(可用时)/PCM → WebSocket 推流到桌面端。

// ---------- i18n ----------
const STR = {
  zh: {
    idle: "未连接", connecting: "连接中…", live: "直播中", reconnecting: "重连中…", error: "出错",
    tapToStart: "点击开始，把手机对准自己说话",
    keepHint: "传输中请保持屏幕常亮与电脑同一 Wi-Fi",
    remoteHint: "跨网络连接 · 语音已加密",
    encLive: "远程·E2EE", silent: "静音",
    errPerm: "麦克风权限被拒：请在浏览器中允许本页面使用麦克风后重试",
    errInsecure: "连接不安全：请从电脑端二维码进入",
    errMic: "麦克风不可用：若浏览器提示证书问题，需先点“高级 → 继续访问”",
    errCrypto: "加密初始化失败",
    errExpired: "二维码已过期，请在电脑端重新生成",
    errGeneric: "连接出错，请重试",
    byeRemote: "本次连接已结束，可重新扫码",
    byePeer: "对方已断开",
    errClosed: "连接已断开，请重新扫码",
    stageCrypto: "正在建立加密…",
    stageMic: "正在启动麦克风…",
    silent2: "静音", db: "dB", delay: "延迟", start: "开始传输", stop: "点击停止", ready: "轻触按钮开始传输",
  },
  en: {
    idle: "Not connected", connecting: "Connecting…", live: "LIVE", reconnecting: "Reconnecting…", error: "Error",
    tapToStart: "Tap to start — speak toward your phone",
    keepHint: "Keep the screen on while streaming",
    remoteHint: "Cross-network · voice encrypted",
    encLive: "Remote·E2EE", silent: "silent",
    errPerm: "Microphone denied. Please allow mic access and retry.",
    errInsecure: "Insecure connection: open via the QR code on your computer",
    errMic: "Microphone unavailable. If the browser shows a certificate warning, choose Advanced → Proceed.",
    errCrypto: "Encryption setup failed",
    errExpired: "QR code expired — regenerate it on your computer",
    errGeneric: "Connection error, please retry",
    byeRemote: "Session ended — scan again",
    byePeer: "Peer disconnected",
    errClosed: "Disconnected — scan again",
    stageCrypto: "Establishing encryption…",
    stageMic: "Starting microphone…",
    silent2: "silent", db: "dB", delay: "Latency", start: "Start streaming", stop: "Tap to stop", ready: "Tap the button to begin",
  },
} as const;
type Lang = Record<string, string>;
const L: Lang = (navigator.language || "zh").toLowerCase().startsWith("zh") ? STR.zh : STR.en;
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
  remote: null as { code: string; deskPub: string; lan?: string; ltoken?: string } | null,
  mediaPromise: null as Promise<MediaStream> | null,
  upgrading: false,
  aesKey: null as CryptoKey | null,
  e2eeSent: false,
  sendChain: Promise.resolve() as Promise<void>,
};

// ---------- DOM ----------
const app = document.querySelector("#app")!;
app.innerHTML = `
  <header><div class="brand"><span class="brand-icon"><svg viewBox="0 0 24 24"><path d="M12 15.5a4 4 0 0 0 4-4v-5a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Z"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/></svg></span><span class="logo">PhoneMic</span></div><div class="sub" id="phase">未连接</div></header>
  <main>
    <div class="mic-zone"><div class="pulse-ring ring-one"></div><div class="pulse-ring ring-two"></div><button id="mic" aria-label="开始传输" aria-pressed="false"><svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z"/></svg></button></div>
    <div class="action-copy"><strong id="actionLabel">轻触按钮开始传输</strong><span id="actionHint">手机将成为电脑的麦克风</span></div>
    <section class="signal-card" aria-label="传输状态"><div class="signal-head"><span>输入电平</span><span id="dbValue">静音</span></div><div class="meter"><div id="meterFill"></div><i></i><i></i><i></i></div><div class="stats" id="stats">点击开始，把手机对准自己说话</div></section>
    <div class="hint" id="hint"><span class="lock">◆</span> 传输中请保持屏幕常亮与电脑同一 Wi-Fi</div>
  </main>
`;
const $phase = document.querySelector<HTMLElement>("#phase")!;
const $mic = document.querySelector<HTMLButtonElement>("#mic")!;
const $fill = document.querySelector<HTMLElement>("#meterFill")!;
const $stats = document.querySelector<HTMLElement>("#stats")!;
const $micSvg = $mic.querySelector("svg")!;
const $actionLabel = document.querySelector<HTMLElement>("#actionLabel")!;
const $actionHint = document.querySelector<HTMLElement>("#actionHint")!;
const $dbValue = document.querySelector<HTMLElement>("#dbValue")!;

function setPhase(p: Phase, text?: string) {
  state.phase = p;
  const labels: Record<Phase, string> = {
    idle: L.idle,
    connecting: L.connecting,
    live: L.live,
    reconnecting: L.reconnecting,
    error: L.error,
  };
  $phase.textContent = text ?? labels[p];
  $mic.classList.toggle("on", p === "live");
  $mic.setAttribute("aria-pressed", String(p === "live"));
  $mic.setAttribute("aria-label", p === "live" ? L.stop : L.start);
  $actionLabel.textContent = p === "live" ? L.stop : p === "connecting" || p === "reconnecting" ? labels[p] : L.ready;
  $actionHint.textContent = p === "live" ? L.keepHint : L.tapToStart;
  document.body.classList.toggle("live", p === "live");
  if (p !== "live") {
    state.level = 0;
    $fill.style.width = "0%";
  }
}

function renderStats() {
  const rtt = state.rttMs != null ? `${state.rttMs.toFixed(0)} ms` : "–";
  const db = state.level > 0 ? `${(20 * Math.log10(state.level)).toFixed(0)} ${L.db}` : L.silent2;
  $dbValue.textContent = db;
  const enc = state.mode === "opus" ? "Opus" : "PCM";
  $stats.textContent = state.remote
    ? `${L.encLive} · ${L.delay} ${rtt} · ${db} · ${enc}`
    : `${L.delay} ${rtt} · ${db} · ${enc}`;
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
function parseRemote(): { code: string; deskPub: string; lan?: string; ltoken?: string } | null {
  const p = location.hash.match(/[?&#]p=([A-Za-z0-9_-]{16,64})/);
  const k = location.hash.match(/[?&#]k=([A-Za-z0-9_-]{40,200})/);
  if (!p || !k) return null;
  const l = location.hash.match(/[?&#]l=([A-Za-z0-9_.:-]+)/);
  const t = location.hash.match(/[?&#]t=([A-Za-z0-9]+)/);
  return { code: p[1], deskPub: k[1], lan: l?.[1], ltoken: t?.[1] };
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
    // 密文比明文长 28B（nonce+tag），必须新开缓冲区（旧写法 slice 后 set 越界且被静默吞掉）
    const f = new Uint8Array(7 + 12 + ct.length);
    f.set(plain.subarray(0, 7), 0);
    f[0] = plain[0] | 0x80;
    f.set(nonce, 7);
    f.set(ct, 19);
    ws.send(f);
  }).catch((e) => {
    console.error("加密发送失败", e);
  });
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
    } catch {
      /* ignore */
    }
    state.ws = null;
  }
  setPhase(state.reconnectAttempts > 0 ? "reconnecting" : "connecting");
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl());
  } catch {
    setPhase("error", "无法创建连接");
    return;
  }
  ws.binaryType = "arraybuffer";
  state.ws = ws;
  ws.onopen = () => {
    // 本地模式立即 hello；远程模式等 roomState ready 后再发（见 attachWsHandlers）
    if (!state.remote) {
      sendJson({ type: "hello", mode: state.mode, sampleRate: SAMPLE_RATE, channels: 1 });
    }
  };
  attachWsHandlers(ws);
}

/** WS 消息处理（云端连接与升级后的局域网直连共用） */
function attachWsHandlers(ws: WebSocket) {
  ws.onmessage = async (ev) => {
    if (typeof ev.data !== "string") return;
    let msg: any;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    // 远程模式握手：配对就绪后先发加密公钥再发 hello
    if (msg.type === "roomState" && msg.state === "ready" && state.remote && !state.e2eeSent) {
      state.e2eeSent = true;
      setPhase("connecting", L.stageCrypto);
      try {
        const myPub = await initRemoteCrypto(state.remote.deskPub, state.remote.code);
        ws.send(JSON.stringify({ type: "e2eeInit", pub: myPub }));
      } catch {
        setPhase("error", L.errCrypto);
        state.running = false;
        return;
      }
      sendJson({ type: "hello", mode: state.mode, sampleRate: SAMPLE_RATE, channels: 1 });
      setPhase("connecting", L.stageMic);
      return;
    }
    if (msg.type === "error") {
      setPhase("error", msg.code === "EXPIRED" ? L.errExpired : L.errGeneric);
      state.running = false;
      return;
    }
    if (msg.type === "bye") {
      setPhase("idle", state.remote ? L.byeRemote : L.byePeer);
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
      clearInterval(state.pingTimer);
      state.pingTimer = setInterval(() => sendJson({ type: "ping", t: performance.now() }), 1000);
      void startAudio();
      // 赛马升级：云端会话建立后，后台探测局域网直连（更快的路径）
      if (state.remote?.lan && state.remote?.ltoken && !state.upgrading) {
        setTimeout(() => probeLanUpgrade(), 800);
      }
    } else if (msg.type === "pong") {
      const rtt = performance.now() - msg.t;
      state.rttMs = state.rttMs == null ? rtt : state.rttMs * 0.7 + rtt * 0.3;
      sendJson({ type: "report", rttMs: Math.round(state.rttMs) });
      renderStats();
    }
  };
  ws.onclose = () => {
    clearInterval(state.pingTimer);
    if (state.upgrading) return; // 升级切换中关闭旧连接，忽略
    if (state.running && !state.remote) {
      state.reconnectAttempts += 1;
      const delay = Math.min(8000, 500 * 2 ** Math.min(4, state.reconnectAttempts - 1));
      setPhase("reconnecting");
      setTimeout(() => state.running && connect(), delay);
    } else if (state.running && state.remote) {
      setPhase("error", L.errClosed);
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
    state.stream = await (state.mediaPromise ?? navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: SAMPLE_RATE,
      },
    }));
    state.mediaPromise = null;
  } catch (err: any) {
    const name = err?.name ?? "";
    let hint: string;
    if (name === "NotAllowedError" || name === "SecurityError") {
      hint = L.errPerm;
    } else if (!window.isSecureContext) {
      hint = L.errInsecure;
    } else {
      hint = L.errMic;
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

/** 赛马升级：探测局域网直连（需手机已信任本机证书），成功则整体切换发送通道。
 *  失败（证书未信任/跨网络被拦）则静默留在云端路径。 */
function probeLanUpgrade() {
  if (!state.remote?.lan || !state.remote?.ltoken || state.upgrading) return;
  const lan = state.remote.lan!;
  const token = state.remote.ltoken!;
  let probe: WebSocket;
  try {
    probe = new WebSocket(`wss://${lan}/ws?token=${encodeURIComponent(token)}`);
  } catch {
    return;
  }
  state.upgrading = true;
  const giveUp = setTimeout(() => {
    state.upgrading = false;
    try { probe.close(); } catch { /* ignore */ }
  }, 2000);

  probe.onopen = () => {
    probe.send(JSON.stringify({ type: "hello", mode: state.mode, sampleRate: SAMPLE_RATE, channels: 1 }));
  };
  probe.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    let m: any;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type !== "welcome" || !m.ok) return;
    clearTimeout(giveUp);
    // 切换：发送通道换到本地直连，静默关闭中继连接（不触发错误提示）
    const old = state.ws;
    state.ws = probe;
    state.remote = null;
    state.aesKey = null;
    state.upgrading = false;
    state.t0 = performance.now();
    state.seq = 0;
    clearInterval(state.pingTimer);
    state.pingTimer = setInterval(() => sendJson({ type: "ping", t: performance.now() }), 1000);
    attachWsHandlers(probe);
    if (old) {
      old.onclose = null;
      old.onerror = null;
      try { old.close(); } catch { /* ignore */ }
    }
    renderStats();
  };
  probe.onerror = () => {
    clearTimeout(giveUp);
    state.upgrading = false;
  };
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
  state.mediaPromise = null;
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
  setPhase("connecting", "正在连接…");
  // 并行准备：麦克风权限弹窗尽早出现，与网络连接/密钥协商互不等待
  state.mediaPromise = navigator.mediaDevices
    .getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: SAMPLE_RATE,
      },
    })
    .catch((err) => {
      throw err;
    });
  state.mode = await pickMode();
  connect();
});

// PWA Service Worker 注册（https 或 localhost）
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

// 保活增强：WakeLock 可能被系统回收，周期性补锁
setInterval(() => {
  if (state.running && document.visibilityState === "visible") keepAwake();
}, 30_000);

// 远程模式（hash 携带 p=/k=）或自动开始
state.remote = parseRemote();
if (state.remote) {
  document.querySelector<HTMLElement>(".hint")!.textContent = L.remoteHint;
}
const autoStart =
  state.remote != null || new URLSearchParams(location.search).get("autostart") === "1";
if (autoStart) {
  state.running = true;
  state.mediaPromise = navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: SAMPLE_RATE },
  }).catch((e) => {
    throw e;
  });
  pickMode().then((m) => {
    state.mode = m;
    connect();
  });
}
