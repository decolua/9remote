#!/usr/bin/env bash
# Cross-compile the Windows build from macOS via cargo-xwin.
# Produces both a portable exe and an NSIS installer. Neither is code-signed.
#
# One-time setup:
#   rustup target add x86_64-pc-windows-msvc
#   cargo install cargo-xwin --locked
#   brew install llvm makensis     # llvm-lib for ring, makensis for the installer
set -euo pipefail

cd "$(dirname "$0")/.."

TARGET="x86_64-pc-windows-msvc"
LLVM_BIN="$(brew --prefix llvm 2>/dev/null)/bin"
[ -d "$LLVM_BIN" ] && export PATH="$LLVM_BIN:$PATH"

for tool in cargo-xwin makensis llvm-lib; do
  command -v "$tool" >/dev/null || { echo "[Desktop] Missing $tool — see setup notes in this script"; exit 1; }
done

# Auto-load Tauri updater signing key if present and not set
if [ -f ".sign.key" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  export TAURI_SIGNING_PRIVATE_KEY_PATH="$(pwd)/.sign.key"
  echo "[Desktop] Loaded Tauri updater signing key from .sign.key"
fi

npx tauri build --runner cargo-xwin --target "$TARGET" --bundles nsis

OUT="src-tauri/target/$TARGET/release"
echo "[Desktop] Portable : $OUT/9Remote.exe"
echo "[Desktop] Installer: $OUT/bundle/nsis/9Remote_*-setup.exe"

# Gather into desktop/release/ so all platforms land in one place
bash scripts/collect-artifacts.sh
