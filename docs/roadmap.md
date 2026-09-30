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
| T3 | 产品官网 / 下载页 | P1 | 1-2 天 | T5（下载链接需公开） | 无 |
| T4 | macOS 签名 + 公证 | P1 | 1 天 + 等账号 | Apple Developer 账号（$99/年，需决策） | 账号 |
| T5 | 仓库转公开 | P1 | 半天 | T1（避免公开即半中文） | 无 |
| T6 | Windows 端（P1 路线） | P1 | 3-5 天 | Windows 机器 | 机器 |
| T7 | 蜂窝网络真机复验 | P1 | 30 分钟 | 无（P3 修复已在主线） | 需人工 |
| T8 | 赛马二期：无缝切换 | P2 | 2-3 天 | 无 | 无 |
| T9 | WebRTC 打洞 spike | P2 | 2 天 | 无 | 无 |
| T10 | 电脑→手机反向音频 | P3 | 3-5 天 | T8（复用双通道架构更顺） | 无 |
| T11 | USB 连接 | P3 | 待评估 | 调研（adb/usbmuxdWeb 化不可行，可能需原生） | 无 |
| T12 | 多设备（多手机合流） | P3 | 待评估 | T10 | 无 |
| T13 | 中继滥用防护与账单安全 | **P0（条件触发）** | 1 天 | 无——**升级 Workers Paid 前的硬性前置** | 无 |

建议执行序：**T1 → T2 → T5 → T3 →（T4 账号决策后随时插入）→ T7（用户有空时）→ T6（拿到 Windows 机后）**。

---

## 阶段一：海外发布就绪（全部可立即开工）

### T1 桌面端 + 引导页英文化（i18n）｜P0

**背景**：手机页已中英双语（`phone/src/main.ts` 的 `STR` 字典 + `navigator.language`），但桌面端 UI（`src/main.ts`）、托盘菜单（`src-tauri/src/app.rs`）、HTTPS 引导页（`server.rs` 内嵌 `/setup`）仍是纯中文。海外用户第一屏即障碍。

**子任务**
- [ ] 1.1 新建 `src/i18n.ts`：`STR` 字典 + `t(key)` 函数，语言判定复用手机页逻辑（`navigator.language` 前缀 `zh` → 中文，否则英文）
- [ ] 1.2 `src/main.ts` 全部用户可见字符串改为 `t()` 引用：标题、副标题、"扫码即连（任何网络）"、同网络直连提示、驱动状态（"虚拟麦克风就绪 / 尚未安装"）、按钮（一键安装 / 修复驱动 / 重置配对码）、统计标签（延迟/编码/码率）、自启开关文案
- [ ] 1.3 托盘菜单 i18n：Rust 侧加 `sys-locale` 依赖读系统语言，`"状态：等待手机"`、`"显示主窗口"`、`"重启服务"`、`"退出 PhoneMic"` 及 stats 循环里的状态文字（"直播中（远程）"等）走字典函数
- [ ] 1.4 `server.rs` 的 `/setup` 引导页 HTML 双语（默认按 `Accept-Language` 或页面内切换按钮）
- [ ] 1.5 终端二维码旁的提示文案（如有）同步双语
- [ ] 1.6 英文文案过一遍母语感（"Scan to connect — works on any network" 这类，不逐字直译）

**验收标准**
- [ ] 中文环境（当前系统）：`npm run dev:app` 启动，截主窗口，中文关键词齐全（视觉模型读图核对：扫码、虚拟麦克风、重置配对码等 ≥6 处）
- [ ] 英文环境验证：`defaults read dev.phonemic.desktop.dev AppleLanguages` 设为 `en` 后重启 app（或临时硬编码 locale），截图全部 UI 文案为英文，无中文字符残留（截图 OCR 或视觉模型确认）
- [ ] 托盘菜单四项跟随系统语言（`launchctl setlang en_US` 或同上法验证，视觉读菜单项）
- [ ] `npx tsc --noEmit` 通过；`cargo check` 通过；CI 三 job 全绿
- [ ] 手机页回归：中文/英文手机浏览器各开一次，无回归

---

### T2 Rust 中继 Docker 化 + 自托管文档｜P0

**背景**：`phonemic-server --remote-pair`（Rust 中继二进制）已实现同协议第二实现，但只能手动编译运行。开源卖点"不信任官方中继可自建"需要一条命令跑起来。

**子任务**
- [ ] 2.1 `relay/Dockerfile`：多阶段构建（cargo-chef 缓存层 + debian:slim 运行层），暴露端口
- [ ] 2.2 `relay/docker-compose.yml`：环境变量注入 `PUBLIC_URL_BASE`（生成配对 URL 用）、监听端口、卷（密钥持久化——配对密钥对要挂 volume 否则容器重启后手机端公钥失配）
- [ ] 2.3 `docs/self-hosting.md`：前置要求、`docker compose up -d`、TLS 反代示例（Caddy 两行 + Nginx websocket 配置各一份）、防火墙/端口说明、与官方中继的差异（无 DO 休眠，内存占用参考值）
- [ ] 2.4 桌面端连接自建中继的配置路径：说明 `RELAY_HOST`/`PAGE_URL_BASE` 如何在桌面端指定（确认现有 env/编译期配置哪个可行，写清步骤；若只有编译期，加一个 `PHONEMIC_RELAY` 环境变量覆盖，代码量应很小）
- [ ] 2.5 `README.md`（中英双语区块）加 Self-hosting 章节链接

**验收标准**
- [ ] `cd relay && docker compose up -d` 在干净机器上一条命令起服务，容器健康检查通过
- [ ] 复用 `relay/test/e2e.mjs`，将 WS 地址指向 `ws://localhost:<port>/ws/pair/<code>`，fake_phone 完成 E2EE 会话并收到 ≥100 音频帧（扩展现有脚本加 `--target` 参数）
- [ ] 容器重启一次后再跑 e2e 仍通过（验证密钥 volume 持久化）
- [ ] Caddy 反代 + TLS 场景：至少本地 `caddy` 起一次自签/内部 CA 反代验证 WS upgrade 头透传，e2e 通过
- [ ] `docs/self-hosting.md` 步骤可被"从未见过本项目的人"照做成功（自查：逐步骤对照命令与输出）

---

## 阶段二：发布动作

### T3 产品官网 / 下载页｜P1

**背景**：dyzyzj.top 主域空闲（仅 relay 子域在用）。海外推广需要落地页：一句话价值 + 三步上手 + 下载 + 隐私/E2EE 声明。投放广告的载体也是它（广告本身按用户决定暂缓）。

**子任务**
- [ ] 3.1 技术选型定稿：Cloudflare Pages + 纯静态 HTML/CSS（无框架，免构建或最小构建），仓库新增 `site/` 目录
- [ ] 3.2 页面结构：①首屏（logo + "Turn your phone into a PC microphone" + 下载按钮）②三步图（扫码→授权→说话）③功能点（零安装手机端 / E2EE / 自动直连）④FAQ（延迟多少、iOS 锁屏限制、需要虚拟声卡驱动说明）⑤隐私页（重点：配对码经 HKDF 派生密钥、中继只见密文、无账号无遥测）
- [ ] 3.3 中英双语（默认 en，`?lang=zh` 或子路径 `/zh/`）
- [ ] 3.4 部署：CF Pages 绑定 dyzyzj.top 主域（wrangler pages deploy 或 CI 推送），自定义域 DNS 由 CF 托管可直接加
- [ ] 3.5 SEO 基线：title/description/og:image、sitemap.txt、favicon
- [ ] 3.6 下载按钮指向 GitHub Releases 最新版（`https://github.com/zulezhe/phonemic/releases/latest` 跳转即可，免维护版本号）

**验收标准**
- [ ] `https://dyzyzj.top` 可访问，HTTP→HTTPS 强制，CF Pages 部署成功
- [ ] 手机与桌面各截一张：布局不错位、三步图清晰（视觉模型审）
- [ ] Lighthouse（Pages 内置或本地 npx）Performance/SEO/Best Practices ≥ 90
- [ ] 下载链接匿名窗口点击可达 Release 页（T5 完成后有效）
- [ ] 隐私页包含 E2EE 原理一段且与 `docs/relay-design.md` 表述一致（人工核对，不许诺"零日志"之类未验证声明）

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

**子任务**（当前 Free 期间可先做 a/b/c 零成本部分）
- [ ] 13.1 CF Billing 设置双档 spend notification（$10 提醒 / $50 提醒），升级当天配置
- [ ] 13.2 WAF rate limiting 规则：`/ws/pair/*` 路径按 IP 限速（如 10 conn/min/IP）；Free 计划含 1 条免费规则即可覆盖
- [ ] 13.3 未验证连接快速失败：进房握手加轻量凭证——复用 QR 里的 `t=token` 做 HMAC 证明（桌面端持有 token，Worker 校验），无凭证/错误的连接 2s 内断开，不进 WAIT_TTL 等待（协议小改，`docs/protocol.md` 同步）
- [ ] 13.4 全局并发房间数上限（单一计数 DO，粗粒度即可，如 500），超限直接拒绝新房间
- [ ] 13.5 异常监控告警：Workers Analytics 连接数/请求量阈值告警（邮件）
- [ ] 13.6 升级检查单：升级 Paid = a/b/c/d/e 全部完成 + 当天人工盯 24h 内 metrics

**验收标准**
- [ ] 无凭证脚本批量连 `/ws/pair/<随机码>`：每个连接 ≤2s 被断开，不产生房间积压（fake 脚本验证）
- [ ] 同 IP 高频连接被 rate limit 规则拦截（429），规则命中可在 Security Events 看到
- [ ] spend notification 测试邮件收到
- [ ] 升级前演练：临时把某房间并发阈值调小，验证超限拒绝路径生效

---

## 维护性备注（非任务，随手做）

- 每完成一个任务：更新本文件勾选 + `git commit`（信息含任务 ID，如 `T1: desktop i18n`）
- 依赖关系变化时更新总览表
- 用户安全约束不变：外放测试音量 ≤5%；公司 npm 镜像不污染 lockfile（生成依赖一律 `--registry https://registry.npmjs.org`）
