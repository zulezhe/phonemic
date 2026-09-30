// T13 滥用防护测试：三类攻击场景 + 一条正常链路回归。
// 用法: node test/abuse.mjs ws://127.0.0.1:8787 [--only=A,B,C,D]
// 场景：
//   A. 随机码高频连接（超 IP 限速 30/60s）→ 预期部分连接被 429 拒绝
//   B. 单房间消息洪水（>MSG_PER_SEC 持续）→ 预期被 RATE 断开
//   C. 进房不发 hello 挂机 → 预期 HELLO_TIMEOUT(15s) 内被断开
//   D. 正常配对链路回归（不应被防护误伤）
const BASE = process.argv[2] ?? "ws://127.0.0.1:8787";
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const ONLY = onlyArg ? new Set(onlyArg.slice(7).split(",")) : null;
const run = (id) => !ONLY || ONLY.has(id);

function assert(cond, msg) {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exit(1);
  }
}
const pass = (msg) => console.log(`✅ ${msg}`);
const code = () => crypto.randomUUID().replace(/-/g, "");

function connect(c, opts = {}) {
  // 限速窗口边缘可能误拒（remote 限速服务有时钟对齐偏差），重试兜底
  return connectOnce(c, opts).catch((e) => {
    if (opts.retries === 0) throw e;
    return new Promise((r) => setTimeout(r, 15_000)).then(() =>
      connect(c, { ...opts, retries: (opts.retries ?? 2) - 1 }),
    );
  });
}

function connectOnce(c, { hello = true, onMessage } = {}) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${BASE}/ws/pair/${c}`);
    ws.binaryType = "arraybuffer";
    // 监听器必须在 onopen 之前挂好：ready 等消息在握手瞬间就会到达
    if (onMessage) ws.addEventListener("message", onMessage);
    const t = setTimeout(() => rej(new Error("连接超时")), 8000);
    ws.onopen = () => {
      clearTimeout(t);
      if (hello) ws.send(JSON.stringify({ type: "hello", role: "phone", v: 1 }));
      res(ws);
    };
    ws.onerror = () => {
      clearTimeout(t);
      rej(new Error("连接被拒"));
    };
  });
}
const closed = (ws) =>
  new Promise((res) => {
    if (ws.readyState >= WebSocket.CLOSING) return res();
    ws.addEventListener("close", () => res(), { once: true });
  });

// ---- A. 随机码连接洪水：IP 限速应拦截 ----
if (run("A")) {
  const results = await Promise.allSettled(
    Array.from({ length: 40 }, () => connect(code())),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const rejected = results.filter((r) => r.status === "rejected").length;
  console.log(`A: 40 个随机码连接 → 成功 ${ok} / 被拒 ${rejected}`);
  assert(rejected > 0, "A 失败：IP 限速未生效，40 连接全部成功");
  assert(ok > 0, "A 失败：全部被拒，正常连接也被误伤");
  pass(`A IP 限速生效（拦截 ${rejected}/40）`);
  // 洪水连接由攻击侧主动关闭（合法占房会等 WAIT_TTL，不能等服务端）
  for (const r of results) if (r.status === "fulfilled") r.value.close();
  await new Promise((r) => setTimeout(r, 500));
}

if (run("A") && (run("B") || run("C") || run("D"))) {
  console.log("…等待限速窗口冷却 65s");
  await new Promise((r) => setTimeout(r, 65_000));
}

// ---- B. 消息洪水：单房间超速应被断开 ----
if (run("B")) {
  const ws = await connect(code());
  const got = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("未收到 RATE/断开")), 15_000);
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string" && ev.data.includes("RATE")) {
        clearTimeout(t);
        res(ev.data);
      }
    });
    ws.addEventListener("close", () => {
      clearTimeout(t);
      res("closed");
    });
    // 洪水：每 2ms 一条，远超 150msg/s
    const flood = setInterval(() => {
      for (let i = 0; i < 10; i++) ws.send(JSON.stringify({ type: "junk", i }));
    }, 20);
    ws.addEventListener("close", () => clearInterval(flood), { once: true });
  });
  console.log(`B: 洪水触发服务端响应: ${String(got).slice(0, 60)}`);
  await closed(ws);
  pass("B 消息限速生效，洪水连接被断开");
}

// ---- C. 占房挂机：不发 hello 应在握手超时内被断开 ----
if (run("C")) {
  const c = code();
  const ws = await connect(c, { hello: false });
  const start = Date.now();
  let lastMsg = "";
  ws.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") lastMsg = ev.data;
  });
  await closed(ws);
  const elapsed = Date.now() - start;
  console.log(`C: 未握手连接存活 ${elapsed}ms 后被断开（最后消息: ${lastMsg || "无"}）`);
  assert(elapsed < 30_000, "C 失败：超过 30s 仍未断开（HELLO_TIMEOUT 未生效）");
  assert(
    lastMsg.includes("NOHELLO") || elapsed > 5_000,
    "C 失败：秒断，可能是其他错误（非握手超时）",
  );
  pass("C 握手超时生效，占房挂机被清理");
}

// ---- D. 正常链路回归 ----
if (run("D")) {
  const c = code();
  let gotReady = false;
  const desktop = await connect(c, {
    onMessage: (ev) => {
      if (typeof ev.data === "string" && ev.data.includes('"ready"')) gotReady = true;
    },
  });
  const phone = await connect(c, {
    onMessage: (ev) => {
      if (typeof ev.data === "string" && ev.data.includes('"ready"')) gotReady = true;
    },
  });
  for (let i = 0; i < 50 && !gotReady; i++) await new Promise((r) => setTimeout(r, 100));
  assert(gotReady, "D 失败：未收到 ready");
  // 正常速率消息透传（20msg/s × 2s = 40 条，远低于限速）
  let received = 0;
  phone.addEventListener("message", (ev) => {
    if (typeof ev.data === "string" && ev.data.includes("normal")) received++;
  });
  for (let i = 0; i < 40; i++) {
    desktop.send(JSON.stringify({ type: "normal", i }));
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 500));
  assert(received >= 38, `D 失败：正常消息丢失过多（${received}/40）`);
  desktop.close();
  phone.close();
  pass(`D 正常链路不受误伤（透传 ${received}/40）`);
}

console.log("\n全部通过 🎉");
