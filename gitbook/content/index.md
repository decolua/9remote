# Welcome to 9Remote

**Access your terminal, desktop, and files from anywhere in the world.**

## What is 9Remote?

9Remote is a modern remote access platform and mobile dev workspace that lets you control your computer from any device with a browser or mobile app. No complex setup, no public IP, no port forwarding, and no VPN configuration needed.

### Key Features

- **[icon:terminal] Persistent Terminal** - Full terminal access backed by a daemon so sessions survive disconnects
- **[icon:bot] AI Coding Agents** - Integrated support for Claude Code, OpenCode, Codex, and Jarvis assistant
- **[icon:globe] Site Browser** - Preview local dev servers (`localhost:3000`) directly on your phone via Service Worker bridge
- **[icon:mouse] Remote Desktop** - Control your screen in real time over WebRTC with hardware acceleration
- **[icon:folder] File Explorer & Git** - Browse, transfer files, edit code with syntax highlighting, and manage Git worktrees
- **[icon:lock] Secure by Default** - Device approval flow, 30-minute One-Time Keys (OTK), and Cloudflare tunnel encryption
- **[icon:zap] Zero Configuration** - Single command or background service setup
- **[icon:smartphone] Works Everywhere** - Mobile app (iOS/Android), desktop app (macOS/Windows), and any modern web browser

### Why Choose 9Remote?

**Simple Setup**
```bash
npm install -g 9remote
9remote
```

Scan the QR code or enter your access key, approve your device, and you're connected.

**No Network Hassle**
- No public IP needed
- No port forwarding or router access required
- Works behind NAT, firewalls, and cellular networks
- Secure Cloudflare tunnel handles transport

**Built for Developers**
- Terminal sessions run on a persistent daemon (`ptyDaemon`)
- First-class support for AI agents (live transcripts, model switching, tool calls)
- Git worktree management directly from the terminal and file explorer
- Full upload and download file transfer capabilities

## Quick Start

Ready to get started? Check out our [Getting Started Guide](getting-started) to install and connect in under 2 minutes.

## Use Cases

- **Mobile Coding & AI Agents** - Run and monitor Claude Code or coding tasks while away from your desk
- **Remote Work** - Access your desktop, terminal, and local dev servers from anywhere
- **Server Management** - Manage headless Linux servers or cloud VMs easily via CLI commands
- **On-the-go Testing** - Test responsive web apps running on localhost right on your phone's browser

## Need Help?

- [Troubleshooting](troubleshooting) - Common issues and solutions
- [FAQ](faq) - Frequently asked questions
