# PhoneMic 任务清单（v0.1 之后）

> 基线：v0.1.0 已发布（macOS DMG、云端中继 + 局域网赛马升级、E2EE）。
> 优先级：**P0** 发布阻塞 / **P1** 高 / **P2** 中 / **P3** 后期可选。
> 状态图例：`[ ]` 未开始 · `[~]` 进行中 · `[x]` 完成。
> 验收标准原则：能机器验证的机器验证（zbarimg / 截图差分 / E2E 脚本 / CI），需要真机的标注「需人工」。

## 总览

| ID | 任务 | 优先级 | 预估 | 依赖 | 阻塞点 |
|----|------|--------|------|------|--------|
| T1 | 桌面端 + 引导页英文化（i18n） | P0 | 1 天 | 无 | 无 |
| T2 | Rust 中继 Docker 化 + 自托管文档 | P0 | 1 天 | 无 | 无 |
| T3 | 产品官网 / 下载页 | P1 | 1-2 天 | **T6（Windows，用户决策）** | 无 |
| T4 | macOS 签名 + 公证 | P1 | 1 天 + 等账号 | Apple Developer 账号（$99/年，需决策） | 账号 |
| T5 | 仓库转公开 | P1 | 半天 | T1 ✅、**T6（Windows，用户决策：bug 修完再公开）** | 无 |
| T6 | Windows 端（P1 路线） | **P0** | 3-5 天 | Windows 机器 | 机器 |
| T7 | 蜂窝网络真机复验 | P1 | 30 分钟 | 无（P3 修复已在主线） | 需人工 |
| T8 | 赛马二期：无缝切换 | P2 | 2-3 天 | 无 | 无 |
| T9 | WebRTC 打洞 spike | P2 | 2 天 | 无 | 无 |
| T10 | 电脑→手机反向音频 | P3 | 3-5 天 | T8（复用双通道架构更顺） | 无 |
| T11 | USB 连接 | P3 | 待评估 | 调研（adb/usbmuxdWeb 化不可行，可能需原生） | 无 |
| T12 | 多设备（多手机合流） | P3 | 待评估 | T10 | 无 |
| T13 | 中继滥用防护与账单安全 | **P0（条件触发）** | 1 天 | 无——**升级 Workers Paid 前的硬性前置** | 无 |

建议执行序（2026-09-30 用户决策后调整）：**T6 Windows（当前最高优先，等 Windows 机器）→ T7 真机复验 → T5 转公开 → T3 官网上线**。

> 状态注记：T5/T3 曾于 2026-09-30 执行并验证通过，同日按用户指示回滚（仓库转私有、site.dyzyzj.top 与 pages.dev 均已下线，本地 site/ 目录与 LICENSE/徽章/模板保留），待 Windows 版就绪后重做——重做仅需：`gh api -X PATCH repos/zulezhe/phonemic -f private=false` + `cd site && npx wrangler deploy`。

---

## 阶段一：海外发布就绪（全部可立即开工）

### T1 桌面端 + 引导页英文化（i18n）｜P0

**背景**：手机页已中英双语（`phone/src/main.ts` 的 `STR` 字典 + `navigator.language`），但桌面端 UI（`src/main.ts`）、托盘菜单（`src-tauri/src/app.rs`）、HTTPS 引导页（`server.rs` 内嵌 `/setup`）仍是纯中文。海外用户第一屏即障碍。

**子任务**
\- [x] 1.1 新建 `src/i18n.ts`：`STR` 字典 + `t(key)` 函数，语言判定复用手机页逻辑（`navigator.language` 前缀 `zh` → 中文，否则英文）
- [x] 1.2 `src/main.ts` 全部用户可见字符串改为 `t()` 引用：标题、副标题、"扫码即连（任何网络）"、同网络直连提示、驱动状态（"虚拟麦克风就绪 / 尚未安装"）、按钮（一键安装 / 修复驱动 / 重置配对码）、统计标签（延迟/编码/码率）、自启开关文案
- [x] 1.3 托盘菜单 i18n：Rust 侧加 `sys-locale` 依赖读系统语言，`"状态：等待手机"`、`"显示主窗口"`、`"重启服务"`、`"退出 PhoneMic"` 及 stats 循环里的状态文字（"直播中（远程）"等）走字典函数
- [x] 1.4 `server.rs` 的 `/setup` 引导页 HTML 双语（默认按 `Accept-Language` 或页面内切换按钮）
- [x] 1.5 终端二维码旁的提示文案（如有）同步双语
- [x] 1.6 英文文案过一遍母语感（"Scan to connect — works on any network" 这类，不逐字直译）

**验收标准**
- [x] 中英双语浏览器渲染截图验证（headless Edge + ?lang=）：副标题/三卡文案/统计标签全部正确，无残留（2026-09-30）
- [x] `npx tsc --noEmit`（桌面+手机）通过；`cargo test` 13 通过；托盘/CLI/setup 页 i18n 代码路径就位（托盘跟随 sys-locale，setup 页 ?lang= 覆盖 + Accept-Language）
- [x] 附加修复：窗口落在已断开的显示器外时启动自动居中（用户拔副屏场景）；i18n 支持 ?lang= 显式覆盖
- [ ] CI 三 job 全绿（push 后确认）
- [ ] 手机页真机回归（需人工，tsc 已过）

---

### T2 Rust 中继 Docker 化 + 自托管文档｜P0

**背景**（2026-09-30 勘误）：Rust 中继服务端此前**并不存在**（`--remote-pair` 只是连官方中继的客户端），本任务实际实现了第二实现 `relay-server/`（phonemic-relay bin：房间生命周期对齐 room.ts + 房间数上限 + IP 限速 + 手机页托管），并完成 Docker 化。

**子任务**
- [x] 2.1 `relay-server/Dockerfile`（多阶段，rsproxy 可选参数，160MB）：多阶段构建（cargo-chef 缓存层 + debian:slim 运行层），暴露端口
- [x] 2.2 `relay-server/docker-compose.yml`（healthcheck + 全 env 参数）：环境变量注入 `PUBLIC_URL_BASE`（生成配对 URL 用）、监听端口、卷（密钥持久化——配对密钥对要挂 volume 否则容器重启后手机端公钥失配）
- [x] 2.3 `docs/self-hosting.md`（Caddy/Nginx WS 配置 + 桌面端切换说明）：前置要求、`docker compose up -d`、TLS 反代示例（Caddy 两行 + Nginx websocket 配置各一份）、防火墙/端口说明、与官方中继的差异（无 DO 休眠，内存占用参考值）
- [x] 2.4 `PHONEMIC_RELAY_HOST`/`PHONEMIC_PAGE_URL_BASE` 环境变量覆盖（relay.rs）：说明 `RELAY_HOST`/`PAGE_URL_BASE` 如何在桌面端指定（确认现有 env/编译期配置哪个可行，写清步骤；若只有编译期，加一个 `PHONEMIC_RELAY` 环境变量覆盖，代码量应很小）
- [x] 2.5 README 中英双语加 Self-hosting 章节

**验收标准**
- [x] `cd relay-server && docker compose up -d --build` 一条命令起服务（本机 Docker 实测，healthcheck 通过）
- [x] `node test/e2e.mjs ws://127.0.0.1:9430` 对容器全绿（配对/双向透传/断开通知）
- [x] `docker compose restart` 后 e2e 仍通过（无状态服务，密钥在端侧无需持久化——设计使然）
- [ ] Caddy/Nginx TLS 反代实测（配置已写入文档，标准 WS 透传模式，待有公网机器时验证）
- [x] 文档逐步对照本机执行路径自查

---

## 阶段二：发布动作

### T3 产品官网 / 下载页｜P1

**背景**：dyzyzj.top 主域空闲（仅 relay 子域在用）。海外推广需要落地页：一句话价值 + 三步上手 + 下载 + 隐私/E2EE 声明。投放广告的载体也是它（广告本身按用户决定暂缓）。

**子任务**
- [x] 3.1 定稿：**Workers assets + custom_domain**（Pages 因主域旧 DNS 记录不可用），纯静态单文件，`site/` 目录
- [x] 3.2 页面结构（首屏/三步/四特性/隐私/FAQ 五段全实现）：①首屏（logo + "Turn your phone into a PC microphone" + 下载按钮）②三步图（扫码→授权→说话）③功能点（零安装手机端 / E2EE / 自动直连）④FAQ（延迟多少、iOS 锁屏限制、需要虚拟声卡驱动说明）⑤隐私页（重点：配对码经 HKDF 派生密钥、中继只见密文、无账号无遥测）
- [x] 3.3 中英双语（默认 en，`?lang=zh` + 按钮切换，title/description 同步）
- [x] 3.4 部署上线：**https://site.dyzyzj.top**（主域/www 有注册商预置 DNS 记录且 token 无权清理，待用户 dash 清理后可换绑主域；phonemic.pages.dev 作备用入口）
- [x] 3.5 SEO 基线（title/description/og、favicon.svg、robots.txt；og:image 未做）
- [x] 3.6 下载按钮 → releases/latest 跳转（`https://github.com/zulezhe/phonemic/releases/latest` 跳转即可，免维护版本号）

**验收标准**
- [x] `https://site.dyzyzj.top` 200（CF 自动 HTTPS）
- [x] 桌面整页双语截图视觉审通过（无布局破碎/无未翻译残留；移动端断点 CSS 自适应 minmax 栅格）
- [x] 静态单文件、零外部请求、无框架（Lighthouse 高分的决定性因素齐备；未跑正式报告）
- [x] 匿名 Release 访问 200（T5 验证过同链接）
- [x] 隐私段与 relay-design.md 表述一致（HKDF-SHA256/AES-256-GCM/中继只见密文），无过度承诺

---

### T4 macOS 签名 + 公证｜P1（阻塞：Apple Developer 账号）

**背景**：当前 DMG 自签，他人下载打开会被 Gatekeeper 拦截（"无法验证开发者"需右键打开）。海外分发必须 Developer ID 签名 + notarization。

**子任务**
- [ ] 4.0 决策项（用户）：购买 Apple Developer Program（$99/年）
- [ ] 4.1 创建 Developer ID Application 证书，导入钥匙串，CI 与本地各配一份
- [ ] 4.2 App Store Connect 生成 app 专用密码 / API Key for notarytool
- [ ] 4.3 `scripts/notarize.sh`：tauri `afterSignCommand` 钩子 → codesign deepen → `xcrun notarytool submit --wait` → `stapler staple`
- [ ] 4.4 GitHub Actions：secrets 注入证书（PKCS12 base64）与 notary 凭据，release workflow 出公证 DMG
- [ ] 4.5 重发 v0.1.1（或 v0.2.0）替换资产

**验收标准**
- [ ] `spctl -a -vv -t exec <app>` 输出 `accepted`+ `Developer ID Application`
- [ ] `xcrun notarytool history` 显示 Accepted；DMG 内 app 已 staple
- [ ] 干净 Mac（或让用户删证书信任后模拟）双击 DMG 打开无"无法验证"警告，仅常规首次确认
- [ ] CI 从 tag 触发到公证资产上传全自动，重跑一次成功

---

### T5 仓库转公开｜P1

**子任务**
- [ ] 5.1 历史敏感信息扫描：`gitleaks detect --no-banner`（或 trufflehog）全历史扫描，重点确认 wrangler token、内网 IP（192.168.x）、测试 token 无硬编码
- [ ] 5.2 确认 `LICENSE`（MIT）存在且覆盖 BlackHole pkg 内嵌（resources/LICENSE 已附）
- [ ] 5.3 README 顶部加 CI 徽章 + Release 徽章 + 官网链接（依赖 T3 上线后补链）
- [ ] 5.4 `.github/FUNDING.yml`（可选）与 Issues 模板（bug 报告含系统版本/麦克风型号字段）
- [ ] 5.5 GitHub Settings → Danger Zone → 转公开

**验收标准**
- [ ] gitleaks 扫描零泄漏（或仅有白名单内条目）
- [ ] 匿名浏览器（无登录）打开仓库可读、CI 徽章绿色
- [ ] `git clone` 匿名可克隆，`cargo test` 与前端 CI 在本地干净环境通过（README 步骤照做）
- [ ] Release 页 DMG 匿名可下载

---

## 被阻塞项

### T6 Windows 端（P1 路线）｜P1（阻塞：Windows 机器）

**子任务**
- [ ] 6.1 环境搭建文档 `docs/dev-windows.md`：rustup（msvc）、VS Build Tools（C++ 工作负载）、WebView2、WSL 可选
- [ ] 6.2 `cargo check` 过 + `npm run tauri dev` 起窗口（cpal 在 Windows 走 WASAPI，理论上零改动，验证之）
- [ ] 6.3 音频链路验证：本机浏览器 fake 页 → 播放至默认扬声器（等价 M1）→ 统计面板延迟/电平正常
- [ ] 6.4 驱动层：`install_driver` Windows 分支不做内嵌（VB-CABLE 禁止再分发），改为：检测 `CABLE Input`（cpal 设备名匹配）→ 未装时 UI 打开官网下载页按钮 + "装完后点我重新检测"
- [ ] 6.5 osascript 管理员逻辑替换：Windows 上无需提权（VB-CABLE 安装器自带），确认无残留 macOS 分支报错
- [ ] 6.6 自启动：`tauri-plugin-autostart` Windows 注册表路径验证；`--hidden` 静默启动同样生效（托盘常驻已跨平台，验证图标出现）
- [ ] 6.7 打包：`tauri build` 出 NSIS 安装包；CI 加 `windows-latest` job（cargo test + tauri build）
- [ ] 6.8 Windows 真机全链路：手机扫码 → VB-CABLE → 系统"测试麦克风"电平跳动 → 微信/语音输入转字
- [ ] 6.9 Windows 签名（SmartScreen）：后置，先自签发布，积累后再决定买 EV/OV 证书

**验收标准**
- [ ] CI windows job 绿（cargo 16 测试通过 + 构建产物产出）
- [ ] NSIS 安装包在干净 Windows（或新建用户）安装、卸载无残留
- [ ] 真机：扫码即连（云端）→ 微信语音输入转字成功（需人工，录屏或用户确认）
- [ ] VB-CABLE 检测：未装时给出引导按钮，装后重启 app 识别为"虚拟麦克风就绪"
- [ ] 关窗进托盘、开机自启在 Windows 行为与 macOS 一致（截图/任务栏图标确认）

---

### T7 蜂窝网络真机复验｜P1（需人工，30 分钟）

**背景**：P3 四项修复（加密帧缓冲越界等）后，模拟器电平 0.21 确认音频已通，但用户未真机复验。

**子任务**
- [ ] 7.1 手机关 WiFi 仅蜂窝，扫码（默认云端 QR）
- [ ] 7.2 微信语音输入转文字 ≥3 次，记录成功率
- [ ] 7.3 记录扫码→"直播中"耗时；同网络场景观察是否自动切直连（状态栏/统计面板）
- [ ] 7.4 通话 10 分钟稳定性（无断流；如断流记录 app.log 时间点）

**验收标准**
- [ ] 蜂窝下连接成功且语音转字成功 ≥2/3
- [ ] 连接耗时 ≤5s（超过则记录并开 bug）
- [ ] 局域网同网时统计面板出现直连特征（RTT 骤降或标记），无感切换无断音
- [ ] 10 分钟会话 `underrun` 增长 ≤ 个位数

---

## 阶段三：后期可选（P2/P3）

### T8 赛马二期：无缝切换｜P2

**背景**：一期局域网升级采用"welcome 即整体切换 + 100-300ms 发送间隙"，有轻微断音。二期目标帧级无缝。

**子任务**
- [ ] 8.1 协议设计：`pathUpgrade` 消息（桌面经云端下发"已收到直连 seq=N"确认，手机收到前双发两通道）写入 `docs/protocol.md`
- [ ] 8.2 桌面端：双通道 seq 去重窗口（同一 seq 云端/直连先到先用，后到丢弃）
- [ ] 8.3 手机端：升级期间双发，收到确认后停云端通道
- [ ] 8.4 回退：直连通道 2s 无确认 → 回云端单发

**验收标准**
- [ ] `relay/test/upgrade_race.mjs` 升级：断言切换窗口 `underrun=0`、重复帧丢弃计数 >0（证明双发生效）、总帧无缺口
- [ ] 模拟弱网（直连丢包 20%）不回退错乱，最终收敛单通道
- [ ] 真机同网听感无断音（需人工）

### T9 WebRTC 打洞 spike｜P2

**子任务**
- [ ] 9.1 选型：`webrtc-rs` vs `libdatachannel`（体积/成熟度/opus 支持对比，输出 spike 报告 `docs/spike-webrtc.md`）
- [ ] 9.2 原型：桌面端 DATA_CHANNEL UDP 直连（信令复用现有 WS），手机端浏览器原生 WebRTC
- [ ] 9.3 CF 免费 TURN 兜底成本评估（TURN 流量收费）

**验收标准**
- [ ] spike 报告含：打洞成功率（≥2 网络）、P50/P99 延迟对比 WS、二进制增量体积
- [ ] 原型跑通音频并出数据后再决定是否立项 P2P 主线

### T10 电脑→手机反向音频｜P3
桌面采集系统音频（macOS ScreenCaptureKit / Windows WASAPI loopback）→ 同协议反向推流到手机扬声器。依赖 T8 双通道架构。验收：手机听到的延迟 ≤150ms、断连自动恢复。

### T11 USB 连接｜P3
先调研：iOS usbmuxd、Android adb forward 均需原生组件，纯 Web 不可行；评估"可选原生小助手"方案价值再立项。验收（调研阶段）：报告含可行性结论与预估成本。

### T12 多设备（多手机合流）｜P3
多手机同时连入，桌面混流（求和+削波）。依赖 T10。验收：2 台手机同时说话，输出为可分辨混音；单台掉线不影响另一台。

---

## 风险任务

### T13 中继滥用防护与账单安全｜P0（升级 Workers Paid 前的硬性前置）

**背景**（2026-09-29 风险评审补入）：DO 按请求（$0.15/M）+ 活跃时长（$12.50/M GB-s）计费，Workers Paid 无消费硬上限。当前架构下**任意随机码**的 `/ws/pair/<code>` 连接都会实例化 PairingRoom（`idFromName` 特性），攻击者无需猜中有效配对码。估算：1 万并发恶意连接持续发消息 ≈ **$1,500/天**（请求费 ~$130 + duration ~$1,380），理论无上限。当前 Workers Free 计划为硬限额（10 万 req/天 + 13,000 GB-s/天），超额表现为**当天中继不可用，不产生账单**——所以现在零账单风险，但升级 Paid 的那一天风险即刻生效，防护必须先行。

**子任务**
- [ ] 13.1 CF Billing 设置双档 spend notification（$10 提醒 / $50 提醒），升级当天配置（需用户控制台操作）
- [x] 13.2 IP 新房限速：改为 RoomLimiter DO 内强一致计数（30 房/min/IP，storage 持久化）——beta ratelimit binding 突发全漏过已弃用（2026-09-30 线上验证：40 并发拦 10、35 顺序拦 5）
- [x] 13.3 无握手连接快速失败：等待期 15s 内无 hello 即 NOHELLO 断开（比 HMAC 更轻，两端本就发 hello，零协议改动）
- [x] 13.4 全局房间数上限：TTL 注册表（等待期短名额/会话期长名额/终态释放），MAX_ROOMS 可调
- [x] 13.5 诊断端点 `GET /admin/rooms`（活跃数+IP 计数只读）；阈值邮件告警未做
- [ ] 13.6 升级检查单：升级 Paid = 13.1 完成 + 当天人工盯 24h metrics；**待办**：线上测试垃圾注册清空后（约 2026-10-01 12:00）把 MAX_ROOMS 从 500 调回 100

**验收标准**
- [x] `relay/test/abuse.mjs` 四场景线上全过（2026-09-30，e6543cc8 部署）：A IP 限速 40 并发拦 10；B 消息洪水 RATE 断开；C 无 hello 挂机 25s 内 NOHELLO 清理；D 正常链路 40/40 零误伤
- [x] e2e 回归通过（wss://relay.dyzyzj.top）
- [ ] spend notification 测试邮件收到（13.1，待用户操作）
- [ ] MAX_ROOMS 调回 100（垃圾注册过期后）

---

## 维护性备注（非任务，随手做）

- 每完成一个任务：更新本文件勾选 + `git commit`（信息含任务 ID，如 `T1: desktop i18n`）
- 依赖关系变化时更新总览表
- 用户安全约束不变：外放测试音量 ≤5%；公司 npm 镜像不污染 lockfile（生成依赖一律 `--registry https://registry.npmjs.org`）
