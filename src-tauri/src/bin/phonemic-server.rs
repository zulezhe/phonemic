//! 无 GUI 调试服务：跑同一套 server/audio 核心，可 --dump 输出 WAV 验证链路。
//! 默认开启 HTTPS（自签 CA 存在数据目录），--no-https 关闭。

use phonemic::audio::{start_output, AudioFifo};
use phonemic::relay;
use phonemic::server::{lan_ip, start_server, ServerConfig};
use phonemic::state::Stats;
use std::sync::Arc;

fn flag_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn terminal_qr(text: &str) -> Option<String> {
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    Some(
        code.render::<char>()
            .quiet_zone(false)
            .dark_color('\u{2588}')
            .light_color(' ')
            .module_dimensions(2, 1)
            .build(),
    )
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();
    let dev = args.iter().any(|a| a == "--dev");
    let no_https = args.iter().any(|a| a == "--no-https");
    let port: u16 = flag_value(&args, "--port").and_then(|v| v.parse().ok()).unwrap_or(9420);
    let https_port: u16 = flag_value(&args, "--https-port").and_then(|v| v.parse().ok()).unwrap_or(9421);
    let dump = flag_value(&args, "--dump");
    let device = flag_value(&args, "--device");

    let stats = Arc::new(Stats::default());
    let fifo = AudioFifo::new(stats.clone());
    if let Some(path) = &dump {
        fifo.enable_dump(path)?;
        println!("WAV 转储: {path}");
    }
    let engine = start_output(device.as_deref(), fifo.clone())?;
    println!("输出设备: {} @ {}Hz x{}", engine.device_name, engine.sample_rate, engine.channels);

    let data_dir = dirs::data_local_dir().map(|d| d.join("phonemic"));
    let cfg = ServerConfig {
        host: "0.0.0.0".into(),
        port,
        https_port: if no_https { 0 } else { https_port },
        data_dir: if no_https { None } else { data_dir },
        lan_ip: lan_ip(),
        dev_no_token: dev,
    };
    let handle = start_server(cfg, stats.clone(), fifo.clone()).await?;
    let ip = lan_ip().map(|i| i.to_string()).unwrap_or_else(|| "127.0.0.1".into());
    let token_note = if dev { "(--dev 已跳过 token)" } else { "" };
    println!("手机引导页: http://{ip}:{}/setup#token={} {token_note}", handle.port, handle.token);
    let mut qr_target = format!("http://{ip}:{}/setup#token={}", handle.port, handle.token);
    if let Some(hp) = handle.https_port {
        println!("手机直连页: https://{ip}:{hp}/#token={}", handle.token);
        qr_target = format!("https://{ip}:{hp}/#token={}", handle.token);
    }
    if let Some(qr) = terminal_qr(&qr_target) {
        println!("\n{qr}");
    }

    // --remote-pair：发起跨网络配对（打印 URL + 终端二维码）
    // kill Sender 必须存活到进程结束（块内声明会被 drop，导致会话被误判"被替换"）
    let mut remote_keep_tx: Option<tokio::sync::watch::Sender<bool>> = None;
    if args.iter().any(|a| a == "--remote-pair") {
        let kp = relay::load_or_create_keypair(&dirs::data_local_dir().unwrap().join("phonemic"))
            .expect("加载远程密钥失败");
        let (tx, rx) = tokio::sync::watch::channel(false);
        remote_keep_tx = Some(tx);
        let url = relay::spawn_remote_pairing(kp, relay::new_pair_code(), stats.clone(), fifo.clone(), rx);
        println!("远程配对 URL: {url}");
        if let Some(qr) = terminal_qr(&url) {
            println!("\n{qr}");
        }
    }

    println!("每 2 秒打印统计，Ctrl-C 退出");
    loop {
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_secs(2)) => {
                let s = stats.snapshot();
                println!(
                    "[{}] 帧:{} 样本:{:.1}k 丢:{}/{} 溢:{} 缓冲:{}ms RTT:{:?} 电平:{:.4}",
                    if s.connected { "直播" } else { "等待" },
                    s.frames_in,
                    s.samples_in as f64 / 1000.0,
                    s.lost_frames,
                    s.frames_in + s.lost_frames,
                    s.underruns,
                    s.buffered_ms,
                    s.rtt_ms,
                    s.level_rms,
                );
            }
            _ = tokio::signal::ctrl_c() => break,
        }
    }
    let _ = handle.shutdown.send(true);
    println!("已退出");
    Ok(())
}
