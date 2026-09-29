// PhoneMic PWA：网络优先、离线兜底（避免缓存旧版页面）
const SHELL = "./";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open("phonemic-v1").then((c) => c.add(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== "phonemic-v1").map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).pathname.startsWith("/ws")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (e.request.mode === "navigate") {
          const clone = res.clone();
          caches.open("phonemic-v1").then((c) => c.put(SHELL, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((m) => m ?? caches.match(SHELL))),
  );
});
