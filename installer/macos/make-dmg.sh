#!/usr/bin/env bash
# Wrap a signed `redrob` binary in `Redrob Code.app` and ship it as a DMG.
#
# Redrob Launcher installs macOS apps from a DMG holding an `.app` whose Info.plist names the
# suite's bundle id (`ai.redrob.code`) and version, signed by the organization's Developer ID. The
# engine is a command-line program, so the bundle is a shell for it: `Contents/MacOS/redrob` is the
# very binary `sign-macos` already signed and notarized, and nothing else is added. The launcher
# then points `~/.redrob/bin/redrob` at that binary (its `engine_link`), which is where every
# Redrob app and the engine's own installer look.
#
# Usage: installer/macos/make-dmg.sh <signed redrob binary> <version> <macos-aarch64|macos-x86_64> <out dir>
# Env:   APPLE_SIGNING_IDENTITY, APPLE_SIGNING_KEYCHAIN -- to sign the bundle (the binary inside
#        keeps its own signature); unset = unsigned bundle, for a local look at the layout.
# Out:   <out dir>/redrob-code-<version>-<token>.dmg (NOT notarized or stapled: the workflow does
#        that, with the credentials it already holds).
set -euo pipefail

binary="${1:?signed redrob binary}"
version="${2:?version, e.g. 0.6.6}"
token="${3:?macos-aarch64 or macos-x86_64}"
out="${4:?output directory}"
case "$token" in macos-aarch64|macos-x86_64) ;; *) echo "unknown macOS token: $token" >&2; exit 2 ;; esac

name="Redrob Code"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
app="$stage/$name.app"
mkdir -p "$app/Contents/MacOS"
cp "$binary" "$app/Contents/MacOS/redrob"
chmod 755 "$app/Contents/MacOS/redrob"
# A numeric CFBundleVersion: MSI-style, the prerelease part is dropped.
numeric="${version%%-*}"
cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>ai.redrob.code</string>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundleExecutable</key><string>redrob</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$numeric</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHumanReadableCopyright</key><string>Copyright Janghoon Lee (Redrob) and contributors</string>
</dict>
</plist>
PLIST

if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp \
    --keychain "${APPLE_SIGNING_KEYCHAIN:?}" --sign "$APPLE_SIGNING_IDENTITY" "$app" 1>&2
  codesign --verify --strict --deep --verbose=2 "$app" 1>&2
else
  echo "APPLE_SIGNING_IDENTITY unset: bundle left unsigned" >&2
fi

mkdir -p "$out"
dmg="$out/redrob-code-$version-$token.dmg"
rm -f "$dmg"
# A plain compressed image of the bundle; the launcher mounts it and copies the .app out, and a
# person can drag it to Applications. hdiutil on the hosted macOS runners fails now and then with
# "Resource busy" right after another image operation, so it gets a few tries, and its output goes
# to stderr so a failure says why (stdout is the path, for the caller).
attempt=0
until hdiutil create -format UDZO -ov -volname "$name $version" -srcfolder "$app" "$dmg" 1>&2; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 4 ]; then
    echo "hdiutil create failed $attempt times" >&2
    exit 1
  fi
  echo "hdiutil create failed (attempt $attempt); retrying" >&2
  sleep 5
done
echo "$dmg"
