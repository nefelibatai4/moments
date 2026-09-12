#!/usr/bin/env bash
# Moments iOS 打包脚本
# 用途：在 macOS（已装 Xcode）上，一键构建出可安装的 IPA
# 用法：./build-ios.sh
# 前置：仅需 Xcode（Capacitor 8 使用 Swift Package Manager，无需 CocoaPods）

set -euo pipefail

echo "=============================================="
echo " Moments iOS 打包脚本"
echo "=============================================="

# 1. 同步 web 资源到 iOS 工程（构建 App 版 + cap sync）
echo "[1/4] 构建前端并同步到 iOS 工程..."
npm run cap:sync

# 2. 构建 Archive（无需开发者账号也能 archive，签名需账号/证书）
echo "[2/4] 构建 Archive..."
cd ios/App
xcodebuild -project App.xcodeproj \
  -scheme App \
  -configuration Release \
  -archivePath build/App.xcarchive \
  archive \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  | tail -20
cd ../..

# 3. 导出 IPA（未签名，用于模拟器测试/后续签名）
echo "[3/4] 导出未签名 IPA..."
cd ios/App
xcodebuild -exportArchive \
  -archivePath build/App.xcarchive \
  -exportOptionsPlist ../../exportOptions.plist \
  -exportPath build/ipa \
  | tail -20
cd ../..

echo "[4/4] 完成！"
echo "=============================================="
echo " IPA 位置: ios/App/build/ipa/App.ipa"
echo ""
echo " ⚠️ 此 IPA 未签名，无法直接安装到真机。"
echo " 要安装到真机，需配置 Apple 开发者账号 + 证书签名。"
echo "=============================================="
