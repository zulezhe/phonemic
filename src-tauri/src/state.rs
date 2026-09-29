//! 运行统计：跨线程共享（WS 任务 / 音频回调 / UI 轮询），全部用原子量或短临界区。

use parking_lot::Mutex;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

#[derive(Default)]
pub struct Stats {
    connected: AtomicBool,
    mode: Mutex<String>,
    frames_in: AtomicU64,
    samples_in: AtomicU64,
    bytes_in: AtomicU64,
    dropped_frames: AtomicU64,
    lost_frames: AtomicU64,
    underruns: AtomicU64,
    target_buffer_ms: AtomicU64,
    buffered_ms: AtomicU64,
    rtt_ms: Mutex<Option<f64>>,
    level_bits: AtomicU32, // f32 的位表示
    last_frame_at: AtomicU64, // unix ms
}

impl Stats {
    pub fn reset_session(&self) {
        self.connected.store(false, Ordering::Relaxed);
        *self.mode.lock() = String::new();
        self.frames_in.store(0, Ordering::Relaxed);
        self.samples_in.store(0, Ordering::Relaxed);
        self.bytes_in.store(0, Ordering::Relaxed);
        self.dropped_frames.store(0, Ordering::Relaxed);
        self.lost_frames.store(0, Ordering::Relaxed);
        self.underruns.store(0, Ordering::Relaxed);
        self.set_level(0.0);
        self.last_frame_at.store(0, Ordering::Relaxed);
        *self.rtt_ms.lock() = None;
    }

    pub fn set_connected(&self, mode: &str) {
        *self.mode.lock() = mode.to_string();
        self.connected.store(true, Ordering::Relaxed);
    }

    pub fn set_disconnected(&self) {
        self.connected.store(false, Ordering::Relaxed);
        self.set_level(0.0);
    }

    pub fn set_level(&self, rms: f32) {
        self.level_bits.store(rms.to_bits(), Ordering::Relaxed);
    }

    pub fn level(&self) -> f32 {
        f32::from_bits(self.level_bits.load(Ordering::Relaxed))
    }

    pub fn snapshot(&self) -> StatsSnapshot {
        let last = self.last_frame_at.load(Ordering::Relaxed);
        let now = crate::audio::unix_ms();
        StatsSnapshot {
            connected: self.connected.load(Ordering::Relaxed),
            mode: self.mode.lock().clone(),
            frames_in: self.frames_in.load(Ordering::Relaxed),
            samples_in: self.samples_in.load(Ordering::Relaxed),
            bytes_in: self.bytes_in.load(Ordering::Relaxed),
            dropped_frames: self.dropped_frames.load(Ordering::Relaxed),
            lost_frames: self.lost_frames.load(Ordering::Relaxed),
            underruns: self.underruns.load(Ordering::Relaxed),
            target_buffer_ms: self.target_buffer_ms.load(Ordering::Relaxed),
            buffered_ms: self.buffered_ms.load(Ordering::Relaxed),
            rtt_ms: *self.rtt_ms.lock(),
            level_rms: self.level(),
            last_frame_age_ms: if last == 0 { u64::MAX } else { now.saturating_sub(last) },
        }
    }

    // 内部使用：供 server/audio 模块递增
    pub(crate) fn incr_frames(&self, n: u64) {
        self.frames_in.fetch_add(n, Ordering::Relaxed);
    }
    pub(crate) fn add_samples(&self, n: u64) {
        self.samples_in.fetch_add(n, Ordering::Relaxed);
    }
    pub(crate) fn add_bytes(&self, n: u64) {
        self.bytes_in.fetch_add(n, Ordering::Relaxed);
    }
    pub(crate) fn incr_dropped(&self) {
        self.dropped_frames.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn add_lost(&self, n: u64) {
        self.lost_frames.fetch_add(n, Ordering::Relaxed);
    }
    pub(crate) fn incr_underrun(&self) {
        self.underruns.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn set_target_buffer_ms(&self, ms: u64) {
        self.target_buffer_ms.store(ms, Ordering::Relaxed);
    }
    pub(crate) fn set_buffered_ms(&self, ms: u64) {
        self.buffered_ms.store(ms, Ordering::Relaxed);
    }
    pub(crate) fn set_rtt(&self, ms: f64) {
        *self.rtt_ms.lock() = Some(ms);
    }
    pub(crate) fn touch_frame(&self) {
        self.last_frame_at.store(crate::audio::unix_ms(), Ordering::Relaxed);
    }

    pub fn underruns(&self) -> u64 {
        self.underruns.load(Ordering::Relaxed)
    }
    pub fn frames_in(&self) -> u64 {
        self.frames_in.load(Ordering::Relaxed)
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct StatsSnapshot {
    pub connected: bool,
    pub mode: String,
    pub frames_in: u64,
    pub samples_in: u64,
    pub bytes_in: u64,
    pub dropped_frames: u64,
    pub lost_frames: u64,
    pub underruns: u64,
    pub target_buffer_ms: u64,
    pub buffered_ms: u64,
    pub rtt_ms: Option<f64>,
    pub level_rms: f32,
    pub last_frame_age_ms: u64,
}
