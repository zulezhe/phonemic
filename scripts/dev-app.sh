#!/bin/bash
# 开发版程序的一键更新：构建 PhoneMic Dev.app（独立于正式包），
# 固定证书 "PhoneMic Dev" 签名，静默替换 ~/Applications 里的开发版并启动。
# - 与正式包完全隔离：不同名称（PhoneMic Dev.app）、不同 bundle id（dev.phonemic.desktop.dev）
# - 签名证书固定 → macOS 授权一次永久生效（换 bundle id 后首次可能再弹一次，之后稳定）
# - 只构建 .app，不产 DMG；正式包请用 npm run tauri:build
# - 数据目录 ~/Library/Application Support/phonemic/（CA/token 与正式包、tauri dev 共用）
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
NAME="PhoneMic Dev"
BUILT="src-tauri/target/debug/bundle/macos/PhoneMic Dev.app"
INSTALLED="$HOME/Applications/PhoneMic Dev.app"

if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "$NAME"; then
  echo "❌ 未找到开发签名证书，先运行：npm run dev:setup"
  exit 1
fi

echo "== 构建手机页面"
npm run phone:build >/dev/null

echo "== 构建开发版 App（仅 .app，$NAME 签名）"
APPLE_SIGNING_IDENTITY="$NAME" npx tauri build --debug --config src-tauri/tauri.dev.conf.json --bundles app 2>&1 | tail -3

echo "== 校验签名"
codesign --verify --deep "$BUILT" && echo "✅ 签名有效（$(codesign -dv "$BUILT" 2>&1 | grep Identifier | xargs)）"

echo "== 更新已安装的开发版（$INSTALLED）"
pkill -f "PhoneMic Dev.app/Contents/MacOS" 2>/dev/null || true
pkill -f "target/debug/phonemic$" 2>/dev/null || true
sleep 0.5
mkdir -p "$HOME/Applications"
rm -rf "$INSTALLED"
ditto "$BUILT" "$INSTALLED"
# WKWebView 会缓存旧页面（index.html 无 hash），不清理会出现"已修复却仍运行旧代码"的假象
rm -rf "$HOME/Library/Caches/dev.phonemic.desktop.dev" "$HOME/Library/WebKit/dev.phonemic.desktop.dev" 2>/dev/null || true

echo "== 启动"
open "$INSTALLED"
echo "🚀 已启动 $INSTALLED"
echo "   开发迭代：改完代码再跑一次 npm run dev:app 即更新这个开发版（签名与授权保持不变）"
echo "   正式打包（PhoneMic.app + DMG）：npm run tauri:build"
