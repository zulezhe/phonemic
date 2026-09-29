//! 传输协议：定义与 docs/protocol.md、shared/protocol.ts 保持一致。

use serde::{Deserialize, Serialize};

pub const PROTOCOL_VERSION: u8 = 1;
pub const FRAME_PCM_F32: u8 = 1;
pub const FRAME_OPUS: u8 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AudioHeader {
    pub kind: u8, // FRAME_*
    pub seq: u16,
    pub ts_ms: u32,
}

/// 解析二进制音频帧：[版本+类型 u8][seq u16 LE][ts u32 LE][payload]
pub fn parse_audio_frame(buf: &[u8]) -> Option<(AudioHeader, &[u8])> {
    if buf.len() < 7 {
        return None;
    }
    let version_type = buf[0];
    if version_type >> 4 != PROTOCOL_VERSION {
        return None;
    }
    let kind = version_type & 0x0f;
    if kind != FRAME_PCM_F32 && kind != FRAME_OPUS {
        return None;
    }
    let seq = u16::from_le_bytes([buf[1], buf[2]]);
    let ts = u32::from_le_bytes([buf[3], buf[4], buf[5], buf[6]]);
    Some((
        AudioHeader {
            kind,
            seq,
            ts_ms: ts,
        },
        &buf[7..],
    ))
}

/// 序号回绕感知的距离：cur 相对 last 前进了多少（负数表示大幅后退，视为重传/重启）。
pub fn seq_ahead(last: u16, cur: u16) -> i32 {
    let d = cur.wrapping_sub(last) as i32;
    if d > 32767 {
        d - 65536
    } else {
        d
    }
}

#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
pub enum ClientText {
    #[serde(rename = "hello", rename_all = "camelCase")]
    Hello {
        mode: String,
        sample_rate: u32,
        channels: u16,
    },
    #[serde(rename = "ping")]
    Ping {
        t: f64,
    },
    #[serde(rename = "report", rename_all = "camelCase")]
    Report {
        rtt_ms: Option<f64>,
    },
    #[serde(rename = "bye")]
    Bye,
}

#[derive(Serialize, Debug)]
#[serde(tag = "type")]
pub enum ServerText {
    #[serde(rename = "welcome", rename_all = "camelCase")]
    Welcome {
        ok: bool,
        mode: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "pong")]
    Pong {
        t: f64,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_and_reject() {
        let mut buf = vec![0u8; 7 + 4];
        buf[0] = (PROTOCOL_VERSION << 4) | FRAME_PCM_F32;
        buf[1..3].copy_from_slice(&510u16.to_le_bytes());
        buf[3..7].copy_from_slice(&1234u32.to_le_bytes());
        let (hdr, payload) = parse_audio_frame(&buf).unwrap();
        assert_eq!(hdr.kind, FRAME_PCM_F32);
        assert_eq!(hdr.seq, 510);
        assert_eq!(hdr.ts_ms, 1234);
        assert_eq!(payload.len(), 4);

        // 版本不符
        let mut bad = buf.clone();
        bad[0] = (9 << 4) | FRAME_PCM_F32;
        assert!(parse_audio_frame(&bad).is_none());
        // 太短
        assert!(parse_audio_frame(&buf[..6]).is_none());
    }

    #[test]
    fn seq_wraparound() {
        assert_eq!(seq_ahead(65534, 0), 2);
        assert_eq!(seq_ahead(0, 65534), -2);
        assert_eq!(seq_ahead(10, 10), 0);
    }
}
