# 9Remote Desktop

Tauri 2 wrapper around the `9remote` agent. The app launches the agent (`node cli.cjs ui`) at `localhost:2208` and loads it in a webview, plus a system tray.

- `npm run desktop:dev` — dev mode (agent UI + Vite + Tauri).
- `npm run desktop:build` — build unsigned bundle (agent pkg + Tauri).
- `npm run desktop:build:mac` — build **+ sign + notarize** macOS app (see below).

## macOS signing & notarization

Required so users can open the `.app` / `.dmg` without Gatekeeper warnings. Needs an Apple Developer account (paid).

### 1. Create the signing certificate

1. https://developer.apple.com/account → Certificates, Identifiers & Profiles → Certificates → `+`.
2. Choose **Developer ID Application** (for distribution outside the App Store — *not* "Mac App Distribution").
3. Follow the CSR flow (Keychain Access → Certificate Assistant → Request a Certificate from a Certificate Authority). The private key lands in your login keychain.
4. Download + double-click the `.cer` to install. Now Keychain shows **Developer ID Application: Your Name (TEAMID)**.

### 2. Register the Bundle ID

Bundle ID is `cc.9remote.desktop` (already set in `src-tauri/tauri.conf.json`). No explicit App ID needed for Developer ID signing outside App Store, but ensure no conflicts.

### 3. Create an App-Specific Password (for notarization)

https://appleid.apple.com → Sign-In & Security → **App-Specific Passwords** → generate. Label it e.g. `tauri-notarize`. Save the `xxxx-xxxx-xxxx-xxxx` string — this is `APPLE_PASSWORD` (**not** your iCloud password).

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
npm run desktop:build:mac
```

Output: `desktop/src-tauri/target/release/bundle/{dmg,macos}/`.

The script (`desktop/scripts/build-macos-signed.sh`):
1. Loads `desktop/.sign.env` (or falls back to shell env — useful for CI).
2. Validates the four `APPLE_*` vars.
3. Builds the agent pkg (`agent:build`).
4. Runs `tauri build` — Tauri auto-signs the bundle with `APPLE_SIGNING_IDENTITY`, then notarizes with `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`, then staples the ticket.

### Notes

- `entitlements.plist` keeps `app-sandbox=false` (needed for screen capture + apple-events; incompatible with Mac App Store).
- First notarization can take 5–15 min.
- Verify: `spctl -a -vvv -t exec path/to/9Remote.app` should print `accepted`.
- The agent core (`9remote` npm package) auto-updates on its own via `spawn_background_update` in `src-tauri/src/lib.rs`. The Tauri shell itself does **not** auto-update yet — to ship a new shell you rebuild + redistribute the `.dmg`.
