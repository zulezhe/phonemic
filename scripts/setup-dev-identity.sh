#!/bin/bash
# 一次性创建固定的开发代码签名证书 "PhoneMic Dev"。
# macOS 的权限弹窗（本地网络等）跟随代码签名：tauri dev 每次重编译都是新的临时签名，
# 导致反复弹窗。用这个固定证书签名 dev 版 App，授权一次永久生效。
set -u
NAME="PhoneMic Dev"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if security find-identity -v -p codesigning 2>/dev/null | grep -q "$NAME"; then
  echo "✅ 证书已存在：$NAME"
  security find-identity -v -p codesigning | grep "$NAME"
  exit 0
fi

echo "== 生成自签名代码签名证书（10 年有效）"
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout "$TMP/dev.key" -out "$TMP/dev.pem" \
  -subj "/CN=$NAME" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" || { echo "openssl 生成失败"; exit 1; }

echo "== 导入登录钥匙串"
security import "$TMP/dev.key" -k "$HOME/Library/Keychains/login.keychain-db" -T /usr/bin/codesign 2>/dev/null \
  || echo "（私钥可能已存在，忽略）"
security import "$TMP/dev.pem" -k "$HOME/Library/Keychains/login.keychain-db" -T /usr/bin/codesign

echo "== 设置代码签名信任（可能弹出密码确认，这就是唯一需要你授权的步骤）"
if security add-trusted-cert -p codeSign -k "$HOME/Library/Keychains/login.keychain-db" "$TMP/dev.pem" 2>/dev/null; then
  echo "✅ 已自动信任"
else
  echo "⚠️ 自动信任未完成，请手动操作（约 30 秒，仅一次）："
  echo "   打开 钥匙串访问（Keychain Access）→ 登录 → 证书 → 双击「$NAME」"
  echo "   → 展开「信任」→ 使用此证书时选择「始终信任」（Code Signing）→ 关闭并输入密码"
fi

echo
echo "== 结果"
security find-identity -v -p codesigning | grep "$NAME" && echo "✅ 完成。之后用 npm run dev:app 构建稳定签名的开发版 App" \
  || echo "❌ 未找到证书，请按上面手动步骤完成后重跑本脚本"
