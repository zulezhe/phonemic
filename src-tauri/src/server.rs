//! HTTP/WS 双服务：
//! - HTTP (0.0.0.0:port)：手机引导页 /setup、CA 下载 /ca.pem、/ios.mobileconfig、
//!   手机页面（本机调试与 chrome://flags 白名单场景）、/ws
//! - HTTPS (0.0.0.0:https_port)：手机页面 + /ws（自签 CA，SAN 含局域网 IP）

use crate::audio::AudioFifo;
use crate::cert::{self, TlsMaterial};
use crate::protocol::ServerText;
use crate::session::{run_session, SessionIo, TransportCmd, TransportMsg};
use crate::state::Stats;
use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use rand::Rng;
use rust_embed::RustEmbed;
use std::collections::HashMap;
use std::net::IpAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, watch};

#[derive(RustEmbed)]
#[folder = "../phone/dist"]
struct PhoneAssets;

pub const MDNS_HOST: &str = "phonemic.local";

/// 探测本机出口局域网 IP（connect 不真正发包，仅让内核选路由）
pub fn lan_ip() -> Option<IpAddr> {
    let s = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    s.connect("8.8.8.8:80").ok()?;
    s.local_addr().ok().map(|a| a.ip())
}

#[derive(Clone)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16, // 0 = 随机
    pub https_port: u16, // 0 = 关闭 HTTPS
    pub data_dir: Option<PathBuf>, // None = 关闭 HTTPS
    pub lan_ip: Option<IpAddr>,
    pub dev_no_token: bool,
}

pub struct ServerHandle {
    pub port: u16,
    pub https_port: Option<u16>,
    pub token: String,
    pub stats: Arc<Stats>,
    pub fifo: Arc<AudioFifo>,
    pub tls: Option<TlsMaterial>,
    pub shutdown: watch::Sender<bool>,
    pub tasks: Vec<tokio::task::JoinHandle<()>>,
}

#[derive(Clone)]
struct Shared {
    stats: Arc<Stats>,
    fifo: Arc<AudioFifo>,
    token: String,
    dev: bool,
    setup_html: Arc<String>,
    ca_pem: Option<Arc<String>>,
    mobileconfig: Option<Arc<String>>,
}

/// 手机页面 + WS + 统计（不绑定 state，由调用方 with_state）
fn phone_routes() -> Router<Shared> {
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/stats.json", get(stats_handler))
        .fallback(static_handler)
}

pub async fn start_server(cfg: ServerConfig, stats: Arc<Stats>, fifo: Arc<AudioFifo>) -> Result<ServerHandle> {
    // token 固定在数据目录：手机扫码/收藏的链接重启后仍然有效
    let token = match &cfg.data_dir {
        Some(dir) => {
            let path = dir.join("token.txt");
            match std::fs::read_to_string(&path) {
                Ok(t) if t.trim().len() == 16 => t.trim().to_string(),
                _ => {
                    let t = format!("{:016x}", rand::thread_rng().gen::<u64>());
                    let _ = std::fs::create_dir_all(dir);
                    std::fs::write(&path, &t).with_context(|| path.display().to_string())?;
                    t
                }
            }
        }
        None => format!("{:016x}", rand::thread_rng().gen::<u64>()),
    };

    // HTTPS 材料（可选）
    let tls = match (&cfg.data_dir, cfg.lan_ip, cfg.https_port) {
        (Some(dir), Some(ip), port) if port != 0 => {
            match cert::load_or_create(dir, &[ip], &[MDNS_HOST]) {
                Ok(t) => Some(t),
                Err(e) => {
                    tracing::warn!("HTTPS 证书生成失败（降级为仅 HTTP）: {e:#}");
                    None
                }
            }
        }
        _ => None,
    };

    // 先绑定 HTTPS 监听拿到实际端口，引导页链接要用
    let mut https_setup: Option<(std::net::TcpListener, axum_server::tls_rustls::RustlsConfig, axum_server::Handle)> = None;
    let mut https_port = None;
    if let Some(tls) = tls.clone() {
        let rustls_cfg = build_rustls_config(&tls)?;
        let std_listener =
            std::net::TcpListener::bind(("0.0.0.0", cfg.https_port)).context("HTTPS 端口被占用")?;
        let actual_port = std_listener.local_addr()?.port();
        let handle = axum_server::Handle::new();
        let rustls = axum_server::tls_rustls::RustlsConfig::from_config(Arc::new(rustls_cfg));
        https_port = Some(actual_port);
        https_setup = Some((std_listener, rustls, handle));
    }

    let shared = Shared {
        stats: stats.clone(),
        fifo: fifo.clone(),
        token: token.clone(),
        dev: cfg.dev_no_token,
        setup_html: Arc::new(setup_page_html(https_port)),
        ca_pem: tls.as_ref().map(|t| Arc::new(t.ca_pem.clone())),
        mobileconfig: tls.as_ref().map(|t| Arc::new(cert::mobileconfig(&t.ca_der_b64))),
    };

    let http_router = Router::new()
        .route("/setup", get(setup_handler))
        .route("/ca.pem", get(ca_handler))
        .route("/ios.mobileconfig", get(mobileconfig_handler))
        .merge(phone_routes())
        .with_state(shared.clone());

    // HTTP
    let listener = tokio::net::TcpListener::bind((cfg.host.as_str(), cfg.port)).await?;
    let port = listener.local_addr()?.port();
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let mut tasks = Vec::new();
    {
        let mut rx = shutdown_rx.clone();
        tasks.push(tokio::spawn(async move {
            let _ = axum::serve(listener, http_router)
                .with_graceful_shutdown(async move {
                    let _ = rx.changed().await;
                })
                .await;
        }));
    }

    // HTTPS
    if let Some((std_listener, rustls, server_handle)) = https_setup {
        let h2 = server_handle.clone();
        let mut rx = shutdown_rx.clone();
        tokio::spawn(async move {
            let _ = rx.changed().await;
            h2.graceful_shutdown(Some(Duration::from_secs(2)));
        });
        let app = phone_routes().with_state(shared.clone());
        tasks.push(tokio::spawn(async move {
            let _ = axum_server::from_tcp_rustls(std_listener, rustls)
                .handle(server_handle)
                .serve(app.into_make_service())
                .await;
        }));
    }

    tracing::info!(
        "服务已启动: http://{}:{port} token: {token}{}",
        cfg.host,
        https_port.map(|p| format!(" https://0.0.0.0:{p}")).unwrap_or_default()
    );
    Ok(ServerHandle {
        port,
        https_port,
        token,
        stats,
        fifo,
        tls,
        shutdown: shutdown_tx,
        tasks,
    })
}

fn build_rustls_config(tls: &TlsMaterial) -> Result<rustls::ServerConfig> {
    let certs: Vec<_> = rustls_pemfile::certs(&mut tls.server_pem.as_bytes())
        .collect::<std::result::Result<_, _>>()?;
    let key = rustls_pemfile::private_key(&mut tls.server_key_pem.as_bytes())?.context("服务器私钥缺失")?;
    let mut cfg = rustls::ServerConfig::builder_with_provider(
        rustls::crypto::ring::default_provider().into(),
    )
    .with_safe_default_protocol_versions()?
    .with_no_client_auth()
    .with_single_cert(certs, key)?;
    cfg.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(cfg)
}

// ---------- 页面与证书分发 ----------

async fn static_handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    match PhoneAssets::get(path) {
        Some(file) => asset_response(path, file.data.into_owned()),
        None => match PhoneAssets::get("index.html") {
            Some(file) => asset_response("index.html", file.data.into_owned()),
            None => (StatusCode::NOT_FOUND, "phone UI 未构建：先运行 npm run phone:build").into_response(),
        },
    }
}

fn asset_response(path: &str, body: Vec<u8>) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();
    ([(header::CONTENT_TYPE, mime.as_ref().to_string())], body).into_response()
}

async fn setup_handler(State(sh): State<Shared>) -> Response {
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8".to_string())],
        sh.setup_html.as_str().to_string(),
    )
        .into_response()
}

async fn ca_handler(State(sh): State<Shared>) -> Response {
    match &sh.ca_pem {
        Some(pem) => (
            [
                (header::CONTENT_TYPE, "application/x-x509-ca-cert".to_string()),
                (header::CONTENT_DISPOSITION, "attachment; filename=\"phonemic-ca.pem\"".to_string()),
            ],
            pem.as_str().to_string(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "HTTPS 未启用").into_response(),
    }
}

async fn mobileconfig_handler(State(sh): State<Shared>) -> Response {
    match &sh.mobileconfig {
        Some(xml) => (
            [
                (header::CONTENT_TYPE, "application/x-apple-aspen-config".to_string()),
                (header::CONTENT_DISPOSITION, "attachment; filename=\"phonemic-ca.mobileconfig\"".to_string()),
            ],
            xml.as_str().to_string(),
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "HTTPS 未启用").into_response(),
    }
}

async fn stats_handler(State(sh): State<Shared>) -> Json<crate::state::StatsSnapshot> {
    Json(sh.stats.snapshot())
}

// ---------- WebSocket 音频会话 ----------

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<HashMap<String, String>>,
    State(sh): State<Shared>,
) -> Response {
    let authed = sh.dev || q.get("token").map(|t| t == &sh.token).unwrap_or(false);
    ws.on_upgrade(move |socket| session(socket, authed, sh))
}

/// LocalWs 传输适配器：axum 服务端 socket ↔ 通道桥接，协议逻辑在 session::run_session。
async fn session(mut socket: WebSocket, authed: bool, sh: Shared) {
    use futures_util::{SinkExt, StreamExt};

    if !authed {
        let err = ServerText::Welcome {
            ok: false,
            mode: String::new(),
            message: Some("token 无效，请从二维码或桌面界面进入".to_string()),
        };
        let _ = socket.send(Message::Text(serde_json::to_string(&err).unwrap())).await;
        return;
    }

    let (in_tx, inbound_rx) = mpsc::channel::<TransportMsg>(64);
    let (outbound_tx, mut out_rx) = mpsc::channel::<TransportCmd>(64);
    let (mut sink, mut stream) = socket.split();

    // socket → inbound
    let reader = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            let m = match msg {
                Message::Text(t) => TransportMsg::Text(t),
                Message::Binary(b) => TransportMsg::Binary(b),
                Message::Close(_) => break,
                _ => continue,
            };
            if in_tx.send(m).await.is_err() {
                break;
            }
        }
    });
    // outbound → socket
    let writer = tokio::spawn(async move {
        while let Some(cmd) = out_rx.recv().await {
            let msg = match cmd {
                TransportCmd::Text(t) => Message::Text(t),
                TransportCmd::Binary(b) => Message::Binary(b),
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    run_session(SessionIo { inbound_rx, outbound_tx }, sh.stats.clone(), sh.fifo.clone()).await;
    reader.abort();
    writer.abort();
}

fn setup_page_html(https_port: Option<u16>) -> String {
    let port_js = match https_port {
        Some(p) => p.to_string(),
        None => "null".to_string(),
    };
    r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>PhoneMic</title>
<style>
  body{background:#0f1218;color:#e8ecf1;font-family:-apple-system,"PingFang SC",sans-serif;
       margin:0;padding:24px 18px calc(40px + env(safe-area-inset-bottom));line-height:1.6}
  h1{font-size:20px;margin:0 0 4px}
  .sub{color:#8b93a1;font-size:13px;margin-bottom:18px}
  a.btn{display:block;text-align:center;padding:14px;border-radius:10px;
    background:#2f6fed;color:#fff;font-size:16px;text-decoration:none;margin:12px 0}
  .warn{background:#171c26;border:1px solid #2a3242;border-radius:12px;padding:14px;margin:14px 0}
  .warn summary{cursor:pointer;font-size:14px;color:#b7bfcc}
  .warn b{color:#e8ecf1}
  ol{margin:8px 0 12px;padding-left:20px;font-size:14px;color:#b7bfcc}
  a.minor{color:#2f6fed;font-size:13px}
  code{background:#10141c;padding:2px 6px;border-radius:4px;font-size:12px;color:#f5d90a;
    user-select:all;-webkit-user-select:all;word-break:break-all}
  .fine{font-size:12px;color:#5d6572}
</style>
</head>
<body>
<h1>🎙 <span data-i18n="title">PhoneMic 连接</span></h1>
<div class="sub" data-i18n="sub"></div>

<a class="btn" id="go" data-i18n="go"></a>
<div class="fine" data-i18n="fine1"></div>

<details class="warn" id="ios">
  <summary data-i18n="iosSummary"></summary>
  <ol data-i18n-html="iosSteps"></ol>
</details>

<details class="warn" id="android">
  <summary data-i18n="androidSummary"></summary>
  <ol data-i18n-html="androidSteps"></ol>
  <div class="fine" data-i18n-html="geek"></div>
</details>

<script>
  // ---- i18n：?lang= > navigator.language，默认中文 ----
  const I18N = {
    zh: {
      title: "PhoneMic 连接",
      sub: "点下面按钮即可开始；若浏览器提示“不是私密连接”，选“高级 → 继续访问”",
      go: "打开麦克风页面 →",
      fine1: "之后每次从电脑二维码进入同样只需一次“继续访问”。嫌烦的话，展开下面的可选步骤安装证书，即可永久消除提示。",
      iosSummary: "可选：iPhone/iPad 永久消除“不安全”提示",
      iosSteps: `<li>点击 <a class="minor" href="/ios.mobileconfig">安装描述文件</a>，允许下载</li>
        <li>设置 → 通用 → <b>VPN与设备管理</b> → PhoneMic CA → 安装</li>
        <li>设置 → 通用 → 关于本机 → <b>证书信任设置</b> → 勾选 <b>PhoneMic Root CA</b>（关键，别漏）</li>
        <li>回到本页点上方按钮，不再出现警告</li>`,
      androidSummary: "可选：Android 永久消除“不安全”提示",
      androidSteps: `<li><a class="minor" href="/ca.pem">下载 CA 证书</a>（phonemic-ca.pem）</li>
        <li>设置 → 安全 → <b>加密与凭据</b> → 安装证书 → CA 证书，选中刚下载的文件（各品牌路径略异）</li>
        <li>用 Chrome 打开上方链接，不再出现警告</li>`,
      geek: `极客路线：Chrome 输入
        <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>，
        填入 <code id="origin"></code> 并启用重启后，
        <a style="color:#2f6fed" id="httpGo">直接用 HTTP 链接</a>（无需证书）。`,
    },
    en: {
      title: "PhoneMic Setup",
      sub: "Tap the button below to start. If the browser warns “Not private”, choose “Advanced → Proceed”.",
      go: "Open the microphone page →",
      fine1: "Each future visit from the desktop QR needs just one “Proceed”. To remove the warning for good, install the certificate via the optional steps below.",
      iosSummary: "Optional: remove the warning on iPhone/iPad for good",
      iosSteps: `<li>Tap <a class="minor" href="/ios.mobileconfig">Install profile</a> and allow the download</li>
        <li>Settings → General → <b>VPN & Device Management</b> → PhoneMic CA → Install</li>
        <li>Settings → General → About → <b>Certificate Trust Settings</b> → enable <b>PhoneMic Root CA</b> (crucial, don't skip)</li>
        <li>Come back and tap the button above — the warning is gone</li>`,
      androidSummary: "Optional: remove the warning on Android for good",
      androidSteps: `<li><a class="minor" href="/ca.pem">Download the CA certificate</a> (phonemic-ca.pem)</li>
        <li>Settings → Security → <b>Encryption & credentials</b> → Install a certificate → CA certificate, pick the downloaded file (paths vary by brand)</li>
        <li>Open the link above in Chrome — the warning is gone</li>`,
      geek: `Geek route: in Chrome open
        <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>,
        enter <code id="origin"></code>, enable and relaunch, then
        <a style="color:#2f6fed" id="httpGo">use the plain HTTP link</a> (no certificate needed).`,
    },
  };
  const qLang = new URLSearchParams(location.search).get("lang");
  const L = I18N[qLang] ?? I18N[(navigator.language || "zh").toLowerCase().startsWith("zh") ? "zh" : "en"];
  document.documentElement.lang = L === I18N.zh ? "zh-CN" : "en";
  document.title = L.title;
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = L[el.dataset.i18n];
  for (const el of document.querySelectorAll("[data-i18n-html]")) el.innerHTML = L[el.dataset.i18nHtml];

  const m = location.hash.match(/token=([A-Za-z0-9_-]+)/);
  const token = m ? m[1] : '';
  const httpsPort = __HTTPS_PORT__;
  const httpsUrl = httpsPort ? `https://${location.hostname}:${httpsPort}/#token=${token}` : null;
  const go = document.getElementById('go');
  if (httpsUrl) {
    go.href = httpsUrl;
    document.getElementById('httpGo').href = `http://${location.host}/#token=${token}`;
    document.getElementById('origin').textContent = `http://${location.host}`;
  } else {
    go.href = `http://${location.host}/#token=${token}`;
    document.getElementById('android').style.display = 'none';
  }
</script>
</body>
</html>"#
        .replace("__HTTPS_PORT__", &port_js)
}
