//! 会话核心：与传输层无关的音频会话逻辑。
//! LocalWs（axum 服务端，本阶段）与 RelayWs（tungstenite 客户端，P3c）、
//! DataChannel（打洞，P5）统一归一化为 TransportMsg/TransportCmd 后喂给 run_session。
//! 认证是传输层的职责：本地路径校验 query token，中继路径校验配对码。

use crate::audio::{AudioFifo, OpusDecoder, STREAM_RATE};
use crate::protocol::{parse_audio_frame, seq_ahead, ClientText, ServerText, FRAME_OPUS, FRAME_PCM_F32};
use crate::state::Stats;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// 会话收到的消息（各传输归一化）
#[derive(Debug)]
pub enum TransportMsg {
    Text(String),
    Binary(Vec<u8>),
}

/// 会话需要发出的内容
#[derive(Debug)]
pub enum TransportCmd {
    Text(String),
    Binary(Vec<u8>),
}

pub struct SessionIo {
    pub inbound_rx: mpsc::Receiver<TransportMsg>,
    pub outbound_tx: mpsc::Sender<TransportCmd>,
}

async fn send_text(out: &mpsc::Sender<TransportCmd>, msg: &ServerText) {
    let _ = out.send(TransportCmd::Text(serde_json::to_string(msg).unwrap())).await;
}

/// 运行一个音频会话直到断开。内部：hello/welcome 协商、ping/pong、
/// 音频帧解析（seq 对齐/丢包统计）、PCM/Opus 解码、电平统计、写入 FIFO。
pub async fn run_session(io: SessionIo, stats: Arc<Stats>, fifo: Arc<AudioFifo>) {
    let SessionIo { mut inbound_rx, outbound_tx } = io;

    let welcome_err = |msg: &str| ServerText::Welcome {
        ok: false,
        mode: String::new(),
        message: Some(msg.to_string()),
    };

    // hello 协商（10s 超时）
    let hello = match tokio::time::timeout(Duration::from_secs(10), inbound_rx.recv()).await {
        Ok(Some(TransportMsg::Text(t))) => serde_json::from_str::<ClientText>(&t).ok(),
        _ => None,
    };
    let (mode, sample_rate, channels) = match hello {
        Some(ClientText::Hello { mode, sample_rate, channels }) => (mode, sample_rate, channels),
        _ => {
            send_text(&outbound_tx, &welcome_err("期望 hello")).await;
            return;
        }
    };
    if sample_rate != STREAM_RATE || channels != 1 {
        send_text(&outbound_tx, &welcome_err("只支持 48kHz 单声道")).await;
        return;
    }
    let use_opus = mode == "opus";
    let reply_mode = if use_opus { "opus" } else { "pcm-f32" };

    stats.reset_session();
    fifo.flush();
    stats.set_connected(reply_mode);
    let mut decoder = match if use_opus { Some(OpusDecoder::new()) } else { None } {
        Some(Ok(d)) => Some(d),
        Some(Err(e)) => {
            tracing::warn!("Opus 初始化失败: {e:#}");
            send_text(&outbound_tx, &welcome_err("opus 初始化失败")).await;
            return;
        }
        None => None,
    };

    let welcome = ServerText::Welcome { ok: true, mode: reply_mode.to_string(), message: None };
    send_text(&outbound_tx, &welcome).await;

    let mut last_seq: Option<u16> = None;
    while let Some(msg) = inbound_rx.recv().await {
        match msg {
            TransportMsg::Text(t) => match serde_json::from_str::<ClientText>(&t) {
                Ok(ClientText::Ping { t }) => {
                    send_text(&outbound_tx, &ServerText::Pong { t }).await;
                }
                Ok(ClientText::Report { rtt_ms }) => {
                    if let Some(ms) = rtt_ms {
                        stats.set_rtt(ms);
                    }
                }
                Ok(ClientText::Bye) | Ok(ClientText::Hello { .. }) | Err(_) => {}
            },
            TransportMsg::Binary(buf) => {
                let Some((hdr, payload)) = parse_audio_frame(&buf) else { continue };
                if let Some(last) = last_seq {
                    let ahead = seq_ahead(last, hdr.seq);
                    if ahead < -8 || ahead > 64 {
                        fifo.flush();
                    } else if ahead > 1 {
                        stats.add_lost((ahead - 1) as u64);
                    }
                }
                last_seq = Some(hdr.seq);

                let samples: Vec<f32> = match hdr.kind {
                    FRAME_PCM_F32 => payload
                        .chunks_exact(4)
                        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                        .collect(),
                    FRAME_OPUS => match decoder.as_mut().map(|d| d.decode(payload)) {
                        Some(Ok(s)) => s,
                        Some(Err(e)) => {
                            tracing::debug!("opus 帧解码失败: {e:#}");
                            continue;
                        }
                        None => continue,
                    },
                    _ => continue,
                };
                if samples.is_empty() {
                    continue;
                }
                let sum: f32 = samples.iter().map(|s| s * s).sum();
                stats.set_level((sum / samples.len() as f32).sqrt());
                fifo.push(&samples);
                stats.incr_frames(1);
                stats.add_samples(samples.len() as u64);
                stats.add_bytes(buf.len() as u64);
                stats.touch_frame();
            }
        }
    }
    stats.set_disconnected();
    fifo.flush();
}
