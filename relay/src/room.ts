// PairingRoom：一次性配对房间（Durable Object，hibernation API）。
// 生命周期：第一个连接进入 → 等待（WAIT_TTL 超时作废）→ 第二个连接进入 →
// 双方 roomState ready → 二进制/文本帧原样透传 → 任一方离开 → 对端 bye。
// 中继不解析会话内容（E2EE 密文），只做管道与生命周期管理。
//
// T13 滥用防护：
//   1. 新房间须先在 RoomLimiter 注册，全局并发房间数超上限直接拒绝；
//   2. 等待期连接须在 HELLO_TIMEOUT 内发出首条 hello，否则断开（防占房挂机）；
//   3. 每房间消息速率上限 MSG_PER_SEC（正常音频 ~50msg/s + 控制帧），
//      超限断开该连接——封顶单个房间可制造的请求费。

interface Env {
  WAIT_TTL_MS: string;
  SESSION_MAX_MS: string;
  HELLO_TIMEOUT_MS: string;
  MSG_PER_SEC: string;
  LIMITER: DurableObjectNamespace;
}

const DEFAULTS = { helloTimeoutMs: 15_000, msgPerSec: 150, sessionPadMs: 3_600_000, waitPadMs: 600_000 };
const STAGE_KEY = "stage";
const WAIT_DEADLINE_KEY = "waitDeadline";

const json = (obj: unknown) => JSON.stringify(obj);

interface Attach {
  role?: string;
  saidHello?: boolean;
}

export class PairingRoom {
  private msgWindow = { count: 0, start: 0 };

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  private num(v: string | undefined, fallback: number): number {
    const n = Number(v);
    return n > 0 ? n : fallback;
  }

  /** 向 limiter 发一次调用（path 以 / 开头） */
  private limiterCall(path: string, body: Record<string, unknown>): Promise<Response> {
    const limiterId = this.env.LIMITER.idFromName("global");
    return this.env.LIMITER.get(limiterId).fetch(`https://limiter${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private clientIp(req: Request): string | undefined {
    // CF-Connecting-IP 进 DO 会被剥离，入口已改写为 X-PM-IP
    return req.headers.get("X-PM-IP") ?? undefined;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("websocket required", { status: 426 });
    }
    const existing = this.state.getWebSockets();
    if (existing.length >= 2) {
      return new Response(
        json({ type: "error", code: "FULL", message: "房间已满" }),
        { status: 403 },
      );
    }

    const waitTtl = this.num(this.env.WAIT_TTL_MS, 60_000);
    const sessionMax = this.num(this.env.SESSION_MAX_MS, 14_400_000);
    const helloTimeout = this.num(this.env.HELLO_TIMEOUT_MS, DEFAULTS.helloTimeoutMs);

    let registered = false;
    if (existing.length === 0) {
      // 新房间：全局并发上限检查（幂等注册，重连窗口内同房间不重复计数）。
      // 等待期只占 WAIT_TTL + 10min 的短名额，配对成功时才升为会话级长 TTL
      const res = await this.limiterCall("/ensure", {
        roomId: this.state.id.toString(),
        ttlMs: waitTtl + DEFAULTS.waitPadMs,
        ip: this.clientIp(req),
      });
      if (!res.ok) {
        const reason = await res.text();
        console.log(`[limiter] rejected room=${this.state.id.toString().slice(0, 8)} ${reason}`);
        return new Response(
          json({ type: "error", code: "BUSY", reason, message: "服务繁忙，请稍后再试" }),
          { status: 429 },
        );
      }
      registered = true;
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);

    if (registered) {
      const deadline = Date.now() + waitTtl;
      await this.state.storage.put(STAGE_KEY, "wait");
      await this.state.storage.put(WAIT_DEADLINE_KEY, deadline);
      // 首个闹钟取握手超时与等待超时的较小者：未握手连接尽早清理
      await this.state.storage.setAlarm(Date.now() + Math.min(helloTimeout, waitTtl));
    } else {
      // 第二方到齐：双方 ready（新连接已 accept，可一并收到），闹钟切换为会话时长上限；
      // 同时把 limiter 名额刷新为会话级长 TTL
      await this.limiterCall("/ensure", {
        roomId: this.state.id.toString(),
        ttlMs: sessionMax + DEFAULTS.sessionPadMs,
      });
      await this.state.storage.put(STAGE_KEY, "live");
      for (const ws of this.state.getWebSockets()) {
        ws.send(json({ type: "roomState", state: "ready" }));
      }
      await this.state.storage.setAlarm(Date.now() + sessionMax);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private rateLimited(): boolean {
    const now = Date.now();
    if (now - this.msgWindow.start >= 1000) {
      this.msgWindow = { count: 0, start: now };
    }
    return ++this.msgWindow.count > this.num(this.env.MSG_PER_SEC, DEFAULTS.msgPerSec);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.rateLimited()) {
      try {
        ws.send(json({ type: "error", code: "RATE", message: "消息速率超限" }));
      } catch {
        /* 对端可能已关闭 */
      }
      try {
        ws.close(1008, "rate-limit");
      } catch {
        /* 对端可能已关闭 */
      }
      return;
    }
    const conns = this.state.getWebSockets();
    if (conns.length < 2) {
      // 配对完成前：只处理 hello（记录角色），回复 waiting
      if (typeof message === "string") {
        try {
          const m = JSON.parse(message);
          if (m?.type === "hello" && (m.role === "desktop" || m.role === "phone")) {
            const prev = ws.deserializeAttachment() as Attach | undefined;
            ws.serializeAttachment({ ...(prev ?? {}), role: m.role, saidHello: true });
          }
        } catch {
          /* 非合法 JSON 忽略 */
        }
      }
      ws.send(json({ type: "roomState", state: "waiting" }));
      return;
    }
    // 配对完成：原样透传（不解析）
    for (const other of conns) {
      if (other !== ws) other.send(message);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    for (const other of this.state.getWebSockets()) {
      if (other !== ws) {
        try {
          other.send(json({ type: "bye", reason: "peer-left" }));
        } catch {
          /* 对端可能已关闭 */
        }
        try {
          other.close(1000, "peer-left");
        } catch {
          /* 对端可能已关闭 */
        }
      }
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  async alarm(): Promise<void> {
    const stage = await this.state.storage.get<string>(STAGE_KEY);
    const conns = this.state.getWebSockets();
    const now = Date.now();

    if (stage === "live") {
      // 会话时长上限：全房关闭 + 释放名额
      await this.limiterCall("/release", { roomId: this.state.id.toString() });
      for (const ws of conns) {
        try {
          ws.send(json({ type: "bye", reason: "time-limit" }));
        } catch {
          /* ignore */
        }
        try {
          ws.close(1000, "time-limit");
        } catch {
          /* ignore */
        }
      }
      return;
    }

    const deadline = (await this.state.storage.get<number>(WAIT_DEADLINE_KEY)) ?? now;
    if (now >= deadline) {
      // 等待超时：配对未完成，房间作废（原逻辑）+ 释放名额
      await this.limiterCall("/release", { roomId: this.state.id.toString() });
      for (const ws of conns) {
        try {
          ws.send(json({ type: "error", code: "EXPIRED", message: "配对超时" }));
        } catch {
          /* ignore */
        }
        try {
          ws.close(1011, "expired");
        } catch {
          /* ignore */
        }
      }
      return;
    }

    // 握手超时清理：踢掉从未发 hello 的连接（防占房挂机）
    let kept = 0;
    for (const ws of conns) {
      const attach = ws.deserializeAttachment() as Attach | undefined;
      if (attach?.saidHello) {
        kept++;
        continue;
      }
      try {
        ws.send(json({ type: "error", code: "NOHELLO", message: "未完成握手，连接关闭" }));
      } catch {
        /* 对端可能已关闭 */
      }
      try {
        ws.close(1008, "no-hello");
      } catch {
        /* 对端可能已关闭 */
      }
    }
    if (kept > 0) {
      // 已握手的连接继续等对端，直到等待超时
      await this.state.storage.setAlarm(deadline);
    }
  }
}
