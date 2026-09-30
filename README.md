# PhoneMic — Use your phone as your computer's microphone

**手机扫码，即成 Mac/Windows 的系统级麦克风。** Scan a QR code and your phone becomes a system-wide microphone — zero install on the phone, works across networks.

[中文说明](#中文说明)

## Features

- **Zero-install phone side** — a web page, works on both Android and iOS browsers
- **Cross-network by default** — pairing goes through a Cloudflare relay (E2E-encrypted); on the same network the phone automatically upgrades to a low-latency direct link
- **System microphone** — virtual audio device (BlackHole on macOS, embedded one-click installer; VB-CABLE on Windows)
- **Opus / PCM adaptive streaming**, ~6 ms LAN latency, auto-reconnect, jitter buffer
- Desktop app built with **Tauri 2** (Rust audio path), relay is a ~150-line Cloudflare Worker (free tier), **self-hostable**

**Self-host the relay**: `cd relay-server && docker compose up -d --build`, then point the desktop app at it with `PHONEMIC_RELAY_HOST` — see [docs/self-hosting.md](docs/self-hosting.md)

## Architecture

```
Phone browser (getUserMedia → AudioWorklet → Opus/PCM)
   │  ① scan → cloud relay (E2EE, works anywhere)          relay.dyzyzj.top
   │  ② same network → auto-upgrade to LAN direct (wss, ~6ms)
   ▼
Desktop (Tauri/Rust: decrypt → decode → jitter buffer → cpal)
   ▼
Virtual microphone (BlackHole 2ch) → any app: dictation, Zoom, OBS…

Cloud relay (self-host alternative): Cloudflare Workers + Durable Objects
```

Protocol docs: [docs/protocol.md](docs/protocol.md) · Relay design: [docs/relay-design.md](docs/relay-design.md)

## Status

- ✅ M0–M2: LAN mode + virtual mic (verified on real devices, WeChat dictation)
- ✅ P3: cloud relay (E2EE), persistent pairing, race upgrade LAN⇄relay
- ⏳ P1: Windows client · P5: WebRTC hole-punching, PC→phone audio, USB

## Dev quick start (macOS)

Prereqs: Node 18+, Rust 1.75+, Xcode CLT, cmake (`brew install cmake`).

```bash
npm install && npm --prefix phone install
npm run phone:build        # build the phone page (embedded by the Rust server)
npm run tauri:dev          # desktop app + LAN servers (HTTP 9420 / HTTPS 9421)
```

Stable dev app (fixed signing identity, silent updates, no re-auth prompts):

```bash
npm run dev:setup   # one-time: create a 10-year self-signed code-sign cert
npm run dev:app     # build "PhoneMic Dev.app" → ~/Applications, signed, auto-launch
```

Relay (Cloudflare): `relay/` — `npm run deploy` (wrangler). Tests: `cargo test --manifest-path src-tauri/Cargo.toml`; E2E: `scripts/e2e_headless.sh`, `relay/test/*.mjs`.

## License

Core: to be decided (currently private). BlackHole is MIT (bundled with its license); VB-CABLE must be installed by users from the official site.

---

# 中文说明

**把手机变成电脑的系统级麦克风**：扫码即用、跨网络可用、端到端加密；Mac 端一键安装 BlackHole 虚拟声卡，微信/输入法/会议软件任意应用可选。

- 手机端零安装（网页，安卓/iOS 通用）；默认走云端中继（免费层），同一网络自动切换局域网直连（~6ms）
- 桌面端 Tauri 2（Rust 音频链路：解码 → 自适应抖动缓冲 → 虚拟麦克风）
- 中继 ~150 行 Cloudflare Worker，支持 Docker 自托管；协议与设计文档见 `docs/`
- **自托管中继**：`cd relay-server && docker compose up -d --build`，桌面端设 `PHONEMIC_RELAY_HOST` 即可切换，见 [docs/self-hosting.md](docs/self-hosting.md)
- 商业模式：开源核心 + 官方免费中继 + 自托管（详见路线图）

```bash
npm install && npm --prefix phone install && npm run phone:build
npm run tauri:dev        # 开发调试
npm run dev:app          # 稳定开发版（独立签名、静默更新）
```

已完成：本机/局域网/跨网络全链路（真机验证微信语音输入）；进行中：Windows 端、WebRTC 打洞、电脑→手机反向音频。
