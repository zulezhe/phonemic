// PhoneMic 桌面端 UI：配对二维码、服务状态、设备选择、实时统计。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./styles.css";

interface StatsSnapshot {
  connected: boolean;
  mode: string;
  frames_in: number;
  samples_in: number;
  bytes_in: number;
  dropped_frames: number;
  lost_frames: number;
  underruns: number;
  target_buffer_ms: number;
  buffered_ms: number;
  rtt_ms: number | null;
  level_rms: number;
  last_frame_age_ms: number;
}

interface StatusResponse {
  running: boolean;
  port: number;
  https_port: number | null;
  lan_ip: string | null;
  token: string | null;
  setup_url: string | null;
  https_url: string | null;
  output_device: string | null;
  output_rate: number | null;
  has_preferred_device: boolean;
  mdns_host: string | null;
  stats: StatsSnapshot;
}

interface PairingInfo {
  qr_url: string;
  setup_url: string;
  https_url: string | null;
  qr_svg: string;
}

const app = document.querySelector("#app")!;

app.innerHTML = `
  <header>
    <div class="title">🎙 PhoneMic</div>
    <div class="subtitle">手机 → 电脑麦克风</div>
  </header>

  <section class="card" id="qrCard">
    <div class="label" id="qrLabel">手机扫码配对</div>
    <div id="qrBox" class="qrbox"><div class="qr-skeleton"></div></div>
    <div id="pairRows">
      <div class="row"><span>直连</span><span id="setupUrl" class="mono small">–</span></div>
      <div class="row"><span>引导页(可选)</span><span id="httpsUrl" class="mono small">–</span></div>
      <div class="fine" id="certHint"></div>
    </div>
    <div id="connInfo" class="conn-info hidden">
      <div class="conn-row"><span>编码</span><b id="cMode">–</b></div>
      <div class="conn-row"><span>延迟</span><b id="cRtt">–</b></div>
    </div>
  </section>

  <section class="card">
    <div class="row"><span>服务状态</span><span id="running" class="pill">–</span></div>
    <div class="row"><span>输出设备</span>
      <select id="deviceSelect"><option>加载中…</option></select>
    </div>
    <div class="fine" id="blackholeHint"></div>
    <button id="btnDriver" class="ghost hidden">一键安装虚拟麦克风驱动</button>
    <div class="actions">
      <button id="btnRestart" class="primary">重启服务</button>
      <button id="btnStop">停止</button>
    </div>
  </section>

  <section class="card">
    <div class="label">输入电平</div>
    <div class="meter"><div id="meterFill"></div></div>
    <div class="grid">
      <div><b id="vRtt">–</b><span>往返延迟</span></div>
      <div><b id="vLoss">–</b><span>丢帧</span></div>
      <div><b id="vUnderrun">–</b><span>下溢</span></div>
      <div><b id="vBuffer">–</b><span>缓冲</span></div>
      <div><b id="vFrames">–</b><span>已收帧</span></div>
      <div><b id="vMode">–</b><span>编码</span></div>
    </div>
  </section>

  <section class="card hint">
    装有 BlackHole 时会自动选为输出，电脑应用里选择 <b>BlackHole 2ch</b> 作为麦克风即可（QuickTime / 输入法 / 会议软件）。
    此时本机扬声器不出声是正常的——声音进了虚拟麦克风。
  </section>
`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const isTauri = "__TAURI_INTERNALS__" in window;
let devicesCache: string[] = [];
let lastStatus: StatusResponse | null = null;
let qrShown = false;
let qrLoading = false;
let qrSvgCache = "";
let connectedUi = false;
let pairQrUrl = "";
let pairSetupUrl = "";

function fmtNum(n: number): string {
  return n.toLocaleString("zh-CN");
}

function copyText(t: string) {
  navigator.clipboard?.writeText(t).catch(() => {});
}

async function refreshQr() {
  if (!isTauri || qrLoading) return;
  qrLoading = true;
  try {
    const p = await invoke<PairingInfo>("pairing_qr");
    qrSvgCache = p.qr_svg;
    pairQrUrl = p.qr_url;
    pairSetupUrl = p.setup_url.replace(/#.*$/, "") + "/setup";
    qrShown = true;
    if (!connectedUi) renderPairingIdle();
  } catch (e) {
    const msg = String(e);
    console.error("pairing_qr failed", e);
    // 只在还没成功显示过时占位；错误文案直接可见，便于定位（服务就绪后 500ms 轮询会自动重试）
    if (!qrShown && !connectedUi) {
      $("#qrBox").innerHTML = `<div class="qr-err">二维码暂不可用：<br>${msg.slice(0, 90)}</div>`;
    }
  } finally {
    qrLoading = false;
  }
}

/** 未连接时的配对视图（二维码 + 链接行） */
function renderPairingIdle() {
  if (!qrSvgCache) {
    $("#qrBox").innerHTML = '<div class="qr-skeleton"></div>';
    return;
  }
  $("#qrBox").innerHTML = qrSvgCache;
  $("#qrLabel").textContent = "手机扫码配对";
  $("#pairRows").classList.remove("hidden");
  $("#connInfo").classList.add("hidden");
  $("#qrBox").classList.remove("connected");
  $("#setupUrl").textContent = pairQrUrl || "–";
  $("#setupUrl").title = "点击复制";
  $("#httpsUrl").textContent = pairSetupUrl || "–";
  $("#httpsUrl").title = "一次性安装 CA 证书以永久消除浏览器的“不安全”提示";
}

/** 已连接视图：绿色状态面板替代二维码 */
function renderConnected(s: StatsSnapshot) {
  $("#qrBox").classList.add("connected");
  $("#qrBox").innerHTML = `
    <div class="conn-check">✓</div>
    <div class="conn-title">手机已连接</div>
    <div class="conn-sub">${s.mode === "opus" ? "Opus" : "PCM"} · ${s.rtt_ms != null ? Math.round(s.rtt_ms) + "ms" : "–"}</div>`;
  $("#qrLabel").textContent = "正在使用手机麦克风";
  $("#pairRows").classList.add("hidden");
  $("#cMode").textContent = s.mode === "opus" ? "Opus 48kHz" : "PCM 48kHz";
  $("#cRtt").textContent = s.rtt_ms != null ? `${Math.round(s.rtt_ms)} ms` : "–";
  $("#connInfo").classList.remove("hidden");
}

async function refreshDevices() {
  if (!isTauri) return;
  devicesCache = await invoke<string[]>("output_devices");
  const sel = $<HTMLSelectElement>("#deviceSelect");
  const current = lastStatus?.output_device;
  sel.innerHTML =
    `<option value="">系统默认${lastStatus?.has_preferred_device ? "（含 BlackHole 自动选择）" : ""}</option>` +
    devicesCache.map((d) => `<option ${d === current ? "selected" : ""}>${d}</option>`).join("");
  renderBlackholeHint();
}

function renderBlackholeHint() {
  const has = devicesCache.some((d) => d.includes("BlackHole"));
  const btn = $<HTMLButtonElement>("#btnDriver");
  if (has) {
    $("#blackholeHint").innerHTML = `✅ 已检测到 BlackHole —— 电脑应用选择 <b>BlackHole 2ch</b> 作为麦克风输入`;
    btn.textContent = "修复驱动（重装 + 重启音频服务）";
    btn.classList.remove("hidden");
  } else {
    $("#blackholeHint").innerHTML = `未检测到 BlackHole（虚拟麦克风）——当前仅从本机输出设备播放`;
    btn.textContent = "一键安装虚拟麦克风驱动（需输一次密码）";
    btn.classList.remove("hidden");
  }
}

function render(st: StatusResponse) {
  lastStatus = st;
  const s = st.stats;
  $("#running").textContent = s.connected ? "直播中" : st.running ? "等待手机" : "已停止";
  $("#running").className = `pill ${s.connected ? "ok" : st.running ? "wait" : "off"}`;

  // 配对视图 ↔ 已连接视图切换（只在状态变化时重绘，避免每 500ms 闪动）
  if (s.connected && !connectedUi) {
    connectedUi = true;
    renderConnected(s);
  } else if (!s.connected && connectedUi) {
    connectedUi = false;
    renderPairingIdle();
  } else if (s.connected) {
    $("#cRtt").textContent = s.rtt_ms != null ? `${Math.round(s.rtt_ms)} ms` : "–";
  }

  if (!st.setup_url) $("#setupUrl").textContent = "服务未运行";
  $("#certHint").textContent = "首次打开如提示“不是私密连接”：高级 → 继续访问即可";

  $("#vRtt").textContent = s.rtt_ms != null ? `${Math.round(s.rtt_ms)}ms` : "–";
  const total = s.frames_in + s.lost_frames;
  $("#vLoss").textContent = total > 0 ? `${s.lost_frames} (${((s.lost_frames / total) * 100).toFixed(1)}%)` : "0";
  $("#vUnderrun").textContent = fmtNum(s.underruns);
  $("#vBuffer").textContent = `${s.buffered_ms}/${s.target_buffer_ms}ms`;
  $("#vFrames").textContent = fmtNum(s.frames_in);
  $("#vMode").textContent = s.mode || "–";

  const pct = s.level_rms > 0 ? Math.min(100, Math.max(3, (20 * Math.log10(s.level_rms) + 60) * (100 / 60))) : 0;
  $("#meterFill").style.width = `${pct.toFixed(0)}%`;

  // 启动竞态兜底：服务一旦就绪而二维码还没显示成功，立即重试
  if (st.running && !qrShown) void refreshQr();

  const dev = $<HTMLSelectElement>("#deviceSelect");
  if (dev.options.length <= 1 && st.running) void refreshDevices();
}

if (!isTauri) {
  $("#qrCard").classList.add("hidden");
  $<HTMLElement>(".hint").innerHTML =
    "当前页面在浏览器中打开——桌面 UI 需要 Tauri App 运行（<code>npm run tauri:dev</code>）。";
} else {
  invoke<StatusResponse>("get_status").then(render).catch(console.error);
  void listen<StatusResponse>("stats", (e) => render(e.payload));
  void refreshQr();
  void refreshDevices();

  $("#btnRestart").addEventListener("click", async () => {
    $("#btnRestart").textContent = "重启中…";
    try {
      render(await invoke<StatusResponse>("start_server"));
    } catch (e) {
      console.error(e);
    }
    $("#btnRestart").textContent = "重启服务";
    void refreshQr();
    void refreshDevices();
  });
  $("#btnStop").addEventListener("click", async () => {
    render(await invoke<StatusResponse>("stop_server"));
    qrShown = false; // 停止后二维码失效，下次启动重新获取
    $("#qrBox").innerHTML = '<div class="qr-skeleton"></div>';
  });
  $<HTMLSelectElement>("#deviceSelect").addEventListener("change", async (e) => {
    const name = (e.target as HTMLSelectElement).value || null;
    try {
      render(await invoke<StatusResponse>("set_output_device", { name }));
    } catch (err) {
      console.error(err);
      alert(`切换输出设备失败: ${err}`);
    }
  });
  $("#btnDriver").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("#btnDriver");
    btn.disabled = true;
    btn.textContent = "安装中…（请在系统弹窗输入密码）";
    try {
      const msg = await invoke<string>("install_driver");
      console.log("install_driver:", msg);
    } catch (e) {
      alert(`驱动安装未完成：${e}`);
    }
    btn.disabled = false;
    await refreshDevices();
  });
  $("#setupUrl").addEventListener("click", (e) => {
    const t = (e.target as HTMLElement).textContent;
    if (t) copyText(t);
  });
}
