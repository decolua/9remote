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

# Build agent pkg first (shared with desktop:build), then Tauri
cd "$(git rev-parse --show-toplevel)"
npm run agent:build

cd desktop
npm run tauri build

echo "[Desktop] Done. Bundle in src-tauri/target/release/bundle/"
