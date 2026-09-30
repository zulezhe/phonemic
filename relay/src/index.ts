// PhoneMic 中继入口：WS 配对路由 + 静态手机页。
// 协议见 docs/relay-design.md §4。
import { PairingRoom } from "./room";
import { RoomLimiter } from "./limiter";

export { PairingRoom, RoomLimiter };

interface Env {
  ROOM: DurableObjectNamespace;
  LIMITER: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // 只读诊断：limiter 当前房间计数（T13 运维用）
    if (url.pathname === "/admin/rooms") {
      const id = env.LIMITER.idFromName("global");
      return env.LIMITER.get(id).fetch("https://limiter/stats");
    }

    // 配对房间：/ws/pair/<code>，code 为 16-64 位 url-safe 随机串
    const m = url.pathname.match(/^\/ws\/pair\/([A-Za-z0-9_-]{16,64})$/);
    if (m) {
      // CF-Connecting-IP 在请求转发进 Durable Object 时会被剥离，须显式携带，
      // per-IP 新房限速在 RoomLimiter DO 内强一致执行（T13 第一道防线）
      const headers = new Headers(req.headers);
      headers.set("X-PM-IP", req.headers.get("CF-Connecting-IP") ?? "unknown");
      const id = env.ROOM.idFromName(m[1]);
      return env.ROOM.get(id).fetch(new Request(req.url, { method: req.method, headers }));
    }

    if (url.pathname === "/healthz") {
      return new Response("phonemic-relay ok\n", { headers: { "content-type": "text/plain" } });
    }

    // 其余走静态手机页
    return env.ASSETS.fetch(req);
  },
};
