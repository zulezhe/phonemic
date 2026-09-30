//! PhoneMic 自托管中继（配对协议第二实现，对齐 relay/src/room.ts 语义）。
//!
//! 生命周期：第一个连接进入 → 等待（WAIT_TTL 超时作废）→ 第二个连接进入 →
//! 双方 roomState ready → 帧原样透传（E2EE 密文不解）→ 任一方离开 → 对端 bye。
//!
//! 防护（对齐 T13）：全局房间数上限 + 每 IP 新房限速 + 会话时长上限。
//!
//! 环境变量：
//!   LISTEN             监听地址（默认 0.0.0.0:9430）
//!   WAIT_TTL_SECS      等待配对超时（默认 3600）
//!   SESSION_MAX_SECS   单会话时长上限（默认 14400）
//!   MAX_ROOMS          全局并发房间上限（默认 100）
//!   IP_ROOMS_PER_MIN   每 IP 每分钟新建房间数（默认 30）

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{ConnectInfo, Path, State, WebSocketUpgrade};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use rust_embed::RustEmbed;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Mutex};

#[derive(RustEmbed)]
#[folder = "../phone/dist"]
struct PhoneAssets;

struct Config {
    wait_ttl: Duration,
    session_max: Duration,
    max_rooms: usize,
    ip_rooms_per_min: usize,
}

impl Config {
    fn from_env() -> Self {
        let f = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
        Config {
            wait_ttl: Duration::from_secs(f("WAIT_TTL_SECS", 3600)),
            session_max: Duration::from_secs(f("SESSION_MAX_SECS", 14400)),
            max_rooms: f("MAX_ROOMS", 100) as usize,
            ip_rooms_per_min: f("IP_ROOMS_PER_MIN", 30) as usize,
        }
    }
}

/// 房间入口：第二方 WS 经 join_tx 进入已存在的房间 task
#[derive(Clone)]
struct RoomEntry {
    join_tx: mpsc::Sender<WebSocket>,
}

struct AppState {
    cfg: Config,
    rooms: Mutex<HashMap<String, RoomEntry>>,
    /// ip -> (新房计数, 窗口起点)
    ip_counts: Mutex<HashMap<String, (usize, Instant)>>,
}

impl AppState {
    /// 新房间准入：返回 Some(第二方是否直接加入) / Err(拒绝原因)
    async fn admit(&self, code: &str, ip: &str) -> Result<bool, &'static str> {
        let rooms = self.rooms.lock().await;
        if rooms.contains_key(code) {
            return Ok(true); // 已有房间：第二方加入，不占新名额
        }
        {
            let mut ips = self.ip_counts.lock().await;
            let now = Instant::now();
            let e = ips.entry(ip.to_string()).or_insert((0, now));
            if now.duration_since(e.1) >= Duration::from_secs(60) {
                *e = (1, now);
            } else {
                e.0 += 1;
                if e.0 > self.cfg.ip_rooms_per_min {
                    return Err("ip-rate");
                }
            }
        }
        if rooms.len() >= self.cfg.max_rooms {
            return Err("busy");
        }
        Ok(false)
    }
}

fn json_msg(v: &serde_json::Value) -> Message {
    Message::Text(v.to_string().into())
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let listen: SocketAddr = std::env::var("LISTEN")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or_else(|| "0.0.0.0:9430".parse().unwrap());
    let state = Arc::new(AppState {
        cfg: Config::from_env(),
        rooms: Mutex::new(HashMap::new()),
        ip_counts: Mutex::new(HashMap::new()),
    });

    let app = Router::new()
        .route("/healthz", get(|| async { "phonemic-relay ok\n" }))
        .route("/ws/pair/{code}", get(pair_ws))
        .fallback(get(serve_phone))
        .with_state(state.clone());

    let listener = tokio::net::TcpListener::bind(listen).await.expect("bind");
    tracing::info!("phonemic-relay listening on {listen}");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .await
        .unwrap();
}

async fn serve_phone(uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };
    let asset = PhoneAssets::get(path).or_else(|| PhoneAssets::get("index.html"));
    match asset {
        Some(a) => {
            let mime = match path.rsplit('.').next() {
                Some("js") => "text/javascript",
                Some("css") => "text/css",
                Some("svg") => "image/svg+xml",
                Some("png") => "image/png",
                Some("json") | Some("webmanifest") => "application/json",
                _ => "text/html; charset=utf-8",
            };
            ([(axum::http::header::CONTENT_TYPE, mime)], a.data).into_response()
        }
        None => (StatusCode::NOT_FOUND, "phone dist missing").into_response(),
    }
}

async fn pair_ws(
    ws: WebSocketUpgrade,
    Path(code): Path<String>,
    State(state): State<Arc<AppState>>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    let ip = addr.ip().to_string();
    // code 格式与官方中继一致：16-64 位 url-safe
    let valid = (16..=64).contains(&code.len())
        && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
    if !valid {
        return StatusCode::NOT_FOUND.into_response();
    }
    let joining = match state.admit(&code, &ip).await {
        Ok(j) => j,
        Err(reason) => {
            tracing::warn!("reject room={}.. ip={ip} reason={reason}", &code[..8.min(code.len())]);
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
    };

    if joining {
        // 第二方：把 socket 交给已存在的房间 task
        let entry = state.rooms.lock().await.get(&code).cloned();
        match entry {
            Some(e) => ws
                .on_upgrade(move |socket| async move {
                    // 房间 task 持有 join_rx；发送失败=房间已关闭，直接断开
                    if e.join_tx.send(socket).await.is_err() {
                        tracing::info!("join failed: room closed");
                    }
                })
                .into_response(),
            None => StatusCode::NOT_FOUND.into_response(),
        }
    } else {
        // 第一方：创建房间 task
        let (join_tx, join_rx) = mpsc::channel::<WebSocket>(1);
        state.rooms.lock().await.insert(code.clone(), RoomEntry { join_tx });
        let st = state.clone();
        let c = code.clone();
        ws.on_upgrade(move |socket| async move {
            room_task(st, c, socket, join_rx).await;
        })
        .into_response()
    }
}

/// 一个房间的完整生命周期：守候 → 成对 → 桥接 → 销毁
async fn room_task(state: Arc<AppState>, code: String, mut first: WebSocket, mut join_rx: mpsc::Receiver<WebSocket>) {
    tracing::info!("room open: {}..", &code[..8.min(code.len())]);
    let cfg = &state.cfg;
    let wait_deadline = tokio::time::Instant::now() + cfg.wait_ttl;

    // 等待期：等第二方/超时，期间回 waiting（对齐 room.ts：hello 由端上自然发出）
    let second = loop {
        tokio::select! {
            _ = tokio::time::sleep_until(wait_deadline) => {
                close_with(&mut first, r#"{"type":"error","code":"EXPIRED","message":"pairing timeout"}"#).await;
                break None;
            }
            m = first.recv() => match m {
                Some(Ok(msg)) => {
                    if let Message::Close(_) = msg { break None; }
                    let _ = first.send(json_msg(&serde_json::json!({"type":"roomState","state":"waiting"}))).await;
                }
                _ => break None,
            },
            s = join_rx.recv() => match s {
                Some(ws) => break Some(ws),
                None => break None,
            },
        }
    };

    let mut second = match second {
        Some(s) => s,
        None => {
            state.rooms.lock().await.remove(&code);
            tracing::info!("room closed (wait): {}..", &code[..8.min(code.len())]);
            return;
        }
    };

    // 双方到齐：ready + 会话桥接
    let ready = serde_json::json!({"type":"roomState","state":"ready"});
    let _ = first.send(json_msg(&ready)).await;
    let _ = second.send(json_msg(&ready)).await;
    tracing::info!("room paired: {}..", &code[..8.min(code.len())]);

    const BYE: &str = r#"{"type":"bye","reason":"peer-left"}"#;
    let session_deadline = tokio::time::Instant::now() + cfg.session_max;
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(session_deadline) => {
                close_with(&mut first, r#"{"type":"bye","reason":"time-limit"}"#).await;
                close_with(&mut second, r#"{"type":"bye","reason":"time-limit"}"#).await;
                break;
            }
            m = first.recv() => match m {
                // first 断开（Close 帧或流终止/出错）→ 通知 second
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    close_with(&mut second, BYE).await;
                    break;
                }
                // 转发失败 = second 已断 → 通知 first
                Some(Ok(msg)) => {
                    if fwd(&mut second, msg).await.is_err() {
                        close_with(&mut first, BYE).await;
                        break;
                    }
                }
            },
            m = second.recv() => match m {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    close_with(&mut first, BYE).await;
                    break;
                }
                Some(Ok(msg)) => {
                    if fwd(&mut first, msg).await.is_err() {
                        close_with(&mut second, BYE).await;
                        break;
                    }
                }
            },
        }
    }
    state.rooms.lock().await.remove(&code);
    tracing::info!("room closed: {}..", &code[..8.min(code.len())]);
}

async fn close_with(ws: &mut WebSocket, json: &str) {
    let _ = ws.send(Message::Text(json.to_string().into())).await;
    // 给控制帧留出 flush 时间：Close 握手会关闭底层连接，抢跑会吞掉刚发的文本帧
    tokio::time::sleep(Duration::from_millis(50)).await;
    let _ = ws.send(Message::Close(None)).await;
}

/// 原样透传（不解析内容）
async fn fwd(dst: &mut WebSocket, m: Message) -> Result<(), ()> {
    let out = match m {
        Message::Text(t) => Message::Text(t),
        Message::Binary(b) => Message::Binary(b),
        Message::Ping(p) => Message::Ping(p),
        Message::Pong(p) => Message::Pong(p),
        Message::Close(_) => return Err(()),
        _ => return Ok(()),
    };
    dst.send(out).await.map_err(|_| ())
}
