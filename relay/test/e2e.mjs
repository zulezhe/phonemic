// 双客户端 e2e：模拟桌面端 + 手机端经中继配对、透传、断开通知。
// 用法: node test/e2e.mjs ws://127.0.0.1:8787  或  wss://relay.dyzyzj.top
const BASE = process.argv[2] ?? "ws://127.0.0.1:8787";
const code = crypto.randomUUID().replace(/-/g, "");

function assert(cond, msg) {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exit(1);
  }
}

// 连接即开始收集所有消息的客户端（避免监听器竞态丢消息）
class Client {
  constructor(role) {
    this.role = role;
    this.queue = [];
    this.waiters = [];
    this.ws = new WebSocket(`${BASE}/ws/pair/${code}`);
    this.ws.binaryType = "arraybuffer";
    this.open = new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${role} 连接超时`)), 8000);
      this.ws.onopen = () => {
        clearTimeout(t);
        this.send({ type: "hello", role, v: 1 });
        res();
      };
      this.ws.onerror = () => rej(new Error(`${role} 连接失败`));
    });
    this.ws.onmessage = (ev) => {
      const item = { data: ev.data, at: Date.now() };
      const w = this.waiters.shift();
      if (w) w(item);
      else this.queue.push(item);
    };
  }
  send(obj) {
    this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj));
  }
  sendBinary(bytes) {
    this.ws.send(bytes);
  }
  next(timeoutMs = 8000) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.role} 等待消息超时`)), timeoutMs);
      this.waiters.push((item) => {
        clearTimeout(t);
        res(item);
      });
    });
  }
  async nextJson() {
    const m = await this.next();
    assert(typeof m.data === "string", `${this.role} 期望文本帧`);
    return JSON.parse(m.data);
  }
  /** 跳过被透传的对端 hello 握手帧 */
  async nextJsonSkipHello() {
    for (;;) {
      const m = await this.nextJson();
      if (m.type === "hello") continue;
      return m;
    }
  }
  /** 取下一个二进制帧（跳过透传的文本 hello） */
  async nextBinary() {
    for (;;) {
      const m = await this.next();
      if (m.data instanceof ArrayBuffer) return m;
    }
  }
}

// 1. 桌面端先进 → waiting
const desktop = new Client("desktop");
await desktop.open;
let m = await desktop.nextJsonSkipHello();
assert(m.type === "roomState" && m.state === "waiting", `应收到 waiting，收到: ${JSON.stringify(m)}`);
console.log("✓ 桌面端等待中");

// 2. 手机端进入 → 双方 ready（消息队列从连接起收集，无竞态）
const phone = new Client("phone");
await phone.open;
const [dReady, pReady] = await Promise.all([desktop.nextJsonSkipHello(), phone.nextJsonSkipHello()]);
assert(dReady.type === "roomState" && dReady.state === "ready", `桌面端应收到 ready，收到: ${JSON.stringify(dReady)}`);
assert(pReady.type === "roomState" && pReady.state === "ready", `手机端应收到 ready，收到: ${JSON.stringify(pReady)}`);
console.log("✓ 配对完成（双方 ready）");

// 3. 二进制帧透传（模拟加密会话帧，bit7=1）
const frame = new Uint8Array([0x81, 0x00, 0x02, 0x70, 0x00, 0x00, 0x03, 0xe8, 1, 2, 3, 4, 5, 6, 7, 9]);
phone.sendBinary(frame);
const gotBin = new Uint8Array((await desktop.nextBinary()).data);
assert(gotBin.length === frame.length && frame.every((v, i) => gotBin[i] === v), "二进制透传失真");
console.log("✓ 二进制帧原样透传");

// 4. 文本控制帧双向透传
desktop.send({ type: "ping", t: 1.5 });
const t = await phone.nextJsonSkipHello();
assert(t.type === "ping" && t.t === 1.5, "文本透传失真");
console.log("✓ 文本控制帧原样透传");

// 5. 断开通知
phone.ws.close();
const bye = await desktop.nextJsonSkipHello();
assert(bye.type === "bye", `应收到 bye，收到: ${JSON.stringify(bye)}`);
console.log("✓ 断开通知（bye）");

desktop.ws.close();
console.log(`\n✅ relay e2e PASS (${BASE}, room=${code.slice(0, 8)}…)`);
process.exit(0);
