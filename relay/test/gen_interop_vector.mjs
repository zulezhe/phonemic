// 生成 Rust↔WebCrypto 互操作测试向量：
// 模拟手机页（WebCrypto P-256 + HKDF + AES-GCM）加密一帧，
// 输出桌面私钥/手机公钥/配对码/密文，供 Rust 单测解密验证。
const te = new TextEncoder();

// 1. 桌面密钥对（导出 jwk 拿 d 与 raw 公钥）
const desktop = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const dJwk = await crypto.subtle.exportKey("jwk", desktop.privateKey);
const dPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", desktop.publicKey));

// 2. 手机临时密钥对（页面运行时生成）
const phone = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const phonePubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", phone.publicKey));

// 3. ECDH + HKDF（与 crypto.rs 完全一致的参数）
const PAIR_CODE = "interop-vector-code-2026";
const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: desktop.publicKey }, phone.privateKey, 256));
const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
const sessionKeyRaw = new Uint8Array(
  await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: te.encode(PAIR_CODE), info: te.encode("phonemic/v1") },
    hkdfKey,
    256,
  ),
);
const aesKey = await crypto.subtle.importKey("raw", sessionKeyRaw, "AES-GCM", false, ["encrypt"]);

// 4. 加密（与手机页 seal 相同：nonce 前置）
const nonce = crypto.getRandomValues(new Uint8Array(12));
const plaintext = te.encode("interop-test-frame-440Hz");
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));
const sealed = new Uint8Array(nonce.length + ct.length);
sealed.set(nonce, 0);
sealed.set(ct, nonce.length);

const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64u = (u8) => btoa(String.fromCharCode(...u8)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log(JSON.stringify(
  {
    desktop_secret_d_hex: hex(new Uint8Array((atob(dJwk.d.replace(/-/g, "+").replace(/_/g, "/"))).match(/./g).map((c) => c.charCodeAt(0)))),
    desktop_pub_b64u: b64u(dPubRaw),
    phone_pub_b64u: b64u(phonePubRaw),
    pair_code: PAIR_CODE,
    sealed_hex: hex(sealed),
    plaintext: "interop-test-frame-440Hz",
  },
  null,
  2,
));
