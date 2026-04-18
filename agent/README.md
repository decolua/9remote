<div align="center">
  <img src="https://raw.githubusercontent.com/decolua/9remote/main/images/9remote.png" alt="9Remote" width="800"/>

  # 9Remote — Terminal in Your Pocket

  **Your Mac/Linux/Windows terminal, remote desktop, and file explorer — accessible from any phone or browser, anywhere, instantly.**

  [![npm version](https://img.shields.io/npm/v/9remote.svg)](https://www.npmjs.com/package/9remote)
  [![Downloads](https://img.shields.io/npm/dm/9remote.svg)](https://www.npmjs.com/package/9remote)
  [![License](https://img.shields.io/badge/license-MIT-blue.svg)](#-license)

  [🚀 Quick Start](#-quick-start) • [💡 Features](#-features) • [🌐 Website](https://9remote.cc) • [📖 Docs](https://docs.9remote.cc)
</div>

---

## 🤔 Why 9Remote?

**Remote access today is painful:**

- ❌ **SSH** — firewall rules, port forwarding, SSH keys
- ❌ **VPN** — overkill just to check a terminal
- ❌ **ngrok / tunnels** — expire, lose connection
- ❌ **TeamViewer** — slow, desktop-only, paid
- ❌ **Termius** — SSH-only, no desktop, no browser

**9Remote solves all of it:**

- ✅ **One command** — install, scan QR, done in 30 seconds
- ✅ **Auto tunnel** — Cloudflare tunnel, no port forwarding
- ✅ **All-in-one** — terminal + desktop + file explorer + editor
- ✅ **Works on phone** — full workspace from browser, <50ms latency
- ✅ **Persistent** — PTY sessions survive restarts
- ✅ **Pair Device** — only approved devices connect, zero signup

---

## ⚡ Quick Start

```bash
npm install -g 9remote
9remote
```

🎉 **Scan the QR → pair your device → you're in.**

> Works on **macOS, Linux, Windows**. Requires Node.js 20+.

### CLI Commands

| Command | Description |
|---------|-------------|
| `9remote` | TUI mode — interactive menu with QR code |
| `9remote ui` | Web UI mode — opens dashboard at `localhost:2208` |

---

## ✨ Features

| Feature | What It Does |
|---------|--------------|
| 🖥️ **Remote Terminal** | Full PTY shell via WebSocket |
| 🖱️ **Remote Desktop** | Live screen streaming via WebRTC |
| 📁 **File Explorer** | Browse, upload, download files |
| 💻 **Code Editor** | Built-in editor with syntax highlighting |
| 🔗 **Git Integration** | Run git commands with visual status |
| 📱 **Mobile Optimized** | Touch-friendly UI, gesture controls |
| 🔑 **QR Login** | One-time 30-min key, scan to connect |
| 🔒 **Auto Tunnel** | Cloudflare tunnel, no port forwarding |
| 🔄 **Persistent Sessions** | PTY daemon survives restarts |
| 🌍 **Multi-Device Sync** | Same session across phone/tablet/laptop |
| 🔔 **Push Notifications** | Build finished? Get notified |
| 🤖 **AI Integration** | Claude Code, Codex, Cursor, OpenClaw |
| 🌐 **Local Sites Proxy** | Expose `localhost:3000` to phone |
| 🔐 **Pair Device** | Approve each device before it connects |
| 🆓 **No Account** | Machine ID + QR key, zero signup |

---

## 🎯 Use Cases

**Code from bed** — 11 PM, bug in prod, laptop in another room? Open the app on your phone, scan QR, fix, push, sleep.

**Fix bugs at a cafe** — Production down, only phone + café Wi-Fi? Connect to your home Mac, tail logs, edit config, deploy.

**Deploy on vacation** — Client needs a hotfix, you're on the beach? Phone → 9remote → git pull → deploy → back to the beach.

**On-call engineer** — 3 AM alert, don't want to boot laptop? Push notification → terminal + remote desktop from bed.

---

## 📖 Setup

<details>
<summary><b>🔑 First Run & QR Login</b></summary>

On first run, 9Remote generates two keys:

- **Permanent Key** — stored locally, tied to your machine ID
- **One-Time Key** — 30-minute temporary key for the QR code

**Connect from phone:**
1. Run `9remote` on your machine
2. A QR code appears in the terminal
3. Open [9remote.cc](https://9remote.cc) on your phone (or the mobile app)
4. Scan the QR → connected instantly

> Keys are **never** stored on our servers after the session ends.

</details>

<details>
<summary><b>🖱️ Remote Desktop (macOS)</b></summary>

Requires two system permissions:

1. **Screen Recording** — `System Settings → Privacy & Security → Screen Recording`
2. **Accessibility** — `System Settings → Privacy & Security → Accessibility`

Enable Terminal (or the app you ran `9remote` from), then toggle Remote Desktop in the TUI menu.

**Performance:**
- Adaptive framerate: 60ms active / 400ms idle
- Tile-based diff rendering (only changed regions sent)
- WebRTC DataChannel for minimal latency

</details>

<details>
<summary><b>🌐 Local Sites Proxy</b></summary>

Expose your local dev servers automatically:

```
http://localhost:3000  →  https://<tunnel>/proxy/3000/
http://localhost:5173  →  https://<tunnel>/proxy/5173/
```

Perfect for testing responsive design on real devices, sharing WIP builds, or mobile debugging without USB.

</details>

---

## ❓ FAQ

<details>
<summary><b>🔒 Is it secure?</b></summary>

**Yes.** Every new device must be explicitly approved via **Pair Device** before it can access the host. Plus:
- No open ports — Cloudflare tunnel is outbound-only
- Keys never stored on our servers after session ends
- No terminal output, files, or screen data collected
- One-time QR keys expire in 30 minutes

</details>

<details>
<summary><b>💰 Is it free?</b></summary>

**Yes.** Free to use, no signup, no credit card. MIT licensed.

</details>

<details>
<summary><b>🌐 Do I need to open ports?</b></summary>

**No.** Uses Cloudflare Quick Tunnel — outbound only. Works behind home NAT, corporate firewalls, mobile hotspots, VPNs.

</details>

<details>
<summary><b>📴 Does it work on LAN only?</b></summary>

**Yes.** A **LocalFirstAdapter** races LAN vs tunnel and uses whichever is faster. If phone and host share the same Wi-Fi, traffic stays local.

</details>

<details>
<summary><b>🤖 Can I use AI coding tools through 9Remote?</b></summary>

**Yes.** Works seamlessly with Claude Code, OpenAI Codex CLI, Cursor, OpenClaw, and any CLI tool. Run them on your host, access from your phone.

</details>

<details>
<summary><b>🖥️ What platforms are supported?</b></summary>

**Host:** macOS (Intel + Apple Silicon), Linux (x64, arm64), Windows (x64)
**Client:** Any modern browser, iOS 14+, Android 8+

</details>

---

## 🐛 Troubleshooting

**"Port 2208 already in use"**
- Another instance running → `pkill -f 9remote` and retry
- Or use a different port: `PORT=3308 9remote`

**"Cloudflare tunnel failed to start"**
- Check internet connection
- `cloudflared` auto-installed on first run; otherwise install manually from [cloudflared docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)

**"Screen Recording / Accessibility denied" (macOS)**
- Grant permissions in `System Settings → Privacy & Security`, then restart 9Remote

**"QR code expired"**
- Keys expire in 30 minutes → regenerate from TUI menu: `Key → Regenerate`

**"Can't connect from phone"**
- Check both devices have internet
- Try forcing tunnel mode: Settings → Connection → Tunnel only

---

## 📧 Links

- **Website:** [9remote.cc](https://9remote.cc)
- **Docs:** [docs.9remote.cc](https://docs.9remote.cc)
- **GitHub:** [github.com/decolua/9remote](https://github.com/decolua/9remote)
- **Issues:** [github.com/decolua/9remote/issues](https://github.com/decolua/9remote/issues)
- **Community:** [facebook.com/groups/9teamvn](https://www.facebook.com/groups/9teamvn)

---

## 📄 License

MIT © 9Team

---

<div align="center">
  <sub>Built with ❤️ for developers who code from anywhere — bed, beach, or bus.</sub>
</div>
