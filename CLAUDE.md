# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

9Remote — remote terminal + desktop + file explorer accessible from any phone/browser. Two runtimes talk over a shared transport protocol:

- **`host/`** — Node.js CLI that runs on the user's machine (the "host"). Serves PTY terminals, WebRTC screen streaming, file explorer. Published to npm as `9remote`.
- **`web/`** — Next.js app (React 19) deployed to Cloudflare Workers via OpenNext. The client UI + signaling/session API backed by Cloudflare D1.
- The phone/browser (`web`) connects to the host through a Cloudflare tunnel; `web`'s API only does signaling, auth, and session brokering — the actual terminal/screen data flows host↔client over WS or WebRTC.

npm workspaces: `host`, `web`, `gitbook` (docs site), `desktop` (Tauri wrapper). `expo/` is a separate mobile app (not a workspace).

## Commands

Run from repo root unless noted.

```bash
npm run dev                # host + web together (run-p)
npm run host:dev           # host only, TUI mode (alias: agent:dev)
npm run host:dev:ui        # host only, web-UI mode at localhost:2208
npm run web:dev            # web only (Next dev)

npm run host:build         # sync version + build npm pkg (scripts/buildPkg.js, esbuild + obfuscation)
npm run host:publish       # build + npm publish
npm run web:deploy         # deploy web to Cloudflare Workers

npm run pc:dev             # Tauri dev (host UI + native shell)
npm run pc:build           # build host pkg, then sign + notarize the macOS app

npm run secrets:sync       # push web/.dev.vars secrets to Cloudflare (--env=production|dev)
```

Host-local scripts (`cd host`): `npm run dev` (nodemon TUI), `npm run dev:ui` (server + Vite UI), `npm run build:ui` (Vite build of `host/ui`).

No test runner is configured. ESLint via `eslint.config.mjs` (next config). Lint: `npx eslint .`.

## Architecture

### Transport (the core abstraction)
`host/transport/` and `web/shared/transport/` are **mirror implementations** of the same protocol. When you change the wire format, message framing, or codec, change BOTH sides.
- `ProtocolManager.js` picks/negotiates a protocol; `WsProtocol.js` (Socket.IO) and `WebRtcProtocol.js` (node-datachannel on host, browser RTCPeerConnection on web) are the two transports.
- `codec.js` encodes/decodes messages; `registry.js` maps message types to handlers.
- Terminal + file explorer default to WS; remote desktop uses WebRTC data channels for low latency.

### Host features (`host/features/`)
Each feature owns a `*Socket.js` entry that registers handlers on the shared server:
- `terminal/` — PTY via a persistent **daemon** (`ptyDaemon.js` + `ptyDaemonClient.js` over a unix socket) so sessions survive host restarts. `handlers/` has keyboard/resize/etc. `pushManager.js` sends push notifications on events.
- `remote/` — screen capture → encode → WebRTC. `TileManager.js`/`ResourceManager.js` do dirty-tile diffing; `adapters/` are per-OS capture backends. Tunables live in `REMOTE_CONFIG.js`.
- `fileExplorer/` — browse/upload/download. `pathGuard.js` is the path-jail (security boundary — do not bypass).

### Host CLI (`host/cli/`)
`index.js` dispatches by argv into `modes/` (tui, ui, tray, auto, headless, background). `core/` is lifecycle + local API; `session/key.js` handles the QR one-time-key; `tunnel/` manages the Cloudflare tunnel lifecycle. Headless commands (`key`, `devices`, …) drive an already-running server via its local API rather than spawning a TUI.

### Web (`web/`)
- `app/` — Next App Router. `app/api/` is the signaling/session/auth/webrtc backend (runs on the Worker, backed by D1). `app/workspace/` is the main authenticated UI.
- `web/features/<domain>/` — feature-sliced (components/hooks/lib/constants). Mirrors host features: `terminal`, `remote`, `fileExplorer`, `git`, `codespace`, `webdav`, plus web-only `admin`, `auth`, `connections`, `session`, `landing`, `workspace`.
- `web/shared/` — cross-feature `stores/` (Zustand), `transport/`, `i18n/`, `theme/`, `components/ui/`.
- D1 schema evolves via `web/migrations/NNN_*.sql`. Secrets are Worker secrets (see `wrangler.toml` header comment), NOT committed — synced from `web/.dev.vars`.

## Conventions (from `.cursor/rules/`)

- **JavaScript only, no TypeScript.** ES modules (`"type": "module"`).
- **camelCase** for functions, variables, files, folders, and DB columns.
- **No hardcoded values** — centralize constants in `constants.js`/`config.js` per module (e.g. `host/lib/constants.js`, feature-level `constants.js`, `REMOTE_CONFIG.js`).
- Domain-Driven / feature-sliced structure; reuse existing code before adding new.
- Comments only for non-obvious code, in **English**, one line max.
- Strings: double quotes normally; backticks only for interpolation/multiline.
- Early return over nested `if`. No error-swallowing try/catch. Validate input at trust boundaries (API handler, socket handler) only.

### i18n (strict process)
Locale files under `web/shared/i18n/locales/` and `host/ui/src/i18n/locales/`. Full locale set: `ar de en es fa fr he hi id it ja ko ms nl pl pt ru sv th tr uk vi zh`.
Never hand-edit individual locale files. To add keys: build a JSON `{anchor, translations:{<locale>:{key:val}}}` and run `node web/shared/i18n/insertKeys.mjs <data.json>` (idempotent). Only translate all locales when explicitly requested; otherwise `en` fallback.

## Security-sensitive areas

`.docs/security/` tracks a known-issues audit. Treat these as hardening boundaries when touching them: `fileExplorer/pathGuard.js` (path jail), device approval in `transport/server.js`, CORS/auth middleware, the QR/one-time-key flow, and the auto-update path in `cli/utils/updateChecker.js`. Don't weaken an existing check; don't introduce secrets into `wrangler.toml` (secrets go through `secrets:sync`).
