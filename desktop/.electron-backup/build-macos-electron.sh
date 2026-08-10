#!/usr/bin/env bash
# Build + sign + notarize the macOS Electron app.
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

required=(APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID)
missing=()
for v in "${required[@]}"; do
  [ -z "${!v:-}" ] && missing+=("$v")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "[Desktop] Missing: ${missing[*]}"
  exit 1
fi

if [ "$(uname)" != "Darwin" ]; then
  echo "[Desktop] Apple signing only works on macOS"
  exit 1
fi

echo "[Desktop] Signing identity: $APPLE_SIGNING_IDENTITY"

# electron-builder reads these names, not Tauri's — and rejects the cert-type prefix
export CSC_NAME="${APPLE_SIGNING_IDENTITY#Developer ID Application: }"
export APPLE_APP_SPECIFIC_PASSWORD="$APPLE_PASSWORD"

# Bundle the agent first — extraResources copies agent/dist into the .app
cd "$(git rev-parse --show-toplevel)"
npm run agent:build

cd desktop
npx electron-builder --mac

# Notarize the DMG rather than the .app: electron-builder's pre-flight codesign
# check runs `codesign --deep` by bundle name, which resolves to any installed
# copy of 9Remote.app instead of the freshly built one.
DMG=$(ls -t release/*.dmg | head -1)
echo "[Desktop] Notarizing $DMG"
xcrun notarytool submit "$DMG" \
  --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple "$DMG"

echo "[Desktop] Done. Bundle in desktop/release/"
