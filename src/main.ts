// PhoneMic 桌面端 UI：配对二维码、服务状态、设备选择、实时统计。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { lang, storeLang, t } from "./i18n";
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
const IS_WINDOWS = navigator.userAgent.includes("Windows");
// macOS 用 Overlay 标题栏，红绿灯会浮在内容左上角，需要给顶部留出安全带
const IS_MAC = navigator.userAgent.includes("Mac");
if (IS_MAC) document.body.classList.add("is-macos");

app.innerHTML = `
  <header class="app-header" data-drag>
    <div class="brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 15.5a4 4 0 0 0 4-4v-5a4 4 0 1 0-8 0v5a4 4 0 0 0 4 4Z"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6"/></svg></div>
    <div class="title-group"><div class="title">PhoneMic</div><div class="subtitle">${t("subtitle")}</div></div>
    <span id="running" class="pill off">${t("checking")}</span>
  </header>

  <section class="card pairing-card" id="qrCard">
    <div class="qr-stage"><div id="qrBox" class="qrbox"><div class="qr-skeleton"></div></div></div>
    <div class="qr-actions" id="qrActions">
      <button id="setupUrl" class="icon-btn" type="button" title="${t("copyLinkTitle")}" aria-label="${t("copyLink")}"><svg class="ib" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/><rect x="4" y="4" width="11" height="11" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
      <button id="btnRemote" class="icon-btn" type="button" title="${t("regenCode")}" aria-label="${t("regenCode")}"><svg class="ib" viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.47-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M21 3.5V9h-5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
    </div>
    <div class="scan-hint" id="scanHint">${t("scanHint")}</div>
    <div id="driverBanner" class="driver-banner hidden">
      <div class="db-text"><b>${t("driverMissing")}</b><small id="driverBannerSub">${t(IS_WINDOWS ? "driverGuideWin" : "driverGuideMac")}</small></div>
      <button class="db-btn js-install-driver" type="button">${t("installNow")}</button>
    </div>
    <div id="connInfo" class="conn-info hidden">
      <div class="conn-row"><span>${t("codec")}</span><b id="cMode">–</b></div>
      <div class="conn-row"><span>${t("latency")}</span><b id="cRtt">–</b></div>
    </div>
  </section>

  <section class="view-settings hidden" id="viewSettings">
    <div class="settings-bar" data-drag>
      <button id="btnBack" class="icon-btn back" type="button" title="${t("back")}" aria-label="${t("back")}">
        <svg class="ib" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <span>${t("settings")}</span>
    </div>
    <div class="card settings-card">
      <label class="field"><span>${t("virtualMic")}</span>
        <select id="deviceSelect"><option>${t("loading")}</option></select>
      </label>
      <div class="fine" id="blackholeHint"></div>
      <button id="btnDriver" class="ghost hidden js-install-driver">${t("bhInstallBtn")}</button>
      <div class="actions">
        <button id="btnRestart" class="primary">${t("restartSvc")}</button>
        <button id="btnStop" class="secondary">${t("stop")}</button>
      </div>
      <div class="adv-monitor monitor-card">
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
      </div>
    </div>
  </section>
  <div class="browser-hint hidden" role="status"></div>
`;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const isTauri = "__TAURI_INTERNALS__" in window;
if (isTauri) document.documentElement.classList.add("tauri");

/**
 * 窗口拖动：直接调 startDragging()，不依赖内置 drag.js 的隐式行为。
 * 顶部标题条 / header / 设置页顶栏都带 data-drag，双击切最大化。
 */
if (isTauri) {
  const win = getCurrentWindow();
  let lastDown = 0;
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (!target?.closest("[data-drag]")) return;
    // 可交互控件不参与拖动
    if (target.closest("button, a, input, select, textarea")) return;
    e.preventDefault();
    const now = Date.now();
    if (now - lastDown < 350) {
      lastDown = 0;
      void win.toggleMaximize().catch(() => {});
      return;
    }
    lastDown = now;
    void win.startDragging().catch((err) => {
      console.warn("窗口拖动失败：", err);
      // 真机上没法开控制台时，把原因显示在界面上，便于反馈
      const hint = document.querySelector<HTMLElement>(".browser-hint");
      if (hint) {
        hint.textContent = `窗口拖动不可用：${String(err)}`;
        hint.classList.remove("hidden");
      }
    });
  });
}
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

/** 主界面 ⇄ 设置页切换（设置页入口在托盘菜单「设置…」） */
function showView(view: "main" | "settings") {
  $("#qrCard").classList.toggle("hidden", view === "settings");
  $("#viewSettings").classList.toggle("hidden", view !== "settings");
  $("#app").scrollTop = 0;
}

const QR_ROTATE_SECONDS = 600; // 配对码 10 分钟自动轮换
let qrRotateTimer: ReturnType<typeof setInterval> | null = null;

function startQrCountdown() {
  if (qrRotateTimer) clearInterval(qrRotateTimer);
  let left = QR_ROTATE_SECONDS;
  const tick = () => {
    // 未连接时在提示小字里显示剩余有效期，让用户知道码会过期
    if (!connectedUi) {
      const m = Math.floor(Math.max(left, 0) / 60);
      const sec = Math.max(left, 0) % 60;
      $("#scanHint").textContent = t("scanHintRotate", { time: `${m}:${String(sec).padStart(2, "0")}` });
    }
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
  $("#qrActions").classList.remove("hidden");
  $("#scanHint").classList.remove("hidden");
  $("#connInfo").classList.add("hidden");
  $("#qrBox").classList.remove("connected");
  $("#setupUrl").title = pairQrUrl || "";
}

/** 已连接视图：绿色状态面板替代二维码 */
function renderConnected(s: StatsSnapshot) {
  $("#qrBox").classList.add("connected");
  $("#qrBox").innerHTML = `
    <div class="conn-check">✓</div>
    <div class="conn-title">${t("connTitle")}</div>
    <div class="conn-sub">${s.mode === "opus" ? "Opus" : "PCM"} · ${s.rtt_ms != null ? Math.round(s.rtt_ms) + "ms" : "–"}</div>`;
  $("#qrActions").classList.add("hidden");
  $("#scanHint").classList.add("hidden");
  $("#cMode").textContent = s.mode === "opus" ? "Opus 48kHz" : "PCM 48kHz";
  $("#cRtt").textContent = s.rtt_ms != null ? `${Math.round(s.rtt_ms)} ms` : "–";
  $("#connInfo").classList.remove("hidden");
}

async function refreshDevices() {
  if (!isTauri) return;
  const all = await invoke<string[]>("output_devices");
  // 只展示虚拟麦克风设备，不列出真实扬声器/耳机，避免误选导致外放啸叫
  devicesCache = all.filter((d) => d.includes(VIRTUAL_MIC));
  const sel = $<HTMLSelectElement>("#deviceSelect");
  const current = lastStatus?.output_device;
  if (devicesCache.length === 0) {
    sel.innerHTML = `<option value="">${t("noVirtualMic")}</option>`;
  } else {
    sel.innerHTML = devicesCache
      .map((d) => `<option ${d === current ? "selected" : ""}>${d}</option>`)
      .join("");
  }
  renderBlackholeHint();
}

/// 平台虚拟麦克风：macOS 内嵌安装 BlackHole；Windows 引导安装 VB-CABLE
const VIRTUAL_MIC = IS_WINDOWS ? "CABLE" : "BlackHole";

function renderBlackholeHint() {
  const has = devicesCache.some((d) => d.includes(VIRTUAL_MIC));
  const btn = $<HTMLButtonElement>("#btnDriver");
  if (has) {
    $("#blackholeHint").innerHTML = t(IS_WINDOWS ? "bhReadyWin" : "bhReady");
    btn.textContent = t(IS_WINDOWS ? "bhFixBtnWin" : "bhFixBtn");
    btn.classList.remove("hidden");
    $("#driverBanner").classList.add("hidden");
  } else {
    $("#blackholeHint").innerHTML = t(IS_WINDOWS ? "bhMissingWin" : "bhMissing");
    // 设置页里也保留安装入口，用户从托盘直接进来也能修
    btn.textContent = t(IS_WINDOWS ? "bhInstallBtnWin" : "bhInstallBtn");
    btn.classList.remove("hidden");
    $("#driverBanner").classList.remove("hidden");
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
  if (devicesCache.length === 0 && st.running) void refreshDevices();
}

if (!isTauri) {
  $<HTMLElement>(".browser-hint").classList.remove("hidden");
  $<HTMLElement>(".browser-hint").innerHTML = t("browserHint");
} else {
  invoke<StatusResponse>("get_status").then(render).catch(console.error);
  void listen<StatusResponse>("stats", (e) => render(e.payload));
  void refreshQr();
  void refreshDevices();

  // 设置页入口在托盘菜单「设置…」：后端会先显示窗口，再发这个事件
  void listen("open-settings", () => showView("settings"));
  void listen("open-main", () => showView("main"));
  $("#btnBack").addEventListener("click", () => showView("main"));

  // 语言：启动时把界面的解析结果同步给后端（托盘文案随之对齐）；
  // 托盘里切换语言 → 记住选择并重载页面，让整页按新语言重绘
  void invoke("set_ui_lang", { lang }).catch(console.error);
  void listen<string>("lang-changed", (e) => {
    if (e.payload === lang) return;
    storeLang(e.payload === "zh" ? "zh" : "en");
    location.reload();
  });

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
  document.querySelectorAll<HTMLButtonElement>(".js-install-driver").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = t(IS_WINDOWS ? "installingWin" : "installing");
      try {
        const msg = await invoke<string>("install_driver");
        await refreshDevices(); // 刷新后横幅按检测结果自动显示/隐藏
        if (!$("#driverBanner").classList.contains("hidden")) {
          // 仍未检测到（Windows 常需重启才挂接）→ 把后端给出的处理指引显示出来
          $("#driverBannerSub").textContent = msg;
          $("#blackholeHint").textContent = msg; // 设置页同样能看到指引
          $<HTMLButtonElement>(".db-btn").textContent = t("installNow");
        }
      } catch (e) {
        alert(t("driverFail", { msg: String(e) }));
      }
      btn.disabled = false;
    })
  );
  $("#setupUrl").addEventListener("click", () => {
    copyText(pairQrUrl);
    const btn = $<HTMLButtonElement>("#setupUrl");
    const restoreHtml = btn.innerHTML;
    const restoreTitle = btn.title;
    btn.innerHTML = '<svg class="ib" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    btn.title = t("copied");
    setTimeout(() => { btn.innerHTML = restoreHtml; btn.title = restoreTitle; }, 1200);
  });
}
