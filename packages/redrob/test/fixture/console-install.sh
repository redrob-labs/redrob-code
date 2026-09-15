#!/bin/sh
#
# Redrob Code installer.
#
#   curl -fsSL https://console.redrob.ai/code/install.sh | sh
#
# It works out your OS and CPU, downloads the matching build, checks it against the published
# checksum, and puts the redrob-code binary in $HOME/.redrob/bin.
#
# It downloads from one place: the base URL below, which Console writes into this file. If that is
# empty, the builds are not published yet and the script says so and stops. It does not look for a
# release on any other host.
#
# Environment:
#   REDROB_CODE_DOWNLOAD_BASE   Where the builds are. Overrides the value in this file.
#   REDROB_CODE_VERSION         Which build to fetch. Default: latest
#   REDROB_CODE_INSTALL_DIR     Where to put the binary. Default: $HOME/.redrob/bin
#   REDROB_CODE_BIN             A redrob-code you already built. Installed instead of downloading.
#   REDROB_CODE_SKIP_CHECKSUM   Set to 1 to accept a build with no published checksum.

set -eu

DOWNLOAD_BASE="${REDROB_CODE_DOWNLOAD_BASE:-}"
VERSION="${REDROB_CODE_VERSION:-latest}"
INSTALL_DIR="${REDROB_CODE_INSTALL_DIR:-$HOME/.redrob/bin}"
BIN_NAME="redrob-code"
CONSOLE_URL="https://console.redrob.ai"

say() {
  printf '%s\n' "$*"
}

warn() {
  printf '%s\n' "$*" >&2
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

usage() {
  say "Installs Redrob Code into $INSTALL_DIR."
  say ""
  say "Usage:  curl -fsSL https://console.redrob.ai/code/install.sh | sh"
  say ""
  say "Environment:"
  say "  REDROB_CODE_DOWNLOAD_BASE   where the builds are"
  say "  REDROB_CODE_VERSION         which build to fetch (default $VERSION)"
  say "  REDROB_CODE_INSTALL_DIR     where to put the binary (default $INSTALL_DIR)"
  say "  REDROB_CODE_BIN             install a redrob-code you already have"
  say "  REDROB_CODE_SKIP_CHECKSUM   set to 1 to accept a build with no published checksum"
  say ""
  say "The page explaining all of this is at $CONSOLE_URL/code"
}

case "${1:-}" in
  -h | --help)
    usage
    exit 0
    ;;
  "") ;;
  *)
    die "Unknown argument: $1. Run with --help."
    ;;
esac

detect_platform() {
  uname_s="$(uname -s 2>/dev/null || echo unknown)"
  uname_m="$(uname -m 2>/dev/null || echo unknown)"

  case "$uname_s" in
    Darwin) OS="darwin" ;;
    Linux) OS="linux" ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      die "There is no Windows build of Redrob Code. $CONSOLE_URL/code says what there is."
      ;;
    *)
      die "Redrob Code does not have a build for $uname_s. macOS and Linux are the two it will have."
      ;;
  esac

  case "$uname_m" in
    x86_64 | amd64) ARCH="x64" ;;
    arm64 | aarch64) ARCH="arm64" ;;
    *)
      die "Redrob Code does not have a build for $uname_m. x86_64 and arm64 are the two it will have."
      ;;
  esac
}

fetch_to() {
  fetch_url="$1"
  fetch_dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$fetch_url" -o "$fetch_dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$fetch_dest" "$fetch_url"
  else
    die "Neither curl nor wget is on this machine, so nothing can be downloaded."
  fi
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die "Neither sha256sum nor shasum is on this machine, so the download cannot be verified."
  fi
}

install_binary() {
  mkdir -p "$INSTALL_DIR"
  cp "$1" "$INSTALL_DIR/$BIN_NAME"
  chmod 755 "$INSTALL_DIR/$BIN_NAME"
}

path_hint() {
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      say ""
      say "$INSTALL_DIR is not on your PATH. Add this to your shell profile:"
      printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR"
      ;;
  esac
}

next_steps() {
  say ""
  say "Next: Redrob is prepaid, so a new workspace pays before anything will answer."
  say "  Add credit:      $CONSOLE_URL/start"
  say "  How it works:    $CONSOLE_URL/guide"
  say "  Building on it:  $CONSOLE_URL/docs"
  say ""
  say "Signing this machine in to a workspace is built. Run this, choose Connect Redrob, and approve"
  say "the code it shows at $CONSOLE_URL/connect:"
  say "  $BIN_NAME providers login --provider redrob"
  say "A key pasted from $CONSOLE_URL/api-keys still works, and is the fallback for a machine that"
  say "cannot reach Console."
}

not_published() {
  warn "Redrob Code binaries are not published yet."
  warn ""
  warn "This script is real, and this is the honest state of it: no download location is configured,"
  warn "so there is nothing for it to fetch. The archives are built by the redrob-code release, and"
  warn "this same command works the day one is uploaded. Nothing was installed and nothing was changed."
  warn ""
  warn "Two ways to run the engine before then:"
  warn "  1. Build it from a local redrob-code checkout, then install that binary with this script:"
  warn "       REDROB_CODE_BIN=/path/to/redrob-code sh install.sh"
  warn "  2. Run the binary from the checkout directly, without installing it."
  warn ""
  warn "If you host builds yourself, point the script at them:"
  warn "  REDROB_CODE_DOWNLOAD_BASE=https://example.com/redrob-code sh install.sh"
  warn ""
  warn "What is ready today: credit at $CONSOLE_URL/start, the API at $CONSOLE_URL/docs, and"
  warn "$CONSOLE_URL/code, which says exactly what this message says."
  exit 1
}

if [ -n "${REDROB_CODE_BIN:-}" ]; then
  [ -f "$REDROB_CODE_BIN" ] || die "REDROB_CODE_BIN is $REDROB_CODE_BIN, which is not a file."
  [ -x "$REDROB_CODE_BIN" ] || die "REDROB_CODE_BIN is $REDROB_CODE_BIN, which is not executable."
  install_binary "$REDROB_CODE_BIN"
  say "Installed $INSTALL_DIR/$BIN_NAME from REDROB_CODE_BIN."
  path_hint
  next_steps
  exit 0
fi

[ -n "$DOWNLOAD_BASE" ] || not_published

detect_platform

ASSET="$BIN_NAME-$OS-$ARCH.tar.gz"
ASSET_URL="$DOWNLOAD_BASE/$VERSION/$ASSET"

TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t redrob-code)"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

say "Downloading $BIN_NAME $VERSION for $OS/$ARCH."
fetch_to "$ASSET_URL" "$TMP_DIR/$ASSET" ||
  die "Could not download $ASSET_URL. If that build does not exist, $CONSOLE_URL/code lists what does."

if fetch_to "$ASSET_URL.sha256" "$TMP_DIR/$ASSET.sha256" 2>/dev/null; then
  EXPECTED="$(cut -d ' ' -f 1 <"$TMP_DIR/$ASSET.sha256" | tr -d '\r\n')"
  ACTUAL="$(sha256_of "$TMP_DIR/$ASSET")"
  [ -n "$EXPECTED" ] || die "The checksum at $ASSET_URL.sha256 is empty, so the download cannot be verified."
  [ "$EXPECTED" = "$ACTUAL" ] ||
    die "Checksum mismatch for $ASSET. Expected $EXPECTED and got $ACTUAL. Nothing was installed."
  say "Checksum verified."
elif [ "${REDROB_CODE_SKIP_CHECKSUM:-}" = "1" ]; then
  warn "No checksum published at $ASSET_URL.sha256. Installing anyway: REDROB_CODE_SKIP_CHECKSUM=1."
else
  die "No checksum published at $ASSET_URL.sha256, so this download cannot be verified. Nothing was installed. Set REDROB_CODE_SKIP_CHECKSUM=1 to install it anyway."
fi

mkdir -p "$TMP_DIR/unpacked"
tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR/unpacked" || die "$ASSET is not a readable tar.gz archive."

BINARY="$(find "$TMP_DIR/unpacked" -type f -name "$BIN_NAME" 2>/dev/null | head -n 1)"
[ -n "$BINARY" ] || die "$ASSET does not contain a $BIN_NAME binary."

install_binary "$BINARY"
say "Installed $INSTALL_DIR/$BIN_NAME."
path_hint
next_steps
