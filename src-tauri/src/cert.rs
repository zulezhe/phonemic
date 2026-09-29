//! 自签 CA 与服务器证书：首次生成后持久化在数据目录，手机只需信任一次。
//! 服务器证书 SAN 覆盖局域网 IP / 127.0.0.1 / phonemic.local；IP 变化时自动重签（CA 不变）。

use anyhow::{Context, Result};
use rcgen::{BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, KeyPair};
use std::fs;
use std::net::IpAddr;
use std::path::Path;

pub const CA_PEM: &str = "ca.pem";
pub const CA_KEY: &str = "ca.key";
pub const SERVER_PEM: &str = "server.pem";
pub const SERVER_KEY: &str = "server.key";
pub const SANS_FILE: &str = "sans.txt";

#[derive(Clone, Debug)]
pub struct TlsMaterial {
    pub ca_pem: String,
    pub server_pem: String,
    pub server_key_pem: String,
    /// CA 证书 DER 的 base64（嵌入 iOS 描述文件用）
    pub ca_der_b64: String,
    /// 生成证书时使用的 SAN（用于判断 IP 变化）
    pub sans: Vec<String>,
}

/// 数据目录为空或不可写时返回 None —— HTTPS 不可用，仅本机 HTTP 模式。
pub fn load_or_create(dir: &Path, ips: &[IpAddr], extra_dns: &[&str]) -> Result<TlsMaterial> {
    fs::create_dir_all(dir).with_context(|| dir.display().to_string())?;

    let mut sans: Vec<String> = ips.iter().map(|i| i.to_string()).collect();
    sans.push("127.0.0.1".into());
    sans.extend(extra_dns.iter().map(|s| s.to_string()));
    sans.sort();
    sans.dedup();
    let sans_key = sans.join(",");

    // CA：长期稳定，避免手机重复信任
    let ca_pem_path = dir.join(CA_PEM);
    let ca_key_path = dir.join(CA_KEY);
    let (ca_pem, ca_key_pem) = if ca_pem_path.exists() && ca_key_path.exists() {
        (
            fs::read_to_string(&ca_pem_path)?,
            fs::read_to_string(&ca_key_path)?,
        )
    } else {
        let key = KeyPair::generate()?;
        let mut params = CertificateParams::default();
        params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "PhoneMic Root CA");
        params.distinguished_name = dn;
        let cert = params.self_signed(&key)?;
        let (pem, kpem) = (cert.pem(), key.serialize_pem());
        fs::write(&ca_pem_path, &pem)?;
        fs::write(&ca_key_path, &kpem)?;
        (pem, kpem)
    };
    // 解析既有 CA（x509-parser），并重建等价的签发者证书：DN/密钥标识/用法与原 CA 一致，
    // 且由同一 CA 私钥签名，作为 issuer 与原证书等价。
    let ca_params = CertificateParams::from_ca_cert_pem(&ca_pem).context("解析 CA 证书失败")?;
    let ca_key = KeyPair::from_pem(&ca_key_pem)?;
    let ca_cert = ca_params.self_signed(&ca_key)?;

    // 服务器证书：SAN 变化（换网络）才重签
    let sans_path = dir.join(SANS_FILE);
    let need_new = !dir.join(SERVER_PEM).exists()
        || !dir.join(SERVER_KEY).exists()
        || fs::read_to_string(&sans_path).unwrap_or_default() != sans_key;

    if need_new {
        let server_key = KeyPair::generate()?;
        // CertificateParams::new 接受字符串列表，IP/DNS 自动识别
        let mut params = CertificateParams::new(sans.clone())?;
        let mut dn = DistinguishedName::new();
        dn.push(DnType::CommonName, "PhoneMic");
        params.distinguished_name = dn;
        let cert = params.signed_by(&server_key, &ca_cert, &ca_key)?;
        fs::write(dir.join(SERVER_PEM), cert.pem())?;
        fs::write(dir.join(SERVER_KEY), server_key.serialize_pem())?;
        fs::write(&sans_path, &sans_key)?;
    }

    let server_pem = fs::read_to_string(dir.join(SERVER_PEM))?;
    let server_key_pem = fs::read_to_string(dir.join(SERVER_KEY))?;

    // CA PEM → DER base64
    let ca_der = pem_to_der(&ca_pem)?;
    let ca_der_b64 = b64_encode(&ca_der);

    Ok(TlsMaterial { ca_pem, server_pem, server_key_pem, ca_der_b64, sans })
}

/// 极简 PEM → DER（单证书，去头尾与换行）
fn pem_to_der(pem: &str) -> Result<Vec<u8>> {
    let body = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    Ok(b64_decode(&body)?)
}

// 不引 base64 crate：自己实现标准 base64（证书场景足够）
const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}
fn b64_decode(s: &str) -> Result<Vec<u8>> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        let v = B64.iter().position(|&x| x == c).context("非法 base64")? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

fn uuid() -> String {
    let mut rng = rand::thread_rng();
    use rand::Rng;
    let hex: String = (0..32).map(|_| format!("{:x}", rng.gen::<u8>() & 15)).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// iOS 安装 CA 用的描述文件
pub fn mobileconfig(ca_der_b64: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key><string>com.apple.security.root</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>PayloadIdentifier</key><string>dev.phonemic.ca</string>
      <key>PayloadUUID</key><string>{uuid1}</string>
      <key>PayloadDisplayName</key><string>PhoneMic Root CA</string>
      <key>PayloadDescription</key><string>PhoneMic 局域网 HTTPS 根证书</string>
      <key>PayloadContent</key><data>{ca}</data>
    </dict>
  </array>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadVersion</key><integer>1</integer>
  <key>PayloadIdentifier</key><string>dev.phonemic.profile</string>
  <key>PayloadUUID</key><string>{uuid2}</string>
  <key>PayloadDisplayName</key><string>PhoneMic CA</string>
  <key>PayloadRemovalDisallowed</key><false/>
</dict>
</plist>"#,
        uuid1 = uuid(),
        uuid2 = uuid(),
        ca = ca_der_b64
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn create_and_reuse() {
        let dir = std::env::temp_dir().join(format!("pm-cert-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ips = vec![IpAddr::V4(Ipv4Addr::new(192, 168, 1, 5))];
        let m1 = load_or_create(&dir, &ips, &["phonemic.local"]).unwrap();
        assert!(m1.ca_pem.contains("BEGIN CERTIFICATE"));
        assert!(m1.sans.contains(&"192.168.1.5".to_string()));
        assert!(m1.sans.contains(&"phonemic.local".to_string()));

        // 再次加载：CA 不变（PEM 一致）
        let m2 = load_or_create(&dir, &ips, &["phonemic.local"]).unwrap();
        assert_eq!(m1.ca_pem, m2.ca_pem);

        // IP 变化：CA 不变、服务器证书重签
        let ips2 = vec![IpAddr::V4(Ipv4Addr::new(10, 0, 0, 2))];
        let m3 = load_or_create(&dir, &ips2, &["phonemic.local"]).unwrap();
        assert_eq!(m1.ca_pem, m3.ca_pem);
        assert!(m3.sans.contains(&"10.0.0.2".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mobileconfig_shape() {
        let cfg = mobileconfig("QUJD");
        assert!(cfg.contains("com.apple.security.root"));
        assert!(cfg.contains("<data>QUJD</data>"));
        assert!(cfg.contains("<!DOCTYPE plist"));
    }

    #[test]
    fn b64_roundtrip() {
        for data in [&b""[..], b"f", b"fo", b"foo", b"foob", b"fooba", b"foobar"] {
            assert_eq!(b64_decode(&b64_encode(data)).unwrap(), data);
        }
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
    }
}
