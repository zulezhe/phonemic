//! 音频输出：网络侧写入 FIFO（含自适应抖动缓冲），cpal 回调拉取并播放到目标设备。

use crate::state::Stats;
use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{Device, SampleFormat, StreamConfig, SupportedStreamConfig};
use parking_lot::Mutex;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// 全链路统一的采样率：手机端 48kHz 采集，Rust 侧按需重采样到输出设备。
pub const STREAM_RATE: u32 = 48_000;
const MIN_TARGET_MS: u64 = 40;
const MAX_TARGET_MS: u64 = 150;
const START_TARGET_MS: u64 = 60;

pub fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 单声道样本 FIFO：生产者是 WS 接收任务，消费者是 cpal 实时回调。
pub struct AudioFifo {
    q: Mutex<VecDeque<f32>>,
    target_samples: AtomicU64,
    last_adjust_ms: AtomicU64,
    last_seen_underruns: AtomicU64,
    last_push_ms: AtomicU64,
    stats: Arc<Stats>,
    dump: Mutex<Option<hound::WavWriter<std::io::BufWriter<std::fs::File>>>>,
}

impl AudioFifo {
    pub fn new(stats: Arc<Stats>) -> Arc<Self> {
        let f = Arc::new(Self {
            q: Mutex::new(VecDeque::with_capacity(STREAM_RATE as usize / 2)),
            target_samples: AtomicU64::new(ms_to_samples(START_TARGET_MS)),
            last_adjust_ms: AtomicU64::new(unix_ms()),
            last_seen_underruns: AtomicU64::new(0),
            last_push_ms: AtomicU64::new(0),
            stats,
            dump: Mutex::new(None),
        });
        f.stats.set_target_buffer_ms(START_TARGET_MS);
        f
    }

    pub fn len(&self) -> usize {
        self.q.lock().len()
    }

    pub fn flush(&self) {
        self.q.lock().clear();
        self.stats.set_buffered_ms(0);
    }

    /// 调试/测试用：把进入 FIFO 的样本同步写入 WAV。
    pub fn enable_dump(&self, path: &str) -> Result<()> {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: STREAM_RATE,
            bits_per_sample: 32,
            sample_format: hound::SampleFormat::Float,
        };
        let writer = hound::WavWriter::create(path, spec).with_context(|| path.to_string())?;
        *self.dump.lock() = Some(writer);
        Ok(())
    }

    /// 写入一段解码后的单声道样本；过满时整帧丢弃（保持低延迟优于完整交付）。
    pub fn push(&self, samples: &[f32]) -> bool {
        self.last_push_ms.store(unix_ms(), Ordering::Relaxed);
        self.maybe_adjust_target();
        let max = ms_to_samples(300) as usize;
        let target = self.target_samples.load(Ordering::Relaxed) as usize;
        let mut q = self.q.lock();
        if q.len() + samples.len() > max {
            self.stats.incr_dropped();
            return false;
        }
        // 网络空档后 FIFO 见底：垫一层静音把缓冲拉回目标水位
        if q.is_empty() && samples.len() < target / 2 {
            q.extend(std::iter::repeat(0.0f32).take(target / 2 - samples.len()));
        }
        if let Some(w) = self.dump.lock().as_mut() {
            for s in samples {
                let _ = w.write_sample(*s);
            }
        }
        q.extend(samples.iter().copied());
        true
    }

    /// 回调侧拉取 n 个样本；不足处补零并记一次 underrun。返回是否完整。
    /// 空闲（超过 500ms 无数据推入）时的欠供不计 underrun，避免污染自适应缓冲。
    pub fn pull(&self, out: &mut [f32]) -> bool {
        let mut q = self.q.lock();
        let avail = q.len().min(out.len());
        for slot in out.iter_mut().take(avail) {
            *slot = q.pop_front().unwrap();
        }
        if avail < out.len() {
            let idle = unix_ms().saturating_sub(self.last_push_ms.load(Ordering::Relaxed)) > 500;
            if !idle {
                self.stats.incr_underrun();
            }
            for slot in out.iter_mut().skip(avail) {
                *slot = 0.0;
            }
        }
        self.stats.set_buffered_ms(samples_to_ms(q.len() as u64));
        avail == out.len()
    }

    /// 自适应目标缓冲：出现 underrun 后 2s 加 50ms（封顶）；30s 平稳减 10ms（下限）。
    fn maybe_adjust_target(&self) {
        let now = unix_ms();
        let underruns = self.stats.underruns();
        let last_underruns = self.last_seen_underruns.swap(underruns, Ordering::Relaxed);
        let last_adjust = self.last_adjust_ms.load(Ordering::Relaxed);
        let mut target = self.target_samples.load(Ordering::Relaxed);
        if underruns > last_underruns && now.saturating_sub(last_adjust) > 2_000 {
            target = (target + ms_to_samples(50)).min(ms_to_samples(MAX_TARGET_MS));
            self.target_samples.store(target, Ordering::Relaxed);
            self.last_adjust_ms.store(now, Ordering::Relaxed);
        } else if now.saturating_sub(last_adjust) > 30_000 && target > ms_to_samples(MIN_TARGET_MS) {
            target -= ms_to_samples(10);
            self.target_samples.store(target, Ordering::Relaxed);
            self.last_adjust_ms.store(now, Ordering::Relaxed);
        }
        self.stats
            .set_target_buffer_ms(samples_to_ms(target));
    }
}

fn ms_to_samples(ms: u64) -> u64 {
    ms * STREAM_RATE as u64 / 1000
}
fn samples_to_ms(n: u64) -> u64 {
    n * 1000 / STREAM_RATE as u64
}

/// 输出引擎句柄：真正的 cpal 流由专属线程持有（CoreAudio 的 Stream 非 Send），
/// Drop 时通过 channel 通知线程退出并停止播放。
pub struct OutputEngine {
    stop: Option<std::sync::mpsc::Sender<()>>,
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: usize,
}

impl Drop for OutputEngine {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
    }
}

/// 启动输出。device_name 为 None 用默认设备；子串匹配（如 "BlackHole 2ch"、"CABLE Input"）。
pub fn start_output(device_name: Option<&str>, fifo: Arc<AudioFifo>) -> Result<OutputEngine> {
    let host = cpal::default_host();
    let device = match device_name {
        Some(want) => host
            .output_devices()?
            .find(|d| d.name().map(|n| n.contains(want)).unwrap_or(false))
            .ok_or_else(|| anyhow!("找不到输出设备：{want}"))?,
        None => host
            .default_output_device()
            .ok_or_else(|| anyhow!("系统没有可用输出设备"))?,
    };
    let name = device.name().unwrap_or_default();
    let supported = pick_config(&device)?;
    let cfg: StreamConfig = supported.clone().into();
    if supported.sample_format() != SampleFormat::F32 {
        return Err(anyhow!("设备 {name} 不支持 f32 输出（{:?}）", supported.sample_format()));
    }

    let (meta_tx, meta_rx) = std::sync::mpsc::channel::<Result<(u32, usize)>>();
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let fifo_out = fifo.clone();
    std::thread::Builder::new()
        .name("phonemic-output".into())
        .spawn(move || {
            let channels = cfg.channels.max(1) as usize;
            let mut resampler = Resampler::new(STREAM_RATE, cfg.sample_rate.0);
            let mut scratch: Vec<f32> = Vec::new();
            let err_fn = |e| tracing::warn!("输出流错误: {e}");
            let stream = match device.build_output_stream(
                &cfg,
                move |data: &mut [f32], _| {
                    let frames = data.len() / channels;
                    scratch.clear();
                    scratch.resize(frames, 0.0);
                    resampler.process(&fifo_out, &mut scratch);
                    for (i, frame) in data.chunks_mut(channels).enumerate() {
                        let s = scratch[i];
                        for ch in frame {
                            *ch = s;
                        }
                    }
                },
                err_fn,
                None,
            ) {
                Ok(s) => s,
                Err(e) => {
                    let _ = meta_tx.send(Err(anyhow!("构建输出流失败: {e}")));
                    return;
                }
            };
            if let Err(e) = stream.play() {
                let _ = meta_tx.send(Err(anyhow!("启动播放失败: {e}")));
                return;
            }
            let _ = meta_tx.send(Ok((cfg.sample_rate.0, channels)));
            let _ = stop_rx.recv(); // 阻塞到 Drop
        })
        .map_err(|e| anyhow!("创建输出线程失败: {e}"))?;

    let (rate, channels) = meta_rx
        .recv()
        .map_err(|_| anyhow!("输出线程未响应"))??;
    tracing::info!("输出设备: {name} @ {rate}Hz x{channels}");
    Ok(OutputEngine { stop: Some(stop_tx), device_name: name, sample_rate: rate, channels })
}

pub fn list_output_devices() -> Vec<String> {
    cpal::default_host()
        .output_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default()
}

/// 在设备支持的配置里挑最接近 48kHz 的 f32 配置。
fn pick_config(device: &Device) -> Result<SupportedStreamConfig> {
    let mut ranges: Vec<_> = device.supported_output_configs()?.collect();
    ranges.sort_by_key(|r| {
        let rate = r.min_sample_rate().0;
        let dist = (i64::from(rate) - i64::from(STREAM_RATE)).abs();
        (dist, r.sample_format() != SampleFormat::F32)
    });
    let range = ranges
        .into_iter()
        .find(|r| r.sample_format() == SampleFormat::F32)
        .ok_or_else(|| anyhow!("设备没有 f32 输出配置"))?;
    // 区间包含 48000 就用它，否则取离 48000 最近的端点
    let rate = if range.min_sample_rate().0 <= STREAM_RATE && range.max_sample_rate().0 >= STREAM_RATE {
        STREAM_RATE
    } else {
        let (lo, hi) = (range.min_sample_rate().0, range.max_sample_rate().0);
        if (i64::from(lo) - i64::from(STREAM_RATE)).abs() <= (i64::from(hi) - i64::from(STREAM_RATE)).abs() {
            lo
        } else {
            hi
        }
    };
    Ok(range.with_sample_rate(cpal::SampleRate(rate)))
}

/// 线性重采样（48k 流 → 设备采样率）。采样率一致时直通。
struct Resampler {
    step: f64,
    pos: f64, // 在源样本坐标系中的浮点读位置（相对 held 头部）
    held: Vec<f32>,
    scratch: Vec<f32>,
}

impl Resampler {
    fn new(src: u32, dst: u32) -> Self {
        Self { step: f64::from(src) / f64::from(dst), pos: 0.0, held: Vec::new(), scratch: Vec::new() }
    }

    fn process(&mut self, fifo: &AudioFifo, out: &mut [f32]) {
        if (self.step - 1.0).abs() < 1e-12 {
            fifo.pull(out);
            return;
        }
        let need = self.pos as usize + (out.len() as f64 * self.step).ceil() as usize + 2;
        while self.held.len() < need {
            self.scratch.clear();
            self.scratch.resize(1024, 0.0);
            fifo.pull(&mut self.scratch);
            self.held.extend_from_slice(&self.scratch);
        }
        for slot in out.iter_mut() {
            let i = self.pos.floor() as usize;
            let frac = (self.pos - i as f64) as f32;
            let a = self.held.get(i).copied().unwrap_or(0.0);
            let b = self.held.get(i + 1).copied().unwrap_or(a);
            *slot = a + (b - a) * frac;
            self.pos += self.step;
        }
        let consumed = self.pos.floor() as usize;
        if consumed > 0 {
            let n = consumed.min(self.held.len());
            self.held.drain(0..n);
            self.pos -= n as f64;
        }
    }
}

/// Opus 解码封装：48kHz 单声道，输出 f32。
pub struct OpusDecoder {
    dec: opus::Decoder,
    buf: Vec<i16>,
}

impl OpusDecoder {
    pub fn new() -> Result<Self> {
        Ok(Self {
            dec: opus::Decoder::new(STREAM_RATE, opus::Channels::Mono)
                .map_err(|e| anyhow!("opus decoder: {e}"))?,
            buf: vec![0i16; 5760],
        })
    }

    pub fn decode(&mut self, packet: &[u8]) -> Result<Vec<f32>> {
        let n = self
            .dec
            .decode(packet, &mut self.buf, false)
            .map_err(|e| anyhow!("opus decode: {e}"))?;
        Ok(self.buf[..n].iter().map(|&s| f32::from(s) / 32768.0).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fifo_pull_and_underrun() {
        let stats = Arc::new(Stats::default());
        let fifo = AudioFifo::new(stats.clone());
        let samples = vec![0.5f32; 480];
        assert!(fifo.push(&samples));
        // 空队列首帧：垫的静音（半水位 1440 − 480 = 960）排在真实样本前面
        assert_eq!(fifo.len(), 1440);
        let mut out = [1.0f32; 1440];
        assert!(fifo.pull(&mut out));
        assert!(out[..960].iter().all(|s| *s == 0.0), "前段应为垫底静音");
        assert!(out[960..].iter().all(|s| *s == 0.5), "后段应为真实样本");
        // 队列已空 → underrun 补零
        let mut out = [1.0f32; 100];
        assert!(!fifo.pull(&mut out));
        assert_eq!(stats.underruns(), 1);
        assert!(out.iter().all(|s| *s == 0.0));
    }

    #[test]
    fn fifo_drop_when_full() {
        let stats = Arc::new(Stats::default());
        let fifo = AudioFifo::new(stats);
        let big = vec![0.1f32; ms_to_samples(300) as usize];
        assert!(fifo.push(&big)); // 填到上限
        assert!(!fifo.push(&[0.0])); // 超限丢弃
    }

    #[test]
    fn opus_roundtrip() {
        let mut enc = opus::Encoder::new(STREAM_RATE, opus::Channels::Mono, opus::Application::Voip).unwrap();
        let mut dec = OpusDecoder::new().unwrap();
        let input: Vec<i16> = (0..960)
            .map(|i| (((i as f32) * 0.05).sin() * 8000.0) as i16)
            .collect();
        let mut packet = vec![0u8; 4000];
        let n = enc.encode(&input, &mut packet).unwrap();
        let out = dec.decode(&packet[..n]).unwrap();
        assert_eq!(out.len(), 960);
        assert!(out.iter().any(|s| s.abs() > 0.05), "解码结果不应为静音");
    }

    #[test]
    fn resampler_passthrough_and_ratio() {
        let stats = Arc::new(Stats::default());
        let fifo = AudioFifo::new(stats);
        assert!(fifo.push(&vec![0.25f32; 4800]));
        let mut out = [0.0f32; 4800];
        let mut r = Resampler::new(48000, 48000);
        r.process(&fifo, &mut out);
        assert!(out.iter().all(|s| *s == 0.25));

        let stats2 = Arc::new(Stats::default());
        let fifo2 = AudioFifo::new(stats2);
        assert!(fifo2.push(&vec![0.5f32; 4800]));
        let mut r2 = Resampler::new(48000, 24000);
        let mut out2 = [0.0f32; 2400];
        r2.process(&fifo2, &mut out2);
        assert!(out2.iter().all(|s| *s == 0.5));
    }
}
