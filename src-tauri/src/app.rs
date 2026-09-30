//! Tauri 桌面应用：窗口 UI、命令与状态事件。
//! 共享状态放全局 OnceLock（不依赖 Tauri State 注入），命令零参数化，
//! 所有运行方式（tauri dev / dev:app 签名包 / phonemic-server bin）共用同一数据目录。

use crate::audio::{list_output_devices, start_output, AudioFifo, OutputEngine};
use crate::relay;
use crate::server::{self, lan_ip, ServerConfig, MDNS_HOST};
use crate::state::{Stats, StatsSnapshot};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::Emitter;

const HTTP_PORT: u16 = 9420;
const HTTPS_PORT: u16 = 9421;
/// BlackHole 设备名匹配片段；存在则自动作为输出
/// 首选虚拟麦克风设备名片段：macOS 内嵌安装 BlackHole（MIT 可再分发）；
/// Windows 用 VB-CABLE（禁止再分发，只能引导用户去官网安装）
#[cfg(target_os = "macos")]
const PREFERRED_DEVICE: &str = "BlackHole";
#[cfg(not(target_os = "macos"))]
const PREFERRED_DEVICE: &str = "CABLE";

pub struct AppCtx {
    server: Mutex<Option<server::ServerHandle>>,
    engine: Mutex<Option<OutputEngine>>,
    /// None = 系统默认输出设备
    desired_device: Mutex<Option<String>>,
    pub stats: Arc<Stats>,
    pub fifo: Arc<AudioFifo>,
}

static CTX: OnceLock<AppCtx> = OnceLock::new();
static TRAY_STATUS: OnceLock<tauri::menu::MenuItem<tauri::Wry>> = OnceLock::new();

// ---- 桌面端 UI 语言（托盘/引导页文案）----
fn ui_zh() -> bool {
    sys_locale::get_locale().map(|l| l.to_lowercase().starts_with("zh")).unwrap_or(false)
}
fn tray_str(zh: &str, en: &str) -> String {
    if ui_zh() { zh.to_string() } else { en.to_string() }
}


fn ctx() -> &'static AppCtx {
    CTX.get().expect("AppCtx 未初始化")
}

/// 统一数据目录；若旧的 identifier 目录存在则迁移过来（保留已信任的 CA/token）
pub(crate) fn data_dir() -> PathBuf {
    let base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("phonemic");
    let old = base.join("dev.phonemic.desktop");
    if old.is_dir() && !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
        for f in ["ca.pem", "ca.key", "server.pem", "server.key", "sans.txt", "token.txt"] {
            let _ = std::fs::rename(old.join(f), dir.join(f));
        }
        tracing::info!("已迁移数据目录: {} -> {}", old.display(), dir.display());
    }
    dir
}

#[derive(Serialize, Clone, Debug)]
pub struct StatusResponse {
    pub running: bool,
    pub port: u16,
    pub https_port: Option<u16>,
    pub lan_ip: Option<String>,
    pub token: Option<String>,
    pub setup_url: Option<String>,
    pub https_url: Option<String>,
    pub output_device: Option<String>,
    pub output_rate: Option<u32>,
    pub has_preferred_device: bool,
    pub mdns_host: Option<String>,
    pub stats: StatsSnapshot,
}

fn status_response(state: &AppCtx) -> StatusResponse {
    let server = state.server.lock();
    let engine = state.engine.lock();
    let ip = server.as_ref().and_then(|_| lan_ip()).map(|i| i.to_string());
    let setup_url = match (&ip, server.as_ref()) {
        (Some(ip), Some(h)) => Some(format!("http://{ip}:{}/setup#token={}", h.port, h.token)),
        _ => None,
    };
    let https_url = match (&ip, server.as_ref()) {
        (Some(ip), Some(h)) => h.https_port.map(|p| format!("https://{ip}:{p}/#token={}", h.token)),
        _ => None,
    };
    StatusResponse {
        running: server.is_some(),
        port: server.as_ref().map(|s| s.port).unwrap_or(0),
        https_port: server.as_ref().and_then(|s| s.https_port),
        lan_ip: ip,
        token: server.as_ref().map(|s| s.token.clone()),
        setup_url,
        https_url,
        output_device: engine.as_ref().map(|e| e.device_name.clone()),
        output_rate: engine.as_ref().map(|e| e.sample_rate),
        has_preferred_device: list_output_devices().iter().any(|d| d.contains(PREFERRED_DEVICE)),
        mdns_host: server.as_ref().map(|_| MDNS_HOST.to_string()),
        stats: state.stats.snapshot(),
    }
}

async fn do_start() -> anyhow::Result<()> {
    let state = ctx();
    if let Some(old) = state.server.lock().take() {
        let _ = old.shutdown.send(true);
    }
    // 输出引擎：优先 BlackHole（装了就是要用它做虚拟麦克风）
    if state.engine.lock().is_none() {
        let desired = state.desired_device.lock().clone();
        let chosen =
            desired.or_else(|| list_output_devices().into_iter().find(|d| d.contains(PREFERRED_DEVICE)));
        let engine = start_output(chosen.as_deref(), state.fifo.clone())?;
        *state.engine.lock() = Some(engine);
    }
    let cfg = ServerConfig {
        host: "0.0.0.0".into(),
        port: HTTP_PORT,
        https_port: HTTPS_PORT,
        data_dir: Some(data_dir()),
        lan_ip: lan_ip(),
        dev_no_token: cfg_dev(),
    };
    // 旧服务的优雅关闭可能让端口迟滞几百毫秒，重试遮蔽 AddrInUse
    let mut last_err = None;
    for i in 0..3 {
        match server::start_server(cfg.clone(), state.stats.clone(), state.fifo.clone()).await {
            Ok(handle) => {
                register_mdns(handle.https_port.is_some());
                *state.server.lock() = Some(handle);
                tracing::info!("服务启动完成（第 {} 次尝试）", i + 1);
                return Ok(());
            }
            Err(e) => {
                tracing::warn!("服务启动失败（第 {} 次）: {e:#}", i + 1);
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("未知启动错误")))
}

fn do_stop() {
    let state = ctx();
    if let Some(old) = state.server.lock().take() {
        let _ = old.shutdown.send(true);
        state.stats.reset_session();
        state.fifo.flush();
    }
}

fn cfg_dev() -> bool {
    std::env::var("PHONEMIC_DEV").map(|v| v == "1").unwrap_or(false)
}

static MDNS: OnceLock<Option<mdns_sd::ServiceDaemon>> = OnceLock::new();

fn register_mdns(enabled: bool) {
    if !enabled {
        return;
    }
    let _ = MDNS.get_or_init(|| {
        let Some(host_ip) = lan_ip() else {
            tracing::warn!("无局域网 IP，跳过 mDNS");
            return None;
        };
        let daemon = match mdns_sd::ServiceDaemon::new() {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!("mDNS 启动失败（不影响使用）: {e}");
                return None;
            }
        };
        let info = match mdns_sd::ServiceInfo::new(
            "_phonemic._tcp.local.",
            "phonemic",
            // mdns-sd 要求主机名为带尾点的 FQDN；证书 SAN 用不带尾点的形式
            "phonemic.local.",
            host_ip,
            HTTPS_PORT,
            None::<HashMap<String, String>>,
        ) {
            Ok(i) => i,
            Err(e) => {
                tracing::warn!("mDNS 注册构造失败: {e}");
                return None;
            }
        };
        if let Err(e) = daemon.register(info) {
            tracing::warn!("mDNS 注册失败: {e}");
            return None;
        }
        tracing::info!("mDNS: {MDNS_HOST}:{HTTPS_PORT}");
        Some(daemon)
    });
}

#[tauri::command]
fn get_status() -> StatusResponse {
    status_response(ctx())
}

#[tauri::command]
async fn start_server() -> Result<StatusResponse, String> {
    do_start().await.map_err(|e| format!("{e:#}"))?;
    Ok(status_response(ctx()))
}

#[tauri::command]
fn stop_server() -> StatusResponse {
    do_stop();
    status_response(ctx())
}

#[tauri::command]
fn output_devices() -> Vec<String> {
    list_output_devices()
}

/// 切换输出设备；None 恢复系统默认（若装了 BlackHole 仍会自动选中它）
#[tauri::command]
async fn set_output_device(name: Option<String>) -> Result<StatusResponse, String> {
    {
        let state = ctx();
        *state.desired_device.lock() = name.clone();
        // 重建引擎
        let mut engine_guard = state.engine.lock();
        *engine_guard = None; // drop 旧流
        drop(engine_guard);
    }
    let chosen = name.or_else(|| list_output_devices().into_iter().find(|d| d.contains(PREFERRED_DEVICE)));
    let engine = start_output(chosen.as_deref(), ctx().fifo.clone()).map_err(|e| format!("{e:#}"))?;
    *ctx().engine.lock() = Some(engine);
    Ok(status_response(ctx()))
}

/// 配对信息：二维码内容 + URL
#[derive(Serialize)]
struct PairingInfo {
    /// 二维码指向的 URL（优先 HTTPS 直连）
    qr_url: String,
    setup_url: String,
    https_url: Option<String>,
    qr_svg: String,
}

#[tauri::command]
fn pairing_qr() -> Result<PairingInfo, String> {
    let st = status_response(ctx());
    if !st.running {
        // 服务未就绪（启动竞态）：报错让 UI 的 500ms 重试继续
        return Err("服务未运行".into());
    }
    // 云端二维码附带局域网候选与本地 token：手机页用于"赛马"探测直连（P3d）
    let extra = match (&st.lan_ip, st.https_port) {
        (Some(ip), Some(hp)) => match st.token {
            Some(ref t) => format!("&l={ip}:{hp}&t={t}"),
            None => String::new(),
        },
        _ => String::new(),
    };
    let qr_url = relay::ensure_remote_pairing(ctx().stats.clone(), ctx().fifo.clone(), &extra)
        .map_err(|e| format!("{e:#}"))?;
    let setup_url = st.setup_url.clone().ok_or("服务未运行")?;
    let qr = qrcode::QrCode::new(qr_url.as_bytes()).map_err(|e| format!("{e}"))?;
    let qr_svg = qr
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(260, 260)
        .dark_color(qrcode::render::svg::Color("#0f1218"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    tracing::info!("pairing_qr: {qr_url}");
    Ok(PairingInfo { qr_url, setup_url, https_url: st.https_url.clone(), qr_svg })
}

static LOG_GUARD: OnceLock<tracing_appender::non_blocking::WorkerGuard> = OnceLock::new();

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::BH_PKG;

    /// 内嵌的 BlackHole 安装包必须是有效的 XAR 格式（pkg 容器魔数 "xar!"）
    #[test]
    fn embedded_blackhole_pkg_valid() {
        assert!(BH_PKG.len() > 90_000, "pkg 过小: {}", BH_PKG.len());
        assert_eq!(&BH_PKG[..4], b"xar!", "pkg 魔数不符");
    }
}

/// 远程配对：生成一次性配对码并连入中继房间，返回云端配对 URL + 二维码
#[derive(Serialize)]
struct RemotePairing {
    url: String,
    qr_svg: String,
}

#[tauri::command]
fn remote_pairing() -> Result<RemotePairing, String> {
    let state = ctx();
    let url = relay::ensure_remote_pairing(state.stats.clone(), state.fifo.clone(), "")
        .map_err(|e| format!("{e:#}"))?;
    let qr = qrcode::QrCode::new(url.as_bytes()).map_err(|e| format!("{e}"))?;
    let qr_svg = qr
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(260, 260)
        .dark_color(qrcode::render::svg::Color("#0f1218"))
        .light_color(qrcode::render::svg::Color("#ffffff"))
        .build();
    tracing::info!("远程配对已发起: {url}");
    Ok(RemotePairing { url, qr_svg })
}

/// 轮换远程配对码（旧二维码立即失效）
#[tauri::command]
fn reset_remote_pairing() -> Result<String, String> {
    relay::reset_remote_pairing().map_err(|e| format!("{e:#}"))
}

/// BlackHole 官方安装包（MIT，允许再分发，附 resources/BLACKHOLE-LICENSE）
#[cfg(target_os = "macos")]
const BH_PKG: &[u8] = include_bytes!("../resources/BlackHole2ch-0.7.1.pkg");

/// 平台分发：macOS 一键安装内嵌驱动；Windows 引导安装 VB-CABLE（禁止再分发）
#[tauri::command]
async fn install_driver() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    return install_driver_macos().await;
    #[cfg(not(target_os = "macos"))]
    return install_driver_windows().await;
}

/// 已安装时（重新）挂接首选设备，返回设备名
async fn reattach_preferred() -> Result<String, String> {
    {
        let mut guard = ctx().engine.lock();
        *guard = None; // drop 旧流
    }
    let chosen = list_output_devices().into_iter().find(|d| d.contains(PREFERRED_DEVICE));
    match start_output(chosen.as_deref(), ctx().fifo.clone()) {
        Ok(engine) => {
            let name = engine.device_name.clone();
            *ctx().engine.lock() = Some(engine);
            tracing::info!("输出引擎已重建: {name}");
            Ok(name)
        }
        Err(e) => Err(format!("重建输出失败: {e:#}")),
    }
}

/// Windows：检测 VB-CABLE → 已装则挂接，未装则打开官网下载页
/// （VB-CABLE 许可禁止再分发，不能像 macOS 那样内嵌安装）
#[cfg(not(target_os = "macos"))]
async fn install_driver_windows() -> Result<String, String> {
    if list_output_devices().iter().any(|d| d.contains(PREFERRED_DEVICE)) {
        let name = reattach_preferred().await?;
        return Ok(format!("VB-CABLE 已就绪，输出设备: {name}"));
    }
    let url = "https://vb-audio.com/Cable/";
    let open = tokio::task::spawn_blocking(move || {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .output()
    })
    .await
    .map_err(|e| format!("打开下载页失败: {e}"))?
    .map_err(|e| format!("打开下载页失败: {e}"))?;
    if !open.status.success() {
        let err = String::from_utf8_lossy(&open.stderr).trim().to_string();
        return Err(format!("打开下载页失败: {err}"));
    }
    tracing::info!("已打开 VB-CABLE 下载页，等待用户安装");
    Ok("已在浏览器打开 VB-CABLE 下载页：下载安装 CABLE 并重启电脑后，回到这里再点一次按钮完成挂接".into())
}

/// macOS：内嵌 pkg 落盘 → 管理员授权安装（弹一次密码）→
/// 重启 coreaudiod 加载 → 重建输出引擎。返回结果文案。
#[cfg(target_os = "macos")]
async fn install_driver_macos() -> Result<String, String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("数据目录不可写: {e}"))?;
    let pkg = dir.join("BlackHole2ch-0.7.1.pkg");
    std::fs::write(&pkg, BH_PKG).map_err(|e| format!("写出安装包失败: {e}"))?;

    // installer 与 coreaudiod 重启合并进同一次授权；killall 失败不掩盖安装结果
    let script = format!(
        "do shell script \"installer -pkg '{}' -target / && (killall coreaudiod || true)\" with administrator privileges",
        pkg.display()
    );
    let out = tokio::task::spawn_blocking(move || {
        std::process::Command::new("osascript").arg("-e").arg(&script).output()
    })
    .await
    .map_err(|e| format!("启动安装失败: {e}"))?
    .map_err(|e| format!("启动安装失败: {e}"))?;

    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        tracing::warn!("驱动安装失败: {err}");
        if err.contains("-128") || err.to_lowercase().contains("cancel") {
            return Err("已取消：安装需要输入一次管理员密码".into());
        }
        return Err(err);
    }
    tracing::info!("驱动安装完成，等待音频服务重新加载");

    // coreaudiod 需要一两秒完成驱动加载，随后重建输出引擎重新挂接设备
    tokio::time::sleep(Duration::from_secs(2)).await;
    let name = reattach_preferred().await.map_err(|e| format!("驱动已安装，但{e}"))?;
    Ok(format!("驱动已安装，输出设备: {name}"))
}

pub fn run() {
    // panic 也写入日志文件：GUI 应用的 stderr 不可见
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        tracing::error!("panic: {info}");
        default_hook(info);
    }));

    let dir = data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let (file_writer, guard) =
        tracing_appender::non_blocking(tracing_appender::rolling::never(&dir, "app.log"));
    let _ = LOG_GUARD.set(guard);

    use tracing_subscriber::prelude::*;
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "info".into());
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stdout))
        .with(tracing_subscriber::fmt::layer().with_ansi(false).with_writer(file_writer))
        .with(filter)
        .init();
    tracing::info!("日志文件: {}/app.log", dir.display());

    let stats = Arc::new(Stats::default());
    let fifo = AudioFifo::new(stats.clone());
    let _ = CTX.set(AppCtx {
        server: Mutex::new(None),
        engine: Mutex::new(None),
        desired_device: Mutex::new(None),
        stats,
        fifo,
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]), // 自启动时不弹窗口，常驻菜单栏
        ))
        .invoke_handler(tauri::generate_handler![
            get_status,
            start_server,
            stop_server,
            output_devices,
            set_output_device,
            pairing_qr,
            remote_pairing,
            reset_remote_pairing,
            install_driver
        ])
        .setup(|app| {
            // ---- 菜单栏托盘 ----
            use tauri::menu::{Menu, MenuItem};
            use tauri::tray::TrayIconBuilder;

            // 窗口落在已断开的显示器上时拉回主屏（切换显示器/拔线的常见场景）
            if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                let monitors = app.available_monitors().unwrap_or_default();
                let on_screen = w
                    .outer_position()
                    .map(|p| {
                        monitors.iter().any(|m| {
                            let b = m.position();
                            let sz = m.size();
                            p.x >= b.x
                                && p.x < b.x + sz.width as i32
                                && p.y >= b.y
                                && p.y < b.y + sz.height as i32
                        })
                    })
                    .unwrap_or(true);
                if !on_screen {
                    let _ = w.center();
                }
            }

            let mi_status = MenuItem::with_id(app, "pm_status", tray_str("状态：等待手机", "Status: waiting for phone"), false, None::<&str>)?;
            let mi_show = MenuItem::with_id(app, "pm_show", tray_str("显示主窗口", "Show main window"), true, None::<&str>)?;
            let mi_restart = MenuItem::with_id(app, "pm_restart", tray_str("重启服务", "Restart service"), true, None::<&str>)?;
            let mi_quit = MenuItem::with_id(app, "pm_quit", tray_str("退出 PhoneMic", "Quit PhoneMic"), true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&mi_status, &mi_show, &mi_restart, &mi_quit])?;

            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;
            TrayIconBuilder::with_id("main")
                .icon(icon)
                .icon_as_template(true)
                .tooltip("PhoneMic")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "pm_show" => {
                        if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "pm_restart" => {
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(e) = do_start().await {
                                tracing::error!("托盘重启失败: {e:#}");
                            }
                        });
                    }
                    "pm_quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            let _ = TRAY_STATUS.set(mi_status);

            // 自启动参数：静默启动（只在菜单栏）
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                    let _ = w.hide();
                }
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = do_start().await {
                    tracing::error!("服务启动失败: {e:#}");
                }
                loop {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    let st = status_response(ctx());
                    let _ = handle.emit("stats", st.clone());
                    // 托盘状态项
                    let live = tray_str("状态：直播中", "Status: LIVE");
                    let text = if st.stats.connected {
                        format!("{}{}", live, if st.stats.remote { tray_str("（远程）", " (relay)") } else { "".into() })
                    } else if st.running {
                        tray_str("状态：等待手机", "Status: waiting for phone")
                    } else {
                        tray_str("状态：已停止", "Status: stopped")
                    };
                    if let Some(mi) = TRAY_STATUS.get() {
                        if mi.text().unwrap_or_default() != text {
                            let _ = mi.set_text(text);
                        }
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // 点关闭按钮不退出：收进菜单栏，托盘菜单里退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("构建 Tauri 应用失败")
        .run(|app, event| {
            // macOS Dock 图标点击 → 恢复窗口（Reopen 为 macOS 专属事件）
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(w) = tauri::Manager::get_webview_window(app, "main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (&app, &event);
            }
        });
}
