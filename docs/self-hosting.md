# 自托管中继（Self-hosting）

官方云端中继（`relay.dyzyzj.top`，Cloudflare Workers + Durable Objects 免费层）开箱即用。
不信任官方中继、或想在内网/自有服务器跑的，可以用同协议的 Rust 第二实现 **phonemic-relay**，
一条 Docker 命令跑起来。音频内容始终端到端加密（配对码经 HKDF 派生密钥，中继只见密文），
中继替换不影响安全性。

## 快速开始

前置：Docker 20+。在仓库根目录：

```bash
cd relay-server
docker compose up -d --build
curl http://127.0.0.1:9430/healthz   # → phonemic-relay ok
```

中继监听 `9430`，同时托管手机页（扫码后的落地页）。

## TLS（手机浏览器的安全上下文要求）

手机端采集麦克风要求 HTTPS，中继本身只出 HTTP——由前置反代终结 TLS：

**Caddy（推荐，自动证书）：**

```
relay.example.com {
    reverse_proxy 127.0.0.1:9430
}
```

**Nginx（注意 WebSocket 升级头）：**

```nginx
server {
    listen 443 ssl;
    server_name relay.example.com;
    ssl_certificate     /etc/letsencrypt/live/relay.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/relay.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:9430;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;     # WebSocket 必需
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 4h;                       # 会话最长 4h
    }
}
```

DNS 把 `relay.example.com` 指到服务器，防火墙放行 443。

## 桌面端指向自建中继

启动 PhoneMic 前设置两个环境变量：

```bash
export PHONEMIC_RELAY_HOST=relay.example.com        # WebSocket 连接主机
export PHONEMIC_PAGE_URL_BASE=https://relay.example.com  # 手机页地址（二维码内容）
open /Applications/PhoneMic.app
```

不设置时使用官方中继。环境变量只影响"生成二维码时的地址"，随时可切换。

## 配置项（docker-compose.yml `environment`）

| 变量 | 默认 | 说明 |
|------|------|------|
| `LISTEN` | `0.0.0.0:9430` | 监听地址 |
| `WAIT_TTL_SECS` | `3600` | 等待配对超时 |
| `SESSION_MAX_SECS` | `14400` | 单会话时长上限 |
| `MAX_ROOMS` | `100` | 全局并发房间上限（滥用防护） |
| `IP_ROOMS_PER_MIN` | `30` | 每 IP 每分钟新建房间数（滥用防护） |

## 与官方中继的差异

- **架构**：官方版 Cloudflare Durable Objects（休眠 API，空闲零成本）；自托管版常驻进程，
  单实例内存约 5-10 MB，足以承载数百并发房间
- **防护**：官方版额外有房间内消息速率上限与等待期握手超时；自托管版保留房间数上限与
  IP 限速（单租户场景足够，参数可调）
- **升级**：`git pull && docker compose up -d --build`

## 验证

```bash
# 健康检查
curl -s https://relay.example.com/healthz

# 完整链路（需 Node 22+）：官方 e2e 脚本指向自建中继
cd relay && node test/e2e.mjs wss://relay.example.com
```
