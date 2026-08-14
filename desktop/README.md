# 9Remote Desktop

Tauri wrapper around the `9remote` agent. The app launches the agent (`cli.cjs ui --start`) at `localhost:2208` and loads it in a webview window, plus a system tray. It uses the system webview (WKWebView on macOS, WebView2 on Windows), so the bundle stays ~11MB.

The agent runs on Node, which the app provisions itself. It first looks for an existing install (nvm, fnm, Volta, Homebrew, `Program Files\nodejs`) and uses it when it is **v22.14 or newer** — the floor is set by `@julusian/jpeg-turbo@3`, which is built against Node-API 10 and *segfaults* on older runtimes rather than throwing. Anything older counts as missing.

When no usable Node is found, the app downloads the pinned Node LTS into `~/.9remote/node/`, verifies its SHA256 against the release's `SHASUMS256.txt`, and reports progress on the splash screen. It then runs `npm install` into `~/.9remote/npm`.

Official builds exist for macOS (arm64/x64), Windows (x64/arm64) and Linux glibc (x64/arm64). On anything else — Linux armv7, or musl distros like Alpine — the download is skipped and the app asks the user to install Node manually.

- `npm run pc:dev` — dev mode (agent + Vite + Tauri).
- `npm run pc:build` — macOS build **+ sign + notarize** (see below).
- `npm run pc:build:win` — Windows x64 portable exe + NSIS installer, cross-compiled from macOS (see below).

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

Output: `desktop/src-tauri/target/release/bundle/` (`dmg/9Remote_<version>_aarch64.dmg` + `macos/9Remote.app`).

The script (`desktop/scripts/build-macos-signed.sh`):
1. Loads `desktop/.sign.env` (or falls back to shell env — useful for CI).
2. Validates the four `APPLE_*` vars.
3. Runs `tauri build` — Tauri signs and notarizes from the `APPLE_*` env vars, then staples.

### Notes

- `entitlements.plist` keeps `app-sandbox=false` (needed for screen capture + apple-events; incompatible with Mac App Store).
- First notarization can take 5–15 min.
- Verify: `spctl -a -vvv -t exec path/to/9Remote.app` should print `accepted`.
- Builds a **universal** binary (Intel + Apple Silicon) — `pc:build` passes `--target universal-apple-darwin`.
- The agent core (`9remote` npm package) auto-updates on its own. The desktop shell does **not** auto-update yet — to ship a new shell you rebuild + redistribute.

## Windows

`npm run pc:build:win` cross-compiles from macOS via `cargo-xwin`, producing both artifacts under `desktop/src-tauri/target/x86_64-pc-windows-msvc/release/`:

- `9Remote.exe` — portable, run straight from the file.
- `bundle/nsis/9Remote_<version>_x64-setup.exe` — installer; per-user, no admin needed, and it installs WebView2 when missing.

One-time setup: `rustup target add x86_64-pc-windows-msvc`, `cargo install cargo-xwin --locked`, `brew install llvm makensis` (`llvm-lib` is needed to build `ring`, `makensis` to produce the installer).

- **Unsigned.** SmartScreen shows "Windows protected your PC" on downloaded copies; users click *More info → Run anyway*. A signing cert (EV recommended) removes it. Tauri only signs on a Windows host unless you set `bundle > windows > signCommand`.
- The portable exe needs WebView2 already on the host — preinstalled on Win11 and most Win10 boxes, but a bare Win10/7 machine has none. `webviewInstallMode` applies to the installer only, so prefer the installer for wide distribution.
- **x64 only.** Windows ARM64 fails to cross-compile: `ring` (via `ureq`) won't build its C sources for `aarch64-pc-windows-msvc` from macOS. It needs a Windows host.

## Versioning

`node scripts/syncVersion.js` (run by `agent:build`) propagates the root `package.json` version to `agent/package.json`, `desktop/package.json`, `tauri.conf.json`, and `Cargo.toml`.
