# 9Remote Desktop

Electron wrapper around the `9remote` agent. The app launches the agent (`cli.cjs ui --start`) at `localhost:2208` and loads it in a window, plus a system tray. Electron ships its own Node, so the agent runs without a system Node install.

- `npm run pc:dev` — dev mode (agent + Vite + Electron).
- `npm run pc:build` — build **+ sign + notarize** macOS app (see below).

## macOS signing & notarization

Required so users can open the `.app` / `.dmg` without Gatekeeper warnings. Needs an Apple Developer account (paid).

### 1. Create the signing certificate

1. https://developer.apple.com/account → Certificates, Identifiers & Profiles → Certificates → `+`.
2. Choose **Developer ID Application** (for distribution outside the App Store — *not* "Mac App Distribution").
3. Follow the CSR flow (Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority). The private key lands in your login keychain.
4. Download + double-click the `.cer` to install. Now Keychain shows **Developer ID Application: Your Name (TEAMID)**.

### 2. Register the Bundle ID

Bundle ID is `cc.9remote.desktop` (already set in `desktop/package.json` → `build.appId`). No explicit App ID needed for Developer ID signing outside App Store, but ensure no conflicts.

### 3. Create an App-Specific Password (for notarization)

https://appleid.apple.com → Sign-In & Security → **App-Specific Passwords** → generate. Label it e.g. `9remote-notarize`. Save the `xxxx-xxxx-xxxx-xxxx` string — this is `APPLE_PASSWORD` (**not** your iCloud password).

### 4. Find your Team ID

https://developer.apple.com/account → **Membership Details** → **Team ID** (10 characters).

### 5. Fill in credentials

```bash
cd desktop
cp .sign.env.example .sign.env
# Edit .sign.env:
#   APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
#   APPLE_ID=you@example.com
#   APPLE_PASSWORD=xxxx-xxxx-xxxx-xxxx
#   APPLE_TEAM_ID=XXXXXXXXXX
```

`.sign.env` is gitignored — never commit it.

### 6. Build

From repo root:

```bash
npm run pc:build
```

Output: `desktop/release/` (`*.dmg` + `mac-arm64/9Remote.app`).

The script (`desktop/scripts/build-macos-electron.sh`):
1. Loads `desktop/.sign.env` (or falls back to shell env — useful for CI).
2. Validates the four `APPLE_*` vars.
3. Builds the agent pkg (`agent:build`).
4. Runs `electron-builder --mac` — signs with `CSC_NAME` (identity name without the `Developer ID Application: ` prefix).
5. Notarizes the `.dmg` with `notarytool`, then staples the ticket. The DMG is notarized instead of the `.app` because electron-builder's pre-flight `codesign --deep` resolves the bundle by name and can hit an installed copy.

### Notes

- `entitlements.plist` keeps `app-sandbox=false` (needed for screen capture + apple-events; incompatible with Mac App Store).
- First notarization can take 5–15 min.
- Verify: `spctl -a -vvv -t exec path/to/9Remote.app` should print `accepted`.
- The agent core (`9remote` npm package) auto-updates on its own. The Electron shell itself does **not** auto-update yet — to ship a new shell you rebuild + redistribute the `.dmg`.
