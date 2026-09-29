// 与 shared/protocol.ts / src-tauri/src/protocol.rs 一致的帧构造（PCM 模式）
export function buildAudioFramePcm(seq, tsMs, f32) {
  const out = new Uint8Array(7 + f32.length * 4);
  out[0] = (1 << 4) | 1; // v1 | pcm-f32
  new DataView(out.buffer).setUint16(1, seq & 0xffff, true);
  new DataView(out.buffer).setUint32(3, tsMs >>> 0, true);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < f32.length; i++) dv.setFloat32(7 + i * 4, f32[i], true);
  return out;
}
