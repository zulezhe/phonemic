// 桌面端 i18n：中英双语字典。
// 语言判定优先级：?lang=en/zh（临时覆盖） > localStorage 记住的选择 > 系统/浏览器语言。
// 托盘菜单切换语言时会写入 localStorage 并重载页面，因此两边始终一致。
export type Lang = "zh" | "en";

const LANG_KEY = "pm_lang";

function detectLang(): Lang {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "en" || q === "zh") return q;
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "en" || saved === "zh") return saved;
  } catch {
    /* localStorage 不可用时退回系统语言 */
  }
  return (navigator.language || "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** 记住语言选择（托盘切换后重载页面时据此恢复） */
export function storeLang(l: Lang) {
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    /* 忽略存储失败 */
  }
}

export const lang: Lang = detectLang();

type Entry = { zh: string; en: string };

const STR = {
  subtitle: { zh: "把手机变成电脑麦克风", en: "Your phone as a PC microphone" },
  checking: { zh: "检查中", en: "Checking…" },
  e2ee: { zh: "端到端加密", en: "End-to-end encrypted" },
  copyLinkTitle: { zh: "点击复制配对链接", en: "Click to copy pairing link" },
  copied: { zh: "已复制", en: "Copied" },
  copyLink: { zh: "复制配对链接", en: "Copy pairing link" },
  codec: { zh: "编码", en: "Codec" },
  latency: { zh: "延迟", en: "Latency" },
  regenCode: { zh: "重新生成配对码", en: "Regenerate pairing code" },
  virtualMic: { zh: "虚拟麦克风", en: "Virtual microphone" },
  loading: { zh: "加载中…", en: "Loading…" },
  noVirtualMic: { zh: "未检测到虚拟麦克风", en: "No virtual microphone detected" },
  restartSvc: { zh: "重启连接服务", en: "Restart service" },
  stop: { zh: "停止", en: "Stop" },
  scanHint: { zh: "手机扫码即可连接 · 端到端加密", en: "Scan to connect · End-to-end encrypted" },
  scanHintRotate: { zh: "手机扫码即可连接 · 端到端加密 · 码 {time} 后更新", en: "Scan to connect · End-to-end encrypted · refreshes in {time}" },
  settings: { zh: "设置", en: "Settings" },
  back: { zh: "返回", en: "Back" },
  driverMissing: { zh: "缺少虚拟麦克风驱动", en: "Virtual mic driver missing" },
  driverGuideMac: { zh: "一键安装 BlackHole（官方内嵌包，需输入一次密码）", en: "One-click install BlackHole (one password prompt)" },
  driverGuideWin: { zh: "一键安装 VB-CABLE（自动下载官方安装包，需在系统弹窗中授权一次）", en: "One-click install VB-CABLE (auto-download, one UAC prompt)" },
  installNow: { zh: "一键安装", en: "Install" },
  liveInput: { zh: "实时输入", en: "Live input" },
  meterAria: { zh: "麦克风输入电平", en: "Microphone input level" },
  rttLabel: { zh: "往返延迟", en: "Latency" },
  lossLabel: { zh: "丢帧", en: "Lost" },
  underrunLabel: { zh: "下溢", en: "Underruns" },
  bufferLabel: { zh: "缓冲", en: "Buffer" },
  framesLabel: { zh: "已收帧", en: "Frames" },
  modeLabel: { zh: "编码", en: "Codec" },
  qrUnavailable: { zh: "二维码暂不可用：<br>{msg}", en: "QR unavailable:<br>{msg}" },
  connTitle: { zh: "手机已连接", en: "Phone connected" },
  bhReady: {
    zh: "✅ 虚拟麦克风就绪 —— 电脑应用选择 <b>BlackHole 2ch</b> 即可",
    en: "✅ Virtual mic ready — pick <b>BlackHole 2ch</b> in your apps",
  },
  bhReadyWin: {
    zh: "✅ 虚拟麦克风就绪 —— 电脑应用选择 <b>CABLE Input</b> 即可",
    en: "✅ Virtual mic ready — pick <b>CABLE Input</b> in your apps",
  },
  bhMissingWin: {
    zh: "尚未安装虚拟麦克风（VB-CABLE）——用二维码下方的一键安装即可",
    en: "Virtual microphone (VB-CABLE) not installed — use one-click install below the QR code",
  },
  bhInstallBtnWin: {
    zh: "一键安装虚拟麦克风驱动（自动下载 VB-CABLE）",
    en: "Install virtual mic driver (auto-downloads VB-CABLE)",
  },
  bhFixBtnWin: {
    zh: "重新检测 / 挂接 CABLE Input",
    en: "Re-detect / attach CABLE Input",
  },
  bhFixBtn: { zh: "修复驱动（重装 + 重启音频服务）", en: "Repair driver (reinstall + restart audio)" },
  bhMissing: { zh: "尚未安装虚拟麦克风——用二维码下方的一键安装即可", en: "Virtual microphone not installed — use one-click install below the QR code" },
  bhInstallBtn: { zh: "一键安装虚拟麦克风驱动（需输一次密码）", en: "Install virtual mic driver (one password prompt)" },
  livePill: { zh: "直播中", en: "LIVE" },
  waitingPill: { zh: "等待手机", en: "Waiting" },
  stoppedPill: { zh: "已停止", en: "Stopped" },
  remoteTag: { zh: " ·远程", en: " · relay" },
  browserHint: {
    zh: "当前页面在浏览器中打开——桌面 UI 需要 Tauri App 运行（<code>npm run tauri:dev</code>）。",
    en: "This page is open in a browser — the desktop UI requires the Tauri app (<code>npm run tauri:dev</code>).",
  },
  restarting: { zh: "重启中…", en: "Restarting…" },
  deviceFail: { zh: "切换输出设备失败: {msg}", en: "Failed to switch output device: {msg}" },
  resetFail: { zh: "重置配对码失败: {msg}", en: "Failed to reset pairing code: {msg}" },
  installing: {
    zh: "安装中…（请在系统弹窗输入密码）",
    en: "Installing… (enter password in the system prompt)",
  },
  installingWin: {
    zh: "下载安装中…请在 UAC 系统弹窗点“是”授权一次",
    en: "Downloading & installing… click Yes on the system UAC prompt",
  },
  driverFail: { zh: "驱动安装未完成：{msg}", en: "Driver installation incomplete: {msg}" },
} satisfies Record<string, Entry>;

/** 所有合法词条名（从字典推导，新增/删除词条自动同步，写错 key 编译期报错） */
export type StrKey = keyof typeof STR;

export function t(key: StrKey, params?: Record<string, string | number>): string {
  let s: string = STR[key][lang];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}
