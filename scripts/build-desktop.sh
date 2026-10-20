#!/bin/zsh
set -e
cd "${0:A:h:h}"
mkdir -p Orbit.app/Contents/MacOS data/build-cache
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
