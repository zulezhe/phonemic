// PhoneMic 中继入口：WS 配对路由 + 静态手机页。
// 协议见 docs/relay-design.md §4。
import { PairingRoom } from "./room";

export { PairingRoom };

interface Env {
  ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // 配对房间：/ws/pair/<code>，code 为 16-64 位 url-safe 随机串
    const m = url.pathname.match(/^\/ws\/pair\/([A-Za-z0-9_-]{16,64})$/);
    if (m) {
      const id = env.ROOM.idFromName(m[1]);
      return env.ROOM.get(id).fetch(req);
    }

    if (url.pathname === "/healthz") {
      return new Response("phonemic-relay ok\n", { headers: { "content-type": "text/plain" } });
    }

    // 其余走静态手机页
    return env.ASSETS.fetch(req);
  },
};
