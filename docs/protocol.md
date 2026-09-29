# PhoneMic 传输协议 v1

手机浏览器 ↔ 桌面端（Tauri/Rust）之间通过单条 WebSocket 通信。音频统一 **48kHz 单声道**。

## 连接

```
http://HOST:9420/ws?token=<16进制配对码>     # 本机调试 / chrome://flags 白名单场景
wss://HOST:9421/ws?token=<16进制配对码>     # 局域网 HTTPS（自签 CA）
```

- token 由桌面端生成，通过 QR / 界面展示；`PHONEMIC_DEV=1` 或 `--dev` 跳过校验（仅调试）。
- 页面侧从 `location.hash` 中的 `token=xxx` 读取，附加到 WS 查询参数。
- HTTP(9420) 与 HTTPS(9421) 上都有 `/ws` 与 `/stats.json`；HTTP 额外提供
  `/setup`（手机引导页，端口已注入）、`/ca.pem`、`/ios.mobileconfig`。
- 手机页在非安全上下文（HTTP + 非本机）自动跳转 `/setup`。
- mDNS：注册 `_phonemic._tcp.local.`，主机名 `phonemic.local`；证书 SAN 包含
  局域网 IP、127.0.0.1 与 `phonemic.local`，IP 变化自动重签（CA 不变）。

## 文本帧（JSON）

方向 C=手机→桌面端，S=桌面端→手机：

| 消息 | 方向 | 载荷 | 说明 |
|---|---|---|---|
| `hello` | C | `mode`: `"opus"\|"pcm-f32"`，`sampleRate`: 48000，`channels`: 1 | 连接后首条，10s 超时 |
| `welcome` | S | `ok`, `mode`（最终确认的模式）, `message?` | 拒绝时 `ok=false` 并断开 |
| `ping` | C | `t`: `performance.now()` | 每 1s |
| `pong` | S | 原样回 `t` | 手机据此算 RTT |
| `report` | C | `rttMs?` | 手机上报平滑 RTT |
| `bye` | C | – | 主动停止 |

字段命名 camelCase（`rename_all = "camelCase"`）。

## 二进制音频帧

```
偏移  长度  含义
0     1    版本(高4bit, =1) | 类型(低4bit)
1     2    seq  u16 LE      （每连接从 0 递增，回绕）
3     4    ts   u32 LE (ms) （页面启动起的毫秒）
7     …    payload
```

类型：

| 值 | payload | 说明 |
|---|---|---|
| 1 `pcm-f32` | 960 × f32-LE（20ms，3840 字节） | 基线模式，所有浏览器可用，约 1.5 Mbps |
| 2 `opus` | 一个 Opus 包（48kHz/mono/20ms，≈64kbps） | WebCodecs `AudioEncoder` 可用时优选 |

### 模式协商

手机端探测 `AudioEncoder.isConfigSupported({codec:"opus",…})`：支持则 `mode="opus"`，否则 `"pcm-f32"`。桌面端按 `hello.mode` 准备解码器，并在 `welcome.mode` 中回确认。

### 抖动与缓冲（桌面端）

- FIFO 单声道样本队列，目标水位 40–150ms（初始 60ms），超过 300ms 上限时整帧丢弃。
- cpal 回调欠供时补零并计 `underrun`；underrun 后 2s 内目标 +50ms（封顶），30s 平稳 -10ms（下限）。
- seq 大幅后退（< -8）或前跳（> 64）判定为断流/重启：清空 FIFO 重新对齐。
- 序号跳变 1..64 之间按丢帧计入统计。

## 安全

- 局域网 HTTPS：桌面端首次启动生成自签 CA（长期保存在数据目录）+ 服务器证书；
  手机通过引导页一次性信任（iOS 描述文件 / Android 用户 CA / chrome://flags 白名单三种路径）。
- token 防止局域网内其他设备接入；错误 token 收到 `welcome.ok=false` 后断开。
- `/stats.json` 暴露统计（不含 token），仅限局域网。
