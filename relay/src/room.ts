// PairingRoom：一次性配对房间（Durable Object，hibernation API）。
// 生命周期：第一个连接进入 → 等待（WAIT_TTL 超时作废）→ 第二个连接进入 →
// 双方 roomState ready → 二进制/文本帧原样透传 → 任一方离开 → 对端 bye。
// 中继不解析会话内容（E2EE 密文），只做管道与生命周期管理。

interface Env {
  WAIT_TTL_MS: string;
  SESSION_MAX_MS: string;
}

const json = (obj: unknown) => JSON.stringify(obj);

export class PairingRoom {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

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

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(server);

    const waitTtl = Number(this.env.WAIT_TTL_MS) || 60_000;
    const sessionMax = Number(this.env.SESSION_MAX_MS) || 14_400_000;

    if (existing.length === 0) {
      await this.state.storage.setAlarm(Date.now() + waitTtl);
    } else {
      // 第二方到齐：双方 ready，闹钟切换为会话时长上限
      for (const ws of this.state.getWebSockets()) {
        ws.send(json({ type: "roomState", state: "ready" }));
      }
      await this.state.storage.setAlarm(Date.now() + sessionMax);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const conns = this.state.getWebSockets();
    if (conns.length < 2) {
      // 配对完成前：只处理 hello（记录角色），回复 waiting
      if (typeof message === "string") {
        try {
          const m = JSON.parse(message);
          if (m?.type === "hello" && (m.role === "desktop" || m.role === "phone")) {
            ws.serializeAttachment({ role: m.role });
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
    const conns = this.state.getWebSockets();
    if (conns.length < 2) {
      for (const ws of conns) {
        try {
          ws.send(json({ type: "error", code: "EXPIRED", message: "配对超时" }));
          ws.close(1011, "expired");
        } catch {
          /* ignore */
        }
      }
    } else {
      for (const ws of conns) {
        try {
          ws.send(json({ type: "bye", reason: "time-limit" }));
          ws.close(1000, "time-limit");
        } catch {
          /* ignore */
        }
      }
    }
  }
}
