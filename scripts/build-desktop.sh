#!/bin/zsh
set -e
cd "${0:A:h:h}"
mkdir -p Orbit.app/Contents/MacOS Orbit.app/Contents/Resources data/build-cache
cat > Orbit.app/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Orbit</string>
  <key>CFBundleExecutable</key><string>Orbit</string>
  <key>CFBundleIconFile</key><string>Orbit</string>
  <key>CFBundleIdentifier</key><string>dev.orbit.local</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Orbit</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>3.1.0</string>
  <key>CFBundleVersion</key><string>5</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
swiftc -module-cache-path data/build-cache -target arm64-apple-macos13.0 -swift-version 5 -O -framework Cocoa -framework WebKit native/Orbit.swift -o Orbit.app/Contents/MacOS/Orbit
if [[ ! -f Orbit.app/Contents/Resources/Orbit.icns ]]; then
  swift -module-cache-path data/build-cache native/Icon.swift data/Orbit.iconset
  iconutil -c icns data/Orbit.iconset -o Orbit.app/Contents/Resources/Orbit.icns
fi
xattr -d com.apple.FinderInfo Orbit.app 2>/dev/null || true
xattr -d 'com.apple.fileprovider.fpfs#P' Orbit.app 2>/dev/null || true
xattr -cr Orbit.app
codesign --force --deep --sign - Orbit.app
codesign --verify --deep --strict Orbit.app
