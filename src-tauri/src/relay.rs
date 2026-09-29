//! 桌面端远程中继客户端（P3c）：出站连接 PairingRoom，等手机携公钥进入，
//! 派生 E2EE 会话密钥后桥接 session::run_session。
//! 帧封装：中继路径二进制帧 byte0 |= 0x80、payload 为 [12B nonce][AES-GCM ct||tag]；
//! 文本控制帧（hello/welcome/ping/e2eeInit）明文——无敏感内容，relay 原样透传。

use crate::audio::AudioFifo;
use crate::crypto::{self, KeyPair};
use crate::protocol::PROTOCOL_VERSION;
use crate::session::{run_session, SessionIo, TransportCmd, TransportMsg};
use crate::state::Stats;
use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use std::path::Path;
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

pub const RELAY_HOST: &str = "relay.dyzyzj.top";
pub const PAGE_URL_BASE: &str = "https://relay.dyzyzj.top";

/// 桌面静态密钥持久化（数据目录 relay-key.bin，32B 私钥；公钥每次派生）
pub fn load_or_create_keypair(dir: &Path) -> Result<KeyPair> {
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join("relay-key.bin");
    if let Ok(bytes) = std::fs::read(&path) {
        if bytes.len() == 32 {
            if let Ok(secret) = p256::SecretKey::from_slice(&bytes) {
                let public = secret.public_key();
                return Ok(KeyPair { secret, public });
            }
        }
    }
    let kp = KeyPair::generate()?;
    std::fs::write(&path, kp.secret.to_bytes().as_slice())
        .with_context(|| path.display().to_string())?;
    Ok(kp)
}

pub fn new_pair_code() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill(&mut b);
    crypto::b64u_encode(&b)
}

/// 发起远程配对：立即返回配对 URL，会话任务独立运行直到对端断开/超时/被替换。
pub fn spawn_remote_pairing(
    keypair: KeyPair,
    pair_code: String,
    stats: Arc<Stats>,
    fifo: Arc<AudioFifo>,
    kill: tokio::sync::watch::Receiver<bool>,
) -> String {
    let url = format!("{PAGE_URL_BASE}/#p={}&k={}", pair_code, keypair.public_b64u());
    let ws_url = format!("wss://{RELAY_HOST}/ws/pair/{pair_code}");
    tokio::spawn(async move {
        stats.set_remote(true);
        let r = relay_session(ws_url, keypair, pair_code, stats.clone(), fifo, kill).await;
        stats.set_remote(false);
        match r {
            Ok(()) => tracing::info!("远程会话正常结束"),
            Err(e) => tracing::info!("远程会话结束: {e:#}"),
        }
    });
    url
}

async fn relay_session(
    ws_url: String,
    keypair: KeyPair,
    pair_code: String,
    stats: Arc<Stats>,
    fifo: Arc<AudioFifo>,
    mut kill: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    tracing::info!("连接中继: {ws_url}");
    let (ws, _) = tokio_tungstenite::connect_async(&ws_url)
        .await
        .context("连接中继失败")?;
    let mut ws = ws;
    ws.send(Message::Text(
        serde_json::json!({"type": "hello", "role": "desktop", "v": 1}).to_string(),
    ))
    .await?;
    tracing::info!("已进入配对房间，等待手机…");

    // 等待手机的 e2eeInit（携带其临时公钥），60s 内
    let cipher;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let msg = tokio::select! {
            _ = kill.changed() => return Err(anyhow!("被新会话替换")),
            _ = tokio::time::sleep_until(deadline) => return Err(anyhow!("等待配对超时（60s）")),
            m = ws.next() => m.context("中继连接断开")??,
        };
        let Message::Text(t) = msg else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&t) else { continue };
        match v.get("type").and_then(|x| x.as_str()) {
            Some("e2eeInit") => {
                let pub_b64u = v
                    .get("pub")
                    .and_then(|x| x.as_str())
                    .ok_or_else(|| anyhow!("e2eeInit 缺少 pub"))?;
                let peer = crypto::b64u_decode(pub_b64u)?;
                let c = crypto::derive_session_key(&keypair.secret, &peer, &pair_code)?;
                cipher = c;
                tracing::info!("E2EE 会话密钥已建立（手机已进入房间）");
                break;
            }
            Some("roomState") => { /* waiting / ready */ }
            Some("error") | Some("bye") => return Err(anyhow!("中继: {t}")),
            _ => {}
        }
    }

    // 桥接到 run_session（与 LocalWs 适配器同构：reader/writer + channels）
    let (in_tx, inbound_rx) = mpsc::channel::<TransportMsg>(64);
    let (outbound_tx, mut out_rx) = mpsc::channel::<TransportCmd>(64);
    let (mut sink, mut stream) = ws.split();

    // 出站：文本直通；二进制（本端基本不发）走加密封装
    let c_out = cipher.clone();
    let writer = tokio::spawn(async move {
        while let Some(cmd) = out_rx.recv().await {
            let msg = match cmd {
                TransportCmd::Text(t) => Message::Text(t),
                TransportCmd::Binary(mut b) => {
                    if b.len() > 7 {
                        b[0] |= 0x80;
                        let sealed = crypto::seal(&c_out, &b[7..]);
                        b.truncate(7);
                        b.extend_from_slice(&sealed);
                    }
                    Message::Binary(b)
                }
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // 入站：文本直通；二进制解密并还原明文帧头（version 位 8 → 1）
    let reader = tokio::spawn(async move {
        while let Some(Ok(msg)) = stream.next().await {
            let m = match msg {
                Message::Text(t) => TransportMsg::Text(t),
                Message::Binary(mut b) => {
                    if b.len() < 7 + crypto::NONCE_LEN + 16 || b[0] & 0x80 == 0 {
                        continue; // 非中继加密帧，忽略
                    }
                    let plain = match crypto::open(&cipher, &b[7..]) {
                        Ok(p) => p,
                        Err(_) => {
                            tracing::debug!("远程帧解密失败，丢弃");
                            continue;
                        }
                    };
                    b[0] = (PROTOCOL_VERSION << 4) | (b[0] & 0x0f);
                    b.truncate(7);
                    b.extend_from_slice(&plain);
                    TransportMsg::Binary(b)
                }
                Message::Close(_) => break,
                _ => continue,
            };
            if in_tx.send(m).await.is_err() {
                break;
            }
        }
    });

    tokio::select! {
        _ = kill.changed() => {}
        _ = run_session(SessionIo { inbound_rx, outbound_tx }, stats, fifo) => {}
    }
    reader.abort();
    writer.abort();
    Ok(())
}
