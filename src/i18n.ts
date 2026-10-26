// 桌面端 i18n：中英双语字典。语言判定与手机页一致（navigator.language），
// 另支持 ?lang=en/zh 显式覆盖（测试与手动切换用）。
export type Lang = "zh" | "en";

function detectLang(): Lang {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "en" || q === "zh") return q;
  return (navigator.language || "zh").toLowerCase().startsWith("zh") ? "zh" : "en";
}

export const lang: Lang = detectLang();

type Entry = { zh: string; en: string };

const STR: Record<string, Entry> = {
  subtitle: { zh: "把手机变成电脑麦克风", en: "Your phone as a PC microphone" },
  checking: { zh: "检查中", en: "Checking…" },
  stepPair: { zh: "手机扫码配对", en: "Scan to pair" },
  e2ee: { zh: "端到端加密", en: "End-to-end encrypted" },
  copyLinkTitle: { zh: "点击复制配对链接", en: "Click to copy pairing link" },
  anyNetwork: { zh: "任意网络", en: "Any network" },
  anyNetworkSub: { zh: "加密中继，扫码即连", en: "Encrypted relay — works anywhere" },
  copy: { zh: "复制", en: "Copy" },
  copied: { zh: "已复制", en: "Copied" },
  sameNetwork: { zh: "同一网络", en: "Same network" },
  lanSub: { zh: "自动切换低延迟直连", en: "Auto-switches to direct link" },
  faster: { zh: "更快", en: "Faster" },
  codec: { zh: "编码", en: "Codec" },
  latency: { zh: "延迟", en: "Latency" },
  regenCode: { zh: "重新生成配对码", en: "Regenerate pairing code" },
  stepOutput: { zh: "设置输出", en: "Output setup" },
  virtualMic: { zh: "虚拟麦克风", en: "Virtual microphone" },
  loading: { zh: "加载中…", en: "Loading…" },
  autostartTitle: { zh: "开机自动启动", en: "Launch at login" },
  autostartSub: { zh: "随时等待手机连接", en: "Always ready for your phone" },
  restartSvc: { zh: "重启连接服务", en: "Restart service" },
  stop: { zh: "停止", en: "Stop" },
  liveInput: { zh: "实时输入", en: "Live input" },
  meterAria: { zh: "麦克风输入电平", en: "Microphone input level" },
  rttLabel: { zh: "往返延迟", en: "Latency" },
  lossLabel: { zh: "丢帧", en: "Lost" },
  underrunLabel: { zh: "下溢", en: "Underruns" },
  bufferLabel: { zh: "缓冲", en: "Buffer" },
  framesLabel: { zh: "已收帧", en: "Frames" },
  modeLabel: { zh: "编码", en: "Codec" },
  usingMic: { zh: "正在使用手机麦克风", en: "Using your phone as mic" },
  qrCountdown: {
    zh: "手机扫码配对（{time} 后更新）",
    en: "Scan to pair (updates in {time})",
  },
  qrUnavailable: { zh: "二维码暂不可用：<br>{msg}", en: "QR unavailable:<br>{msg}" },
  lanPending: { zh: "直连地址准备中", en: "Preparing direct link…" },
  lanTitle: {
    zh: "同一网络下手机自动切换到直连（需信任过证书），延迟更低",
    en: "On the same network the phone switches to a direct link (requires a trusted certificate) for lower latency",
  },
  connTitle: { zh: "手机已连接", en: "Phone connected" },
  sysDefault: { zh: "系统默认", en: "System default" },
  sysDefaultBh: { zh: "系统默认（含 BlackHole 自动选择）", en: "System default (auto-picks BlackHole)" },
  bhReady: {
    zh: "✅ 虚拟麦克风就绪 —— 电脑应用选择 <b>BlackHole 2ch</b> 即可",
    en: "✅ Virtual mic ready — pick <b>BlackHole 2ch</b> in your apps",
  },
  bhReadyWin: {
    zh: "✅ 虚拟麦克风就绪 —— 电脑应用选择 <b>CABLE Input</b> 即可",
    en: "✅ Virtual mic ready — pick <b>CABLE Input</b> in your apps",
  },
  bhMissingWin: {
    zh: "尚未安装虚拟麦克风（VB-CABLE），点击下方按钮打开官网下载",
    en: "Virtual microphone (VB-CABLE) not installed — use the button below to open the download page",
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
  bhMissing: { zh: "尚未安装虚拟麦克风，点击下方按钮一键安装", en: "Virtual microphone not installed yet — use the button below" },
  bhInstallBtn: { zh: "一键安装虚拟麦克风驱动（需输一次密码）", en: "Install virtual mic driver (one password prompt)" },
  livePill: { zh: "直播中", en: "LIVE" },
  waitingPill: { zh: "等待手机", en: "Waiting" },
  stoppedPill: { zh: "已停止", en: "Stopped" },
  remoteTag: { zh: " ·远程", en: " · relay" },
  certHintRun: {
    zh: "配对码每 10 分钟自动更新，已连接设备不受影响",
    en: "Pairing code rotates every 10 min; connected devices are unaffected",
  },
  certHintStop: { zh: "连接服务已停止，请先重新启动", en: "Service stopped — restart to continue" },
  browserHint: {
    zh: "当前页面在浏览器中打开——桌面 UI 需要 Tauri App 运行（<code>npm run tauri:dev</code>）。",
    en: "This page is open in a browser — the desktop UI requires the Tauri app (<code>npm run tauri:dev</code>).",
  },
  restarting: { zh: "重启中…", en: "Restarting…" },
  deviceFail: { zh: "切换输出设备失败: {msg}", en: "Failed to switch output device: {msg}" },
  resetFail: { zh: "重置配对码失败: {msg}", en: "Failed to reset pairing code: {msg}" },
  autoOn: { zh: "已开启 ✓（点击关闭）", en: "On ✓ (click to disable)" },
  autoOff: { zh: "未开启（点击启用）", en: "Off (click to enable)" },
  autoNA: { zh: "不可用", en: "Unavailable" },
  installing: {
    zh: "安装中…（请在系统弹窗输入密码）",
    en: "Installing… (enter password in the system prompt)",
  },
  installingWin: {
    zh: "下载安装中…请在 UAC 系统弹窗点“是”授权一次",
    en: "Downloading & installing… click Yes on the system UAC prompt",
  },
  driverFail: { zh: "驱动安装未完成：{msg}", en: "Driver installation incomplete: {msg}" },
};

export function t(key: string, params?: Record<string, string | number>): string {
  const entry = STR[key];
  let s = entry ? entry[lang] : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}
