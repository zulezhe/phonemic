# PhoneMic — 用手机做电脑的麦克风

把手机变成 Mac / Windows 的系统级麦克风输入：对准手机说话，电脑上的输入法、Zoom、OBS 等任意应用即可选用。

- **手机端零安装**：浏览器打开网页即用（Android / iOS 通用）
- **桌面端 Tauri 2**：Rust 负责音频与网络（低占用、Mac/Windows 同构），Webview 只做界面
- 虚拟麦克风复用开源/免费方案：Mac 用 [BlackHole](https://github.com/ExistentialAudio/BlackHole)（MIT），Windows 用 [VB-CABLE](https://vb-audio.com/Cable/)（免费、不可再分发，App 内引导安装）

```
手机浏览器 (getUserMedia → AudioWorklet → Opus/PCM → WebSocket)
      ↓ wss://局域网 (token 配对)
Tauri Rust 后端 (解码 → 自适应抖动缓冲 → cpal 写入 BlackHole/CABLE)
      ↓
系统虚拟麦克风 ← 输入法 / 会议 / 录音软件直接选用
```

## 快速开始（开发）

前置：Node 18+、Rust 1.75+、Xcode CLT（macOS）、cmake（`brew install cmake`，编译 Opus 用）。

```bash
npm install            # 根目录依赖（桌面 UI + Tauri CLI）
npm --prefix phone install
npm run phone:build    # 构建手机页面（Rust 端内嵌托管）
```

### 开发环境的两种方式

**方式一：独立开发版程序（日常使用/真机联调，推荐）**

```bash
npm run dev:setup      # 一次性：生成 10 年期自签代码签名证书 "PhoneMic Dev" 并信任
npm run dev:app        # 构建"开发版程序" PhoneMic Dev.app 并更新到 ~/Applications 后启动
```

- **开发版与正式包完全隔离**：`PhoneMic Dev.app`（bundle id `dev.phonemic.desktop.dev`，
  固定证书签名）是开发期间唯一的迭代对象；正式包 `PhoneMic.app + DMG` 只在想发布时用
  `npm run tauri:build` 构建
- 授权一次永久生效：签名固定，`dev:app` 通过脚本静默替换 `~/Applications/PhoneMic Dev.app`，
  不会弹"安装/替换"对话框（换 bundle id 后的首次运行可能再弹一次权限，之后稳定）
- 配对 token 与 TLS CA 持久化在共享数据目录，手机端书签/证书信任不随迭代失效

**方式二：热重载开发（改代码时用）**

```bash
npm run tauri:dev      # 前端 HMR + Rust 改动自动重编译（Rust 重编译后可能重新弹一次权限）
```

**无 GUI 调试**：`npm run server:dev -- --dump /tmp/pm.wav`（终端二维码 + 统计 + WAV 转储）。

三种方式共用数据目录 `~/Library/Application Support/phonemic/`（CA、服务器证书、配对 token；
删除即全部重置）。

### 真机使用（M2 起）

1. 电脑与手机连同一 Wi-Fi，启动 App（或 `npm run server:dev`）
2. 手机扫桌面二维码 → 浏览器若提示"不是私密连接"，点 **高级 → 继续访问** → 允许麦克风 → 开始说话
3. （可选）想永久消除"继续访问"提示：打开界面上的引导页链接，一次性安装 CA 证书
4. 电脑端装了 BlackHole 时自动作为输出：任意应用选择 **BlackHole 2ch** 作为麦克风即可
   （安装：`brew install --cask blackhole-2ch`）

iPhone/Mac 信任证书后也可以直接访问 `https://phonemic.local:9421`（mDNS 自动发现）。
配对 token 持久化，手机可收藏直连链接，无需每次扫码。

## 里程碑

- [x] **M0** 脚手架：monorepo、Tauri 2 + Vite、phone 工程、协议文档
- [x] **M1** 本机全链路：浏览器采集 → WS → 解码 → 抖动缓冲 → 本机扬声器，统计面板
- [x] **M2** 局域网 + Mac 集成：自签 CA + HTTPS、QR 配对、mDNS（phonemic.local）、
      BlackHole 检测与自动选择、输出设备切换、手机引导页
- [ ] **M3** Windows：VB-CABLE 引导、安装包
- [ ] **M4** 打磨：PWA、保活、自动重连、增益、i18n、CI
- [ ] **M5** v0.1 发布

协议细节见 [docs/protocol.md](docs/protocol.md)。测试：`cargo test --manifest-path src-tauri/Cargo.toml`（12 项）；
E2E：`scripts/e2e_headless.sh`（本机链路）、`scripts/e2e_lan.sh`（HTTPS + 引导页 + 证书链校验）。

### 证书说明

首次启动在数据目录生成自签 CA 与服务器证书（SAN：局域网 IP / 127.0.0.1 / phonemic.local）。
换网络导致 IP 变化时自动重签服务器证书，CA 长期不变——手机只需信任一次。
数据目录统一为 `~/Library/Application Support/phonemic/`（tauri dev、签名 dev 包、调试 bin 共用）。

## 已知限制（web 手机端的代价）

- **息屏/切后台会停采集**（iOS Safari 尤其严格）。页面用 Wake Lock + 静音音频尽量保活，语音输入的短会话场景可用；需要长时挂机请关注后续原生 App 计划。
- 局域网 HTTPS 需要手机一次性信任自签 CA（M2 提供分步引导）。
- WebSocket 走 TCP，WiFi 抖动时可能出延迟尖峰；实测不佳再引入 WebRTC/UDP。

## License

MIT（后续在仓库根添加 LICENSE）。BlackHole 为 MIT；VB-CABLE 由用户自行从官网安装。
