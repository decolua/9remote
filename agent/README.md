<div align="center">
  <img src="https://raw.githubusercontent.com/decolua/9remote_public/main/images/screen.png" alt="9Remote Workspace" width="900"/>

  # 9Remote — Code From Anywhere on Earth

  **Your entire dev machine, in your pocket.**<br/>
  **Remote IDE, Remote Desktop, File Explorer, Mobile Emulator, and Localhost Preview — buttery-smooth on mobile with WebRTC ultra-low latency.**

  [![npm version](https://img.shields.io/npm/v/9remote.svg)](https://www.npmjs.com/package/9remote)
  [![Downloads](https://img.shields.io/npm/dm/9remote.svg)](https://www.npmjs.com/package/9remote)
  [![License](https://img.shields.io/badge/license-MIT-blue.svg)](#-license)

  [🚀 Quick Start](#-quick-start) • [✨ Superpowers](#-5-remote-superpowers--mobile-first) • [📊 Comparison](#-how-9remote-compares) • [🌐 Website](https://9remote.cc) • [📖 Docs](https://docs.9remote.cc)
</div>

---

## ⚡ Quick Start

Start your remote workspace in **30 seconds**:

```bash
npm install -g 9remote
9remote
```

🎉 **Scan the QR code with your phone camera (or open the link in any browser) → click "Approve" on your host → you're in!**

> **Works on macOS, Linux, and Windows.** Requires Node.js 18+.  
> Zero configuration. No port forwarding. No account or signup required.

### CLI Modes

| Command | Mode | Description |
|---------|------|-------------|
| `9remote` | **TUI Mode** | Interactive terminal menu with QR code |
| `9remote ui` | **Web UI Mode** | Opens the host dashboard at `localhost:2208` |

---

## ✨ 5 Remote Superpowers + Mobile-First

### 💻 1. Remote IDE & AI Agent Workspace
- Multi-pane terminal rows with smooth drag-to-resize splitters.
- Integrated code editor with syntax highlighting and file tree.
- Visual Git status, diff viewer, and multi-worktree switcher.
- Auto-opening artifact inspector for **Claude Code**, Codex, and CLI AI agents (HTML, Markdown, Mermaid).

### 📱 2. Code on Mobile, Web & Any Screen (Mobile Full Feature)
- Dedicated developer keyboard row (`Esc`, `Tab`, `Ctrl`, `Alt`, navigation arrows).
- Customizable AI shortcuts and fluid swipe navigation between sessions.
- Tactile haptic feedback on touch for responsive coding.
- Fully adaptive UI: Multi-column IDE on desktop/tablet, touch-first card view on mobile.

### 🖥️ 3. Instant Remote Desktop (WebRTC 60fps)
- Hardware-accelerated screen streaming with ultra-low latency (<20ms).
- Mouse, touch, keyboard controls, and multi-monitor switching.
- Vastly lighter on battery and bandwidth than VNC, AnyDesk, or TeamViewer.

### 📁 4. Remote File Explorer
- Visual directory tree with instant fuzzy file search.
- Touch drag-and-drop file transfers (upload and download).
- Secured by path-jail boundaries keeping your host system safe.

### 📱 5. Live Remote Emulator
- Interactive remote stream for Android Emulator and iOS Simulator.
- Tap, swipe, and test mobile UI directly from your phone browser without sitting at your desk.

### 🌐 6. Instant Localhost Preview
- Built-in Service Worker bridge streams `localhost:3000` or `localhost:8080` to your mobile browser.
- Preview local web apps in real time with zero port forwarding and no ngrok tunnels.

### 🔄 7. Persistent PTY Daemon
- Background daemon keeps your shells and builds alive on the host.
- Switching networks (Wi-Fi to 4G), locking your phone, or closing tabs never kills your running tasks.

### 🛡️ 8. 3-Layer Zero-Trust Security
1. **Split-Key Pairing:** The key is split into HEAD and TAIL; routing relay only sees HEAD and never knows your secret TAIL.
2. **Direct WebRTC P2P:** Data flows directly device-to-device with X25519 + AES-256-GCM encryption.
3. **Physical Host Approval:** New devices cannot connect until you physically click "Approve" on your computer screen.

---

## 📊 How 9Remote Compares

| Feature | **9Remote** | Claude Remote | TeamViewer | Chrome Remote | Termius |
|---------|:-----------:|:-------------:|:----------:|:-------------:|:-------:|
| **Zero Config** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Remote IDE** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Terminal Access** | ✅ | ✅ | ❌ | ❌ | ✅ |
| **Persistent Daemon** | ✅ | ✅ | ❌ | ❌ | ✅ |
| **Remote Localhost Preview** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Touch File Explorer & Editor** | ✅ | ❌ | ✅ | ❌ | ✅ |
| **Remote Desktop** | ✅ | ❌ | ✅ | ✅ | ❌ |
| **Remote Emulator** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **AI Agent Artifacts** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Physical Host Approval** | ✅ | ❌ | ✅ | ❌ | ❌ |
| **Git Integration** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Mobile Optimized** | ✅ | ✅ | ❌ | ❌ | ✅ |
| **Browser-Based** | ✅ | ✅ | ❌ | ✅ | ❌ |
| **QR Login** | ✅ | ✅ | ❌ | ❌ | ❌ |
| **Auto Tunnel** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **No Port Forwarding** | ✅ | ✅ | ✅ | ✅ | ❌ |
| **No Account Required** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Free & Open Source** | ✅ | ❌ | ❌ | ✅ | ❌ |
| **TOTAL** | **18 / 18** | 10 / 18 | 6 / 18 | 5 / 18 | 5 / 18 |

> **🏆 9Remote: Complete 18/18 capabilities · 100% self-hosted & private.**

---

## 🎯 Use Cases

- **Code from bed** — Fix a bug at 11 PM without getting out of bed. Open your phone, connect to your Mac, fix, commit, push, sleep.
- **Fix bugs at a cafe** — Server alert while having coffee? Connect from your phone or tablet, tail logs, edit configs, and restart services.
- **Deploy on vacation** — Urgent client hotfix while you're away? Phone → 9Remote → `git pull` → build → deploy.
- **Monitor AI Coding Agents** — Run long Claude Code / Cursor tasks on your desktop, and review artifacts, diffs, and progress from your phone.

---

## ❓ FAQ

<details>
<summary><b>🔒 Is 9Remote secure?</b></summary>

**Yes.** 9Remote uses 3 layers of zero-trust defense:
- Outbound-only Cloudflare tunnel (no open ports or firewall changes needed).
- Direct WebRTC peer-to-peer data channels with end-to-end encryption.
- Physical host approval required before any device can access your machine.
- Your code and credentials never touch third-party cloud servers.
</details>

<details>
<summary><b>💰 Is it free?</b></summary>

**Yes.** 9Remote is free, open source (MIT license), with no subscriptions and no signup required.
</details>

<details>
<summary><b>🌐 Do I need to open router ports or setup DDNS?</b></summary>

**No.** 9Remote automatically sets up an outbound secure tunnel and negotiates WebRTC P2P connections through NATs and firewalls.
</details>

<details>
<summary><b>🤖 Which AI agents are supported?</b></summary>

Works with any CLI AI tool: **Claude Code**, Cursor CLI, Aider, Codex, OpenClaw, and more. 9Remote provides dedicated multi-pane terminals and live artifact rendering for HTML and diagrams.
</details>

---

## 📄 License

MIT License. Free for personal and commercial use.
