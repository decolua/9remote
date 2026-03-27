<div align="center">

# 9remote

**Your Mac/Linux terminal in your pocket — anywhere, instantly**

[![npm version](https://img.shields.io/npm/v/9remote)](https://www.npmjs.com/package/9remote)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dm/9remote)](https://www.npmjs.com/package/9remote)

[🌐 Web App](https://9remote.cc) • [📖 Docs](https://docs.9remote.cc) • [🚀 Get Started](#-quick-start)

</div>

---

## Why 9remote?

- ❌ **SSH is a hassle** — need to open firewall, configure port forwarding, manage keys
- ❌ **VPN is overkill** — too complex to set up just to check a terminal
- ❌ **ngrok / tunnels expire** — lose connection, have to restart everything

**9remote solves it:**
- ✅ **One command** — `npx 9remote`, scan QR, done
- ✅ **Auto tunnel** — Cloudflare tunnel starts automatically, no port forwarding
- ✅ **Works on phone** — full terminal from your browser, under 50ms latency
- ✅ **Remote Desktop** — view and control your screen, mouse & keyboard
- ✅ **Persistent sessions** — PTY daemon survives server restarts

---

## ⚡ Quick Start

```bash
npx 9remote
```

Scan the QR code on your phone → you're in.

Or install globally:

```bash
npm install -g 9remote
9remote
```

> **Ready in 30 seconds. No config needed.**

---

## ✨ Features

- 🖥️ **Remote Terminal** — Full PTY shell, always on, persistent across reconnects
- 🖱️ **Remote Desktop** — Live screen streaming via WebRTC + mouse/keyboard control
- 📁 **File Explorer** — Browse, upload, download files from your browser
- 📱 **QR Login** — One-time key (30 min) for quick mobile access
- 🔒 **E2E Secure** — All traffic through Cloudflare tunnel, no open ports
- 🔄 **Auto Restart** — Server + tunnel auto-recover on crash

---

## 📖 CLI Commands

| Command | Description |
|---|---|
| `9remote` | TUI mode — interactive menu with QR |
| `9remote ui` | Web UI mode — open browser dashboard |
| `9remote start` | Auto start server + tunnel (headless) |

---

<details>
<summary><b>🔧 How it works</b></summary>

1. **Start** — `9remote` spawns a local server on port `2208`
2. **Tunnel** — A Cloudflare Quick Tunnel is created automatically (no account needed)
3. **QR** — A one-time login link is generated and shown as QR code
4. **Connect** — Scan from your phone → authenticated session via [9remote.cc](https://9remote.cc)
5. **Transport** — Terminal uses WebSocket; Remote Desktop uses WebRTC DataChannel for low latency

</details>

<details>
<summary><b>📡 Remote Desktop</b></summary>

- Screen streaming via WebRTC (adaptive: 60ms active / 400ms idle)
- Tile-based diff rendering — only changed regions are sent
- Mouse & keyboard control via `robotjs`
- Requires macOS permissions: **Screen Recording** + **Accessibility**

Enable from TUI menu: `Remote Desktop → Toggle ON`

</details>

<details>
<summary><b>🔑 Keys & Security</b></summary>

- **Permanent Key** — stored locally, tied to your machine ID
- **One-Time Key** — 30-minute temporary key for quick phone access
- Keys are never stored on our servers after session ends
- Regenerate your key anytime from the TUI menu

</details>

---

## 🛠️ Built With

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — Zero-config secure tunnel
- [node-datachannel](https://github.com/murat-dogan/node-datachannel) — WebRTC for low-latency desktop streaming
- [node-pty](https://github.com/microsoft/node-pty) — Persistent PTY terminal sessions
- [Socket.IO](https://socket.io/) — Real-time terminal + signaling
- [Preact](https://preactjs.com/) — Lightweight Web UI

---

## 📝 License

MIT © [9remote](https://github.com/decolua/9remote)
