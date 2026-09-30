// RoomLimiter：全局并发房间上限 + 每 IP 新房限速（T13 滥用防护）。
// 房间第一个连接进入时向本 DO 注册（带 TTL），活跃数超上限则拒绝新房间，
// 把"随机码开房洪水"的爆炸半径封顶。用 TTL 自动过期而非显式注销：
// 宁可保守多算（偏安全方向），也不冒计数泄漏导致正常用户被永久拒绝的风险。
// TTL 取 SESSION_MAX + 1h，覆盖整个会话生命周期与重连窗口。
//
// 每 IP 限速在 DO 内做强一致计数（beta ratelimit binding 是 best-effort，
// 突发流量可能全部漏过，只作边缘补充，不当第一道防线）。

interface LimiterEnv {
  MAX_ROOMS: string;
  IP_ROOMS_PER_MIN: string;
  ROOM_TTL_CAP_MS: string;
}

const DEFAULTS = { maxRooms: 100, ipRoomsPerMin: 30, ipWindowMs: 60_000 };
const SWEEP_INTERVAL_MS = 120_000;

interface IpCount {
  n: number;
  start: number;
}

const IP_COUNTS_KEY = "ipCounts";
const IP_FLUSH_INTERVAL_MS = 2_000;

export class RoomLimiter {
  private rooms: Map<string, number> = new Map(); // roomId -> 到期时间(ms)
  // ip -> 新房计数。DO 空闲即可能被回收，须防抖落盘 + 启动恢复，否则顺序慢速
  // 请求永远撞不到阈值（并发洪水因实例存活反而能拦住）
  private ipCounts: Map<string, IpCount> = new Map();
  private loaded = false;
  private lastIpFlush = 0;

  constructor(
    private state: DurableObjectState,
    private env: LimiterEnv,
  ) {}

  private num(v: string | undefined, fallback: number): number {
    const n = Number(v);
    return n > 0 ? n : fallback;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const all = await this.state.storage.list<number>();
    for (const [k, v] of all) {
      if (k === IP_COUNTS_KEY) {
        try {
          const arr = v as unknown as [string, IpCount][];
          this.ipCounts = new Map(arr);
        } catch {
          /* 兼容坏数据：忽略 */
        }
      } else {
        this.rooms.set(k, v);
      }
    }
    this.loaded = true;
  }

  private async flushIps(): Promise<void> {
    const now = Date.now();
    if (now - this.lastIpFlush < IP_FLUSH_INTERVAL_MS) return;
    this.lastIpFlush = now;
    await this.state.storage.put(IP_COUNTS_KEY, [...this.ipCounts.entries()]);
  }

  private async sweep(now: number): Promise<void> {
    const expired: string[] = [];
    for (const [id, exp] of this.rooms) {
      if (exp <= now) expired.push(id);
    }
    if (expired.length) {
      for (const id of expired) this.rooms.delete(id);
      await this.state.storage.delete(expired);
    }
    // IP 计数防累积：窗口早已过期 10 倍以上的条目直接删（防 Map 无限增长）
    for (const [ip, c] of this.ipCounts) {
      if (now - c.start >= DEFAULTS.ipWindowMs * 10) this.ipCounts.delete(ip);
    }
  }

  private ipAllowed(ip: string, now: number): boolean {
    const limit = this.num(this.env.IP_ROOMS_PER_MIN, DEFAULTS.ipRoomsPerMin);
    const c = this.ipCounts.get(ip);
    if (!c || now - c.start >= DEFAULTS.ipWindowMs) {
      this.ipCounts.set(ip, { n: 1, start: now });
      return true;
    }
    c.n += 1;
    return c.n <= limit;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/stats" && req.method === "GET") {
      await this.load();
      const now = Date.now();
      await this.sweep(now);
      const sample = [...this.rooms.entries()].slice(0, 5).map(([id, exp]) => ({
        id: id.slice(0, 12),
        expiresInMin: Math.round((exp - now) / 60_000),
      }));
      const ips = [...this.ipCounts.entries()].map(([ip, c]) => ({
        ip: ip.slice(0, 20),
        n: c.n,
        ageSec: Math.round((now - c.start) / 1000),
      }));
      return Response.json({ active: this.rooms.size, sample, ips });
    }

    if (req.method !== "POST") return new Response("method required", { status: 405 });
    const body = (await req.json()) as { roomId: string; ttlMs: number; ip?: string };
    if (!body.roomId) return new Response("roomId required", { status: 400 });

    if (url.pathname === "/release") {
      // 房间终态（配对超时/会话到期）主动释放名额；未注册的幂等成功
      await this.load();
      if (this.rooms.delete(body.roomId)) {
        await this.state.storage.delete(body.roomId);
      }
      return Response.json({ ok: true, active: this.rooms.size });
    }
    if (url.pathname !== "/ensure") return new Response("not found", { status: 404 });

    const now = Date.now();
    await this.load();
    await this.sweep(now);

    const isNewRoom = !this.rooms.has(body.roomId);
    if (isNewRoom) {
      const allowed = !body.ip || this.ipAllowed(body.ip, now);
      await this.flushIps(); // 计数先落盘再判罚，防 DO 提前休眠丢计数
      if (!allowed) {
        return Response.json(
          { ok: false, reason: "ip-rate", active: this.rooms.size },
          { status: 429 },
        );
      }
      if (this.rooms.size >= this.num(this.env.MAX_ROOMS, DEFAULTS.maxRooms)) {
        return Response.json(
          { ok: false, reason: "busy", active: this.rooms.size },
          { status: 429 },
        );
      }
      const cap = this.num(this.env.ROOM_TTL_CAP_MS, 18_000_000);
      const exp = now + Math.min(Math.max(body.ttlMs, 60_000), cap);
      this.rooms.set(body.roomId, exp);
      await this.state.storage.put(body.roomId, exp);
    } else if (body.ttlMs > 0) {
      // 已注册房间：配对成功时刷新 TTL（等待期短 TTL → 会话级长 TTL），只延长不缩短
      const cur = this.rooms.get(body.roomId) ?? 0;
      const cap = this.num(this.env.ROOM_TTL_CAP_MS, 18_000_000);
      const exp = now + Math.min(Math.max(body.ttlMs, 60_000), cap);
      if (exp > cur) {
        this.rooms.set(body.roomId, exp);
        await this.state.storage.put(body.roomId, exp);
      }
    }
    // 还有存活房间就保持定期唤醒，让过期项及时释放名额
    if (this.rooms.size > 0) {
      await this.state.storage.setAlarm(now + SWEEP_INTERVAL_MS);
    }
    return Response.json({ ok: true, active: this.rooms.size });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.load();
    await this.sweep(now);
    if (this.rooms.size > 0) {
      await this.state.storage.setAlarm(now + SWEEP_INTERVAL_MS);
    }
  }
}
