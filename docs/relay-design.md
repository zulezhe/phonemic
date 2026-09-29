# P3 跨网络连接设计：三级传输 + 默认中继 + 赛马升级

> 状态：设计定稿（2026-09-29）。本文件是 CF Worker 中继与 Rust 自托管中继两个实现的共同蓝图。
> 前置阅读：[protocol.md](protocol.md)（本地会话协议）。

## 0. 目标与非目标

**目标**
- 手机与电脑跨网络（不同 Wi-Fi / 蜂窝）可连：扫码即用，无感于网络拓扑
- 默认走云端中继保证"永远秒连"；后台并行探测局域网直连与 WebRTC 打洞，谁通切谁（降延迟、省中继流量）
- 中继只见密文（E2EE）；自托管者可用 Docker 跑同协议的 Rust 中继
- 官方服务跑在 Cloudflare 免费层（Workers + Durable Objects + Pages），超限兜底 $5/月

**非目标**
- 多设备同时会话（单会话，新连接顶旧）
- 账号体系（v1 匿名 + 设备级限流）
- TURN 自建（打洞失败回落 WS 中继，即"中继即 TURN"）

## 1. 总体架构

```
                     ┌────────────────────────────┐
                     │  Cloudflare（官方）/ Rust（自托管）  │
                     │  Pages: m.dyzyzj.top 手机页       │
                     │  Worker+DO: relay.dyzyzj.top     │
                     └──────┬───────────────┬───────┘
              ①wss 注册/透传│               │②wss 配对/透传
                    ┌──────┴──────┐   ┌────┴─────┐
                    │  桌面端 App  │   │ 手机浏览器 │
                    │ (Rust/Tauri)│   │  (PWA页)  │
                    └──────┬──────┘   └────┬─────┘
           ③ 后台赛马升级：│                   │
              ③a 局域网 wss │←──── ③b WebRTC DataChannel ─→│（P5，信令走中继）
```

连接策略（**中继优先，升级赛马**）：

1. 扫码 → 手机页加载（Pages，正规 TLS）→ 立即连中继 → 1 秒内出声（保底体验）
2. 手机页后台并行探测：③a 局域网候选逐个试连（800ms 超时）；③b 打洞（P5）
3. 任一更优路径就绪 → 会话内 `PathUpgrade` 握手 → 无感切换 → 关闭中继连接
4. 优先级：`LocalWs(≈<10ms) > DataChannel(直连) > RelayWs(保底)`

## 2. 域名与部署形态

| 子域 | 承载 | 说明 |
|---|---|---|
| `m.dyzyzj.top` | Pages | 远程模式手机页 + 未来官网/下载页 |
| `relay.dyzyzj.top` | Worker(+DO) | WS 端点，见 §4 |
| （本地模式） | 桌面端自托管 | 与现在完全一致，不依赖云端 |

自托管：`docker compose up` 一个 Rust 二进制（同协议），端口自定，TLS 由 Caddy/反代负责；
手机页可用官方 Pages 或随 Rust 服务一起托管。二维码内容由桌面端配置决定指向哪个中继。

## 3. 配对模型（PairingRoom）

**核心抽象：一次性配对房间**。Durable Object（或 Rust 端一个 HashMap 项）以 `pair_code` 为键，
生命周期 = 配对+会话：

```
桌面端                                 Relay(Room)                         手机
  │ 1. WS 连 /ws/pair/<code>            │                                  │
  │    register{pub_key}                │ room 创建，等待第二方（60s TTL）    │
  │                                     │ ←2. WS 连 /ws/pair/<code>         │
  │                                     │    pair{}                         │
  │ ←3. peer-joined{peer_pub_key}────── │ 双方到齐，管道建立                  │
  │ 4. E2EE 握手（经 relay，见 §6）       │ ───────────────────────────────→ │
  │ 5. 音频帧双向透传（密文）             │ ←──────── 密文帧 ───────────────→ │
```

- `pair_code`：桌面端生成的 32B 随机 base64url（一次性，60 秒有效，用后即焚）
- 二维码内容：`https://m.dyzyzj.top/#p=<pair_code>&k=<desktop_pub_key_b64>`
  （`k` = 桌面端 X25519 公钥，经二维码带外信道传递，防 relay MITM，见 §6）
- 桌面端每次发起配对生成新 code；同一时间仅一个活动房间；新房间出现时旧房间作废
- `device_id`（首次安装生成、持久化）不参与配对，仅用于限流统计

## 4. 中继线协议（relay wire protocol）

WS 端点：`wss://relay.dyzyzj.top/ws/pair/<pair_code>`（桌面与手机同端点，先到先注册）

**文本控制帧（JSON，camelCase）：**

| 方向 | 消息 | 字段 | 说明 |
|---|---|---|---|
| 双方→relay | `hello` | `role: "desktop" \| "phone"`, `v: 1` | 连接后首帧 |
| relay→双方 | `roomState` | `state: "waiting" \| "ready"`, `peerKey?` | 对方公钥在 ready 时下发（仅供回退校验，信任源是二维码） |
| relay→双方 | `error` | `code`, `message` | 如 `EXPIRED` / `FULL` / `RATE_LIMITED` |
| relay→双方 | `bye` | `reason` | 会话/房间结束 |

**二进制帧：原样透传，relay 不解析。** 帧格式沿用 protocol.md 并扩展一个首字节高位：

```
[1B: 0x80 | existing_header ...]  → 会话级封装帧（加密负载）
bit7 = 1 表示"经中继的会话帧"，低 7 位与现行协议一致（v1|type|seq|ts|payload）
```

- 本地 wss 路径继续用现行帧（bit7=0，TLS 已加密）
- DataChannel 路径（P5）沿用 bit7=0（DTLS 已加密）
- 中继路径音频/控制负载统一 AES-GCM（§6）

**活性**：沿用 1s ping/pong（文本帧），relay 30s 无活动断开。**限流（v1）**：每 IP 并发 ≤2 房间；单会话 ≤4h；每 device_id 每日中继 ≤120min（DO SQLite 计数，超限返回 `RATE_LIMITED`）。数值全部环境变量可配。

## 5. 桌面端 Transport 抽象（P3a，先行的重构）

```rust
pub enum TransportKind { LocalWs, RelayWs, P2pDataChannel /* P5 */ }

#[async_trait]
pub trait AudioTransport: Send {
    fn kind(&self) -> TransportKind;
    /// 接收方向：解出会话帧（去传输层封装、解密归一化）
    async fn recv(&mut self) -> Option<SessionFrame>;
    /// 发送方向：会话帧封装+（中继路径）加密后发出
    async fn send(&mut self, f: &SessionFrame) -> Result<()>;
    async fn close(&mut self, reason: &str);
}

pub struct Session { active: Box<dyn AudioTransport>, ... }  // 解码/jitter/输出与传输解耦
```

- 现有 axum WS 会话重构为 `LocalWs` 实现；协议解析逻辑移入 `Session`
- `Session::switch(new_transport)`：新路径就绪 → 对端发 `PathUpgradeAck` → 原子替换 → 旧路径 `bye`
- 手机端对称：`Sender` 层按当前路径分发，切换 = 换目标 + seq 连续

## 6. E2EE（仅中继路径；本地 TLS / DataChannel DTLS 已加密）

- **桌面静态密钥**：P-256 密钥对，安装时生成、持久化；公钥进二维码（带外可信）
- **每会话前向保密**：手机生成临时 P-256 对；`shared = ECDH(phone_ephemeral, desktop_static)`；
  `K_session = HKDF-SHA256(shared, salt=pair_code, info="phonemic/v1")`
- 手机→桌面首帧（明文经 relay）：`{type:"e2eeInit", pub}`（sec1 65B base64url）
- 之后**音频二进制帧**加密：byte0 |= 0x80，payload = [12B nonce][AES-GCM ct||tag]（+28B/帧 ≈ +1.4kbps）
- 文本控制帧（hello/welcome/ping/e2eeInit/roomState）明文——不含敏感内容，relay 原样透传
- 曲线选择：P-256 而非 X25519（微信内置浏览器等国内内核 WebCrypto 普遍缺 X25519，P-256 全平台保底）
- 手机端 WebCrypto；桌面端 Rust `p256` + `hkdf` + `aes-gcm`；互操作测试向量见
  `relay/test/gen_interop_vector.mjs` + `crypto.rs::webcrypto_interop`
- relay/MITM 防护：公钥来自二维码而非 relay 下发 ✓

## 7. 路径升级（赛马）

手机页在中继会话建立后启动探测（不阻塞音频）：

1. **LAN 候选**：二维码附桌面局域网候选列表（IP:9421 + `phonemic.local:9421`），逐个 `wss` 试连（800ms 超时，
   自签证书环境手机此前已装 CA 或点"继续访问"——探测失败静默放弃）
2. **打洞（P5）**：经中继信令通道交换 `webrtcSignal{sdP/candidate}` → ICE → DataChannel
3. 一期实现（已上线）：手机页 welcome 后探测局域网（hash 中的 `&l=ip:port&t=token`），
   直连 welcome 成功即**整体切换发送通道**并静默关闭中继连接——切换有 100~300ms 音频间隙，
   桌面侧零改动（旧会话自然结束、新会话自然开始）
4. 二期（如间隙影响体验再做）：会话级 `pathUpgrade/pathUpgradeAck` 无缝迁移（seq 续接）

## 8. P5 预留（打洞）

- 信令消息类型本版即定义：`webrtcOffer{sdP}` / `webrtcAnswer{sdP}` / `webrtcCandidate{cand}`（会话控制帧）
- STUN：公共服务器列表（`stun.l.google.com:19302` 等），不依赖 CF
- DataChannel 承载与 LocalWs 相同帧格式（bit7=0，DTLS 加密）
- 前置：webrtc-rs 集成 spike（1-2 天）验证 DataChannel 稳定性与编译产物体积

## 9. 安全与隐私清单

- relay 只见密文；Pages/Worker 无用户内容存储；DO 状态 60s TTL
- 配对码一次性 + 60s + 二维码含公钥（防 MITM/重放）
- 限流防滥用（§4）；桌面端"会话来源"UI 显示当前路径与延迟（用户可感知）
- 本地模式不依赖、不上报云端（仅发起远程配对时连接 relay）

## 10. 交付切分

| 步骤 | 内容 | 验收 |
|---|---|---|
| **P3a** | Transport 抽象重构，现有功能迁入 | cargo 测试 + 本机/局域网 E2E 全绿，行为无变化 |
| **P3b** | CF Worker+DO 中继（TS，~200 行）+ 部署脚本 + Pages 手机页 | wrangler dev 本地跑通双端透传 |
| **P3c** | 桌面端 WsRelay + E2EE + 手机页远程模式 | 手机蜂窝网络实测跨网通话；中继日志只见密文 |
| **P3d** | 赛马升级（LAN 探测 + 切换握手）+ 打洞信令字段 | 同一网络扫码：1s 内中继出声，随后自动切本地（UI 显示路径变化） |

**部署前提（用户侧）**：dyzyzj.top NS 托管到 Cloudflare + 免费账号开通 Workers。
