#!/usr/bin/env bash
# 构建未签名 iOS IPA（供全能签等工具重签后安装）。需要 macOS + Xcode。
# 用法：bash scripts/build-ios-ipa.sh [输出目录，默认 build-ios]
set -euo pipefail

OUT="${1:-build-ios}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -rf "$OUT"
mkdir -p "$OUT"

# 1. 网页产物 → 同步进原生工程
npm run build
npx cap sync ios

# 2. 不签名地归档（不需要任何证书、描述文件或 Secrets）
xcodebuild archive \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$OUT/App.xcarchive" \
  -skipPackagePluginValidation \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  DEVELOPMENT_TEAM="" \
  | tee "$OUT/xcodebuild.log" | tail -n 40

APP="$OUT/App.xcarchive/Products/Applications/App.app"
test -d "$APP" || { echo "归档里没有 App.app" >&2; exit 1; }

# 3. 打成 IPA（Payload/App.app 压缩包）
mkdir -p "$OUT/ipa/Payload"
cp -R "$APP" "$OUT/ipa/Payload/App.app"
(cd "$OUT/ipa" && zip -qry "../BBX-3D-Arena-unsigned.ipa" Payload)
rm -rf "$OUT/ipa"
echo "已生成 $OUT/BBX-3D-Arena-unsigned.ipa"
