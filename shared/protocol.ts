// PhoneMic 传输协议 —— 手机端使用的帧构造与类型定义。
// 与 docs/protocol.md 及 src-tauri/src/protocol.rs 保持一致。

export const PROTOCOL_VERSION = 1;
export const FRAME_PCM_F32 = 1;
export const FRAME_OPUS = 2;

export const SAMPLE_RATE = 48000;
export const CHANNELS = 1;
export const FRAME_SAMPLES = 960; // 20ms @ 48kHz

export type AudioMode = "opus" | "pcm-f32";

export interface Hello {
  type: "hello";
  mode: AudioMode;
  sampleRate: number;
  channels: number;
}

export interface Welcome {
  type: "welcome";
  ok: boolean;
  mode: AudioMode | "";
  message?: string;
}

export interface Ping {
  type: "ping";
  t: number;
}

export interface Pong {
  type: "pong";
  t: number;
}

export interface Report {
  type: "report";
  rttMs?: number;
}

export type ServerText = Welcome | Pong;

/** 二进制音频帧：[版本+类型 u8][seq u16 LE][ts u32 LE][payload] */
export function buildAudioFrame(
  kind: number,
  seq: number,
  tsMs: number,
  payload: ArrayBufferView | Uint8Array,
): Uint8Array {
  const bytes =
    payload instanceof Uint8Array ? payload : new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
  const out = new Uint8Array(7 + bytes.length);
  out[0] = ((PROTOCOL_VERSION & 0x0f) << 4) | (kind & 0x0f);
  new DataView(out.buffer).setUint16(1, seq & 0xffff, true);
  new DataView(out.buffer).setUint32(3, tsMs >>> 0, true);
  out.set(bytes, 7);
  return out;
}
