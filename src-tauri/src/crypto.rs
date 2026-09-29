//! E2EE（仅中继路径）：P-256 ECDH + HKDF-SHA256 派生会话密钥 + AES-256-GCM 帧加密。
//! 选择 P-256 而非 X25519：微信内置浏览器等国内内核的 WebCrypto 普遍不支持 X25519，
//! P-256 是全平台保底（2015 年起）。本地路径走 TLS、打洞路径走 DTLS，均无需此层。
//!
//! 密钥协商：手机生成临时 P-256 密钥对，用二维码里桌面公钥（带外可信）做 ECDH；
//! K = HKDF-SHA256(shared, salt=配对码, info="phonemic/v1")。公钥经中继明文首帧交换。

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use hkdf::Hkdf;
use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand::RngCore;
use sha2::Sha256;

pub const HKDF_INFO: &[u8] = b"phonemic/v1";
pub const NONCE_LEN: usize = 12;

/// 桌面静态密钥对（sec1 raw 65B 公钥 / 32B 私钥，持久化在数据目录）
#[derive(Clone)]
pub struct KeyPair {
    pub secret: SecretKey,
    pub public: PublicKey,
}

pub fn b64u_encode(data: &[u8]) -> String {
    B64URL.encode(data)
}

pub fn b64u_decode(s: &str) -> Result<Vec<u8>> {
    B64URL
        .decode(s.trim_end_matches('='))
        .or_else(|_| B64URL.decode(s))
        .with_context(|| format!("base64url 解码失败: {s}"))
}

impl KeyPair {
    pub fn generate() -> Result<Self> {
        let mut bytes = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut bytes);
        let secret = SecretKey::from_slice(&bytes).map_err(|e| anyhow!("生成私钥失败: {e:?}"))?;
        let public = secret.public_key();
        Ok(Self { secret, public })
    }

    pub fn public_sec1(&self) -> Vec<u8> {
        self.public.to_encoded_point(false).as_bytes().to_vec()
    }

    pub fn public_b64u(&self) -> String {
        b64u_encode(&self.public_sec1())
    }
}

/// 从对端（手机）临时公钥 + 本端私钥 + 配对码派生会话密钥
pub fn derive_session_key(my_secret: &SecretKey, peer_public_sec1: &[u8], pair_code: &str) -> Result<aes_gcm::Aes256Gcm> {
    let peer = PublicKey::from_sec1_bytes(peer_public_sec1)
        .map_err(|e| anyhow!("对端公钥解析失败: {e:?}"))?;
    let shared = diffie_hellman(my_secret.to_nonzero_scalar(), peer.as_affine());
    let hk = Hkdf::<Sha256>::new(Some(pair_code.as_bytes()), shared.raw_secret_bytes());
    let mut key = [0u8; 32];
    hk.expand(HKDF_INFO, &mut key).map_err(|e| anyhow!("HKDF: {e}"))?;
    Ok(Aes256Gcm::new_from_slice(&key).unwrap())
}

/// 加密一帧明文 payload → [12B nonce][ct||tag]
pub fn seal(cipher: &Aes256Gcm, plaintext: &[u8]) -> Vec<u8> {
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let ct = cipher.encrypt(Nonce::from_slice(&nonce_bytes), Payload::from(plaintext)).expect("aes-gcm encrypt");
    let mut out = Vec::with_capacity(NONCE_LEN + ct.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ct);
    out
}

/// 解密 [12B nonce][ct||tag] → 明文
pub fn open(cipher: &Aes256Gcm, sealed: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < NONCE_LEN + 16 {
        return Err(anyhow!("密文过短"));
    }
    let (nonce, ct) = sealed.split_at(NONCE_LEN);
    cipher
        .decrypt(Nonce::from_slice(nonce), Payload::from(ct))
        .map_err(|_| anyhow!("AES-GCM 解密失败"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecdh_both_sides_same_key() {
        // 双方各自 ECDH 应派生出同一把会话密钥
        let desktop = KeyPair::generate().unwrap();
        let phone = KeyPair::generate().unwrap();
        let code = "testpaircode123";
        let k1 = derive_session_key(&desktop.secret, &phone.public_sec1(), code).unwrap();
        let k2 = derive_session_key(&phone.secret, &desktop.public_sec1(), code).unwrap();
        // 用双方各自派生的密钥加解密往返
        let sealed = seal(&k1, b"hello phonemic");
        assert_eq!(open(&k2, &sealed).unwrap(), b"hello phonemic");
    }

    #[test]
    fn b64u_roundtrip() {
        let data = [0u8, 1, 2, 250, 255, 128];
        assert_eq!(b64u_decode(&b64u_encode(&data)).unwrap(), data);
        assert_eq!(b64u_encode(&[0xff; 5]).len(), 7);
    }

    /// 跨语言互操作向量：relay/test/gen_interop_vector.mjs 用浏览器同款 WebCrypto
    /// （P-256 ECDH + HKDF-SHA256 + AES-GCM）加密，Rust 侧解密验证。
    #[test]
    fn webcrypto_interop() {
        let d_hex = "7730b7d81140e95f2cbc3ad2d2a302273971715305a0cabe1c01a76939334ee5";
        let phone_pub = "BDPjBsxGCUWPNQK3cw2PmyrTzKisykzPQTuAQClo9Qucsv4e_708vda3mAzsW2HiA8CJaW3t872sWywhPxuO7eA";
        let sealed_hex = "58528451017ca1ef388bdd3bdf4daf8a629e09f8839dfdb4fed400f9199173ae42bbbecd99a6431b09ffd7f8dabc2bdbe800f3f5";
        let code = "interop-vector-code-2026";

        let d = hex_decode(d_hex);
        let secret = SecretKey::from_slice(&d).unwrap();
        let peer = b64u_decode(phone_pub).unwrap();
        let sealed = hex_decode(sealed_hex);

        let cipher = derive_session_key(&secret, &peer, code).unwrap();
        let plain = open(&cipher, &sealed).expect("WebCrypto 加密的帧必须能被 Rust 解密");
        assert_eq!(plain, b"interop-test-frame-440Hz");
    }

    fn hex_decode(s: &str) -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    }
}
