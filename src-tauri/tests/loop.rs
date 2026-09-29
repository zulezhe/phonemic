//! 集成测试：拉起 server，用 WS 客户端模拟手机推 PCM 流。

use futures_util::{SinkExt, StreamExt};
use phonemic::audio::AudioFifo;
use phonemic::protocol::{FRAME_PCM_F32, PROTOCOL_VERSION};
use phonemic::server::{start_server, ServerConfig};
use phonemic::state::Stats;
use std::sync::Arc;
use std::time::Duration;

fn test_cfg(port: u16, dev: bool) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port,
        https_port: 0,
        data_dir: None,
        lan_ip: None,
        dev_no_token: dev,
    }
}

#[tokio::test]
async fn ws_audio_loop() {
    let stats = Arc::new(Stats::default());
    let fifo = AudioFifo::new(stats.clone());
    let handle = start_server(test_cfg(0, true), stats.clone(), fifo.clone()).await.unwrap();

    let url = format!("ws://127.0.0.1:{}/ws?token=whatever", handle.port);
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();

    // hello
    let hello = r#"{"type":"hello","mode":"pcm-f32","sampleRate":48000,"channels":1}"#;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(hello.to_string()))
        .await
        .unwrap();
    let welcome = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let welcome = welcome.into_text().unwrap();
    assert!(welcome.contains(r#""type":"welcome""#), "收到: {welcome}");
    assert!(welcome.contains(r#""ok":true"#), "收到: {welcome}");

    // 发 20 帧 440Hz 正弦 PCM（每帧 960 样本 = 20ms）
    for seq in 0..20u16 {
        let mut buf = vec![0u8; 7 + 960 * 4];
        buf[0] = (PROTOCOL_VERSION << 4) | FRAME_PCM_F32;
        buf[1..3].copy_from_slice(&seq.to_le_bytes());
        buf[3..7].copy_from_slice(&(u32::from(seq) * 20).to_le_bytes());
        for i in 0..960usize {
            let v = ((i as f32) * 440.0 * 2.0 * std::f32::consts::PI / 48000.0).sin() * 0.2;
            buf[7 + i * 4..7 + i * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        ws.send(tokio_tungstenite::tungstenite::Message::Binary(buf))
            .await
            .unwrap();
    }

    // ping/pong
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        r#"{"type":"ping","t":123.0}"#.to_string(),
    ))
    .await
    .unwrap();

    tokio::time::sleep(Duration::from_millis(300)).await;

    let snap = stats.snapshot();
    assert!(snap.frames_in >= 20, "frames_in = {}", snap.frames_in);
    assert!(snap.samples_in >= 20 * 960);
    assert!(snap.level_rms > 0.05, "电平应为正弦能量: {}", snap.level_rms);
    assert!(fifo.len() > 0, "FIFO 应有缓冲");

    let _ = handle.shutdown.send(true);
}

/// 错误 token 必须被拒绝（welcome ok=false）
#[tokio::test]
async fn ws_bad_token_rejected() {
    let stats = Arc::new(Stats::default());
    let fifo = AudioFifo::new(stats.clone());
    let handle = start_server(test_cfg(0, false), stats.clone(), fifo).await.unwrap();

    let url = format!("ws://127.0.0.1:{}/ws?token=deadbeef", handle.port);
    let (mut ws, _resp) = tokio_tungstenite::connect_async(url).await.unwrap();
    let hello = r#"{"type":"hello","mode":"pcm-f32","sampleRate":48000,"channels":1}"#;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(hello.to_string()))
        .await
        .unwrap();
    let welcome = tokio::time::timeout(Duration::from_secs(2), ws.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let welcome = welcome.into_text().unwrap();
    assert!(welcome.contains(r#""ok":false"#), "收到: {welcome}");
    assert!(!stats.snapshot().connected);
    let _ = handle.shutdown.send(true);
}

/// 引导页与 CA 端点（HTTPS 关闭时应 404 / setup 可用）
#[tokio::test]
async fn setup_page_served() {
    let stats = Arc::new(Stats::default());
    let fifo = AudioFifo::new(stats.clone());
    let handle = start_server(test_cfg(0, true), stats, fifo).await.unwrap();

    // 直接借用内部 HTTP 客户端太重：用原生 TCP 发 HTTP 请求断言
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", handle.port)).await.unwrap();
    stream.write_all(b"GET /setup HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut buf = String::new();
    stream.read_to_string(&mut buf).await.unwrap();
    assert!(buf.contains("200 OK"), "非 200: {}", &buf[..buf.len().min(60)]);
    assert!(buf.contains("PhoneMic 连接"), "缺少引导页内容");

    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", handle.port)).await.unwrap();
    stream.write_all(b"GET /ca.pem HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").await.unwrap();
    let mut buf = String::new();
    stream.read_to_string(&mut buf).await.unwrap();
    assert!(buf.contains("404 Not Found"), "HTTPS 关闭时 /ca.pem 应 404: {}", &buf[..buf.len().min(60)]);

    let _ = handle.shutdown.send(true);
}
