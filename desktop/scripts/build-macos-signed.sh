#!/usr/bin/env bash
# Build + sign + notarize the macOS desktop app.
# Reads Apple credentials from desktop/.sign.env (gitignored) or shell env.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".sign.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
  echo "[Desktop] Loaded Apple credentials from $ENV_FILE"
else
  echo "[Desktop] No $ENV_FILE found — relying on shell env"
fi

# Required for sign + notarize
required=(
  APPLE_SIGNING_IDENTITY
  APPLE_ID
  APPLE_PASSWORD
  APPLE_TEAM_ID
)
missing=()
for v in "${required[@]}"; do
  [ -z "${!v:-}" ] && missing+=("$v")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "[Desktop] Missing: ${missing[*]}"
  echo "[Desktop] Fill them in desktop/.sign.env (see desktop/.sign.env.example)"
  exit 1
fi

if [ "$(uname)" != "Darwin" ]; then
  echo "[Desktop] Apple signing only works on macOS"
  exit 1
fi

echo "[Desktop] Signing identity: $APPLE_SIGNING_IDENTITY"
echo "[Desktop] Team ID: $APPLE_TEAM_ID"

# Auto-load Tauri updater signing key if present and not set
if [ -f ".sign.key" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && [ -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat .sign.key)"
  # Tauri prompts on the terminal unless the password var exists; empty = key has no password
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
  echo "[Desktop] Loaded Tauri updater signing key from .sign.key"
fi

# Extra args pass through, e.g. --target universal-apple-darwin for Intel + Apple Silicon
npx tauri build "$@"

echo "[Desktop] Done. Bundle in src-tauri/target/release/bundle/"

# Gather into desktop/release/ so all platforms land in one place
bash scripts/collect-artifacts.sh
