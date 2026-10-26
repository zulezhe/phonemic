// PhoneMic 桌面端 UI：配对二维码、服务状态、设备选择、实时统计。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { t } from "./i18n";
import "./styles.css";

interface StatsSnapshot {
  connected: boolean;
  remote: boolean;
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
  <header class="app-header">
    <div class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 15.5a4 4 0 0 0 4-4v-5a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Z"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/></svg></div>
    <div><div class="title">PhoneMic</div><div class="subtitle">${t("subtitle")}</div></div>
    <span id="running" class="pill off">${t("checking")}</span>
  </header>

  <section class="card pairing-card" id="qrCard">
    <div class="section-heading"><div><span class="step">1</span><span id="qrLabel">${t("stepPair")}</span></div><span class="secure"><span aria-hidden="true">◆</span> ${t("e2ee")}</span></div>
    <div class="qr-stage"><div id="qrBox" class="qrbox"><div class="qr-skeleton"></div></div></div>
    <div id="pairRows">
      <button id="setupUrl" class="path-row" type="button" title="${t("copyLinkTitle")}"><span class="path-icon">◎</span><span><b>${t("anyNetwork")}</b><small>${t("anyNetworkSub")}</small></span><span class="copy-label">${t("copy")}</span></button>
      <div class="path-row lan-row"><span class="path-icon">⌁</span><span><b>${t("sameNetwork")}</b><small id="httpsUrl" class="mono">${t("lanSub")}</small></span><span class="speed-label">${t("faster")}</span></div>
      <div class="fine" id="certHint"></div>
    </div>
    <div id="connInfo" class="conn-info hidden">
      <div class="conn-row"><span>${t("codec")}</span><b id="cMode">–</b></div>
      <div class="conn-row"><span>${t("latency")}</span><b id="cRtt">–</b></div>
    </div>
    <button id="btnRemote" class="text-button">${t("regenCode")}</button>
  </section>

  <section class="card">
    <div class="section-heading"><div><span class="step">2</span><span>${t("stepOutput")}</span></div></div>
    <label class="field"><span>${t("virtualMic")}</span>
      <select id="deviceSelect"><option>${t("loading")}</option></select>
    </label>
    <div class="fine" id="blackholeHint"></div>
    <button id="btnDriver" class="ghost hidden">${t("bhInstallBtn")}</button>
    <div class="setting-row"><span><b>${t("autostartTitle")}</b><small>${t("autostartSub")}</small></span><button id="btnAutostart" class="mini">…</button></div>
    <div class="actions">
      <button id="btnRestart" class="primary">${t("restartSvc")}</button>
      <button id="btnStop" class="secondary">${t("stop")}</button>
    </div>
  </section>

  <section class="card monitor-card">
    <div class="monitor-head"><span>${t("liveInput")}</span><span class="level-caption">MIC LEVEL</span></div>
    <div class="meter" aria-label="${t("meterAria")}"><div id="meterFill"></div><i></i><i></i><i></i></div>
    <div class="grid">
      <div><b id="vRtt">–</b><span>${t("rttLabel")}</span></div>
      <div><b id="vLoss">–</b><span>${t("lossLabel")}</span></div>
      <div><b id="vUnderrun">–</b><span>${t("underrunLabel")}</span></div>
      <div><b id="vBuffer">–</b><span>${t("bufferLabel")}</span></div>
      <div><b id="vFrames">–</b><span>${t("framesLabel")}</span></div>
      <div><b id="vMode">–</b><span>${t("modeLabel")}</span></div>
    </div>
  </section>
  <div class="browser-hint hidden" role="status"></div>
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
let pairHttpsUrl = "";

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function copyText(t: string) {
  navigator.clipboard?.writeText(t).catch(() => {});
}

const QR_ROTATE_SECONDS = 600; // 配对码 10 分钟自动轮换
let qrRotateTimer: ReturnType<typeof setInterval> | null = null;

function startQrCountdown() {
  if (qrRotateTimer) clearInterval(qrRotateTimer);
  let left = QR_ROTATE_SECONDS;
  const tick = () => {
    const m = Math.floor(left / 60);
    const sec = left % 60;
    const time = `${m}:${String(sec).padStart(2, "0")}`;
    $("#qrLabel").textContent = connectedUi ? t("usingMic") : t("qrCountdown", { time });
    if (left <= 0) {
      clearInterval(qrRotateTimer!);
      qrRotateTimer = null;
      void rotateQr();
    }
    left -= 1;
  };
  tick();
  qrRotateTimer = setInterval(tick, 1000);
}

async function rotateQr() {
  if (!isTauri) return;
  try {
    await invoke<string>("reset_remote_pairing");
    qrShown = false;
    await refreshQr();
    renderPairingIdle();
    startQrCountdown();
  } catch (e) {
    console.error("rotate pairing failed", e);
  }
}

async function refreshQr() {
  if (!isTauri || qrLoading) return;
  qrLoading = true;
  try {
    const p = await invoke<PairingInfo>("pairing_qr");
    qrSvgCache = p.qr_svg;
    pairQrUrl = p.qr_url;
    pairSetupUrl = p.setup_url.replace(/#.*$/, "") + "/setup";
    pairHttpsUrl = p.https_url ?? pairSetupUrl;
    qrShown = true;
    if (!connectedUi) renderPairingIdle();
    startQrCountdown();
  } catch (e) {
    const msg = String(e);
    console.error("pairing_qr failed", e);
    // 只在还没成功显示过时占位；错误文案直接可见，便于定位（服务就绪后 500ms 轮询会自动重试）
    if (!qrShown && !connectedUi) {
      $("#qrBox").innerHTML = `<div class="qr-err">${t("qrUnavailable", { msg: msg.slice(0, 90) })}</div>`;
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
  if (!qrRotateTimer) $("#qrLabel").textContent = t("stepPair");
  $("#pairRows").classList.remove("hidden");
  $("#connInfo").classList.add("hidden");
  $("#qrBox").classList.remove("connected");
  $("#setupUrl").title = pairQrUrl || "";
  $("#httpsUrl").textContent = pairHttpsUrl ? t("lanSub") : t("lanPending");
  $("#httpsUrl").title = t("lanTitle");
}

/** 已连接视图：绿色状态面板替代二维码 */
function renderConnected(s: StatsSnapshot) {
  $("#qrBox").classList.add("connected");
  $("#qrBox").innerHTML = `
    <div class="conn-check">✓</div>
    <div class="conn-title">${t("connTitle")}</div>
    <div class="conn-sub">${s.mode === "opus" ? "Opus" : "PCM"} · ${s.rtt_ms != null ? Math.round(s.rtt_ms) + "ms" : "–"}</div>`;
  $("#qrLabel").textContent = t("usingMic");
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
  const def = lastStatus?.has_preferred_device ? t("sysDefaultBh") : t("sysDefault");
  sel.innerHTML =
    `<option value="">${def}</option>` +
    devicesCache.map((d) => `<option ${d === current ? "selected" : ""}>${d}</option>`).join("");
  renderBlackholeHint();
}

/// 平台虚拟麦克风：macOS 内嵌安装 BlackHole；Windows 引导安装 VB-CABLE
const IS_WINDOWS = navigator.userAgent.includes("Windows");
const VIRTUAL_MIC = IS_WINDOWS ? "CABLE" : "BlackHole";

function renderBlackholeHint() {
  const has = devicesCache.some((d) => d.includes(VIRTUAL_MIC));
  const btn = $<HTMLButtonElement>("#btnDriver");
  if (has) {
    $("#blackholeHint").innerHTML = t(IS_WINDOWS ? "bhReadyWin" : "bhReady");
    btn.textContent = t(IS_WINDOWS ? "bhFixBtnWin" : "bhFixBtn");
    btn.classList.remove("hidden");
  } else {
    $("#blackholeHint").innerHTML = t(IS_WINDOWS ? "bhMissingWin" : "bhMissing");
    btn.textContent = t(IS_WINDOWS ? "bhInstallBtnWin" : "bhInstallBtn");
    btn.classList.remove("hidden");
  }
}

function render(st: StatusResponse) {
  lastStatus = st;
  const s = st.stats;
  const pill = s.connected ? t("livePill") : st.running ? t("waitingPill") : t("stoppedPill");
  $("#running").textContent = pill + (s.remote ? t("remoteTag") : "");
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

  $("#certHint").textContent = st.running ? t("certHintRun") : t("certHintStop");

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
  $<HTMLElement>(".browser-hint").classList.remove("hidden");
  $<HTMLElement>(".browser-hint").innerHTML = t("browserHint");
} else {
  invoke<StatusResponse>("get_status").then(render).catch(console.error);
  void listen<StatusResponse>("stats", (e) => render(e.payload));
  void refreshQr();
  void refreshDevices();

  $("#btnRestart").addEventListener("click", async () => {
    $("#btnRestart").textContent = t("restarting");
    try {
      render(await invoke<StatusResponse>("start_server"));
    } catch (e) {
      console.error(e);
    }
    $("#btnRestart").textContent = t("restartSvc");
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
      alert(t("deviceFail", { msg: String(err) }));
    }
  });
  $("#btnRemote").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("#btnRemote");
    btn.disabled = true;
    try {
      await invoke<string>("reset_remote_pairing");
      qrShown = false;
      connectedUi = false;
      await refreshQr();
      renderPairingIdle();
    } catch (e) {
      console.error(e);
      alert(t("resetFail", { msg: String(e) }));
    }
    btn.disabled = false;
  });
  (async () => {
    const btn = $<HTMLButtonElement>("#btnAutostart");
    const render = async () => {
      try {
        btn.textContent = (await isEnabled()) ? t("autoOn") : t("autoOff");
      } catch {
        btn.textContent = t("autoNA");
        btn.disabled = true;
      }
    };
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        if (await isEnabled()) await disable();
        else await enable();
      } catch (e) {
        console.error(e);
      }
      await render();
      btn.disabled = false;
    });
    await render();
  })();
  $("#btnDriver").addEventListener("click", async () => {
    const btn = $<HTMLButtonElement>("#btnDriver");
    btn.disabled = true;
    btn.textContent = t(IS_WINDOWS ? "installingWin" : "installing");
    try {
      const msg = await invoke<string>("install_driver");
      console.log("install_driver:", msg);
    } catch (e) {
      alert(t("driverFail", { msg: String(e) }));
    }
    btn.disabled = false;
    await refreshDevices();
  });
  $("#setupUrl").addEventListener("click", (e) => {
    copyText(pairQrUrl);
    const label = $<HTMLElement>(".copy-label");
    label.textContent = t("copied");
    setTimeout(() => (label.textContent = t("copy")), 1200);
  });
}
