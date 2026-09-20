# Frequently Asked Questions

Quick answers to common questions about 9Remote.

## General

### Is 9Remote free?
Yes — the core of 9Remote is free and open source. An optional Pro subscription, available in the mobile app, unlocks extra features and helps fund ongoing development.

### Do I need a public IP address or port forwarding?
No. Cloudflare tunnel handles all the networking automatically. You don't need port forwarding, static IPs, router configuration, or a VPN.

### What operating systems are supported?
**Host / Server (where 9Remote runs):**
- macOS (Intel & Apple Silicon)
- Linux (Ubuntu, Debian, Fedora, Arch, Alpine, etc.)
- Windows 10 & 11

**Client (where you connect from):**
- Any modern web browser (Safari, Chrome, Firefox, Edge)
- Mobile devices (iOS & Android)
- Native desktop wrapper (macOS & Windows)

---

## Architecture & Features

### What makes 9Remote different from standard SSH or VNC?
1. **Persistent Daemon (`ptyDaemon`):** Shell sessions stay alive even if the agent restarts or your device disconnects.
2. **AI Coding Agent Integration:** First-class chat UI, transcript visualization, and turn rewinds for tools like Claude Code, OpenCode, and Codex.
3. **Site Browser:** Preview your local web servers (`localhost:3000`) directly on your phone via a Service Worker proxy without opening ports.
4. **Resilient File Transfers:** Chunked streaming file upload and download with resume capabilities.
5. **Ultra-Low Latency:** WebRTC data channel streaming with intelligent dirty-tile diffing for Remote Desktop.

### Can I run 9Remote on a headless server without a display?
Yes. Use the headless command:
```bash
9remote start
```
Terminal, File Explorer, Site Browser, and AI agents work 100% on headless servers. Only Remote Desktop requires an active graphical display session on the host.

### What is the Device Approval security layer?
Even with your access key, any new device attempting to connect enters a **Pending Approval** state until approved from the host machine:
```bash
9remote devices
9remote approve <socketId>
```
If you prefer automatic approval for any device presenting the valid key:
```bash
9remote auto-approve on
```

### How do One-Time Keys (OTK) work?
Run `9remote otk` to generate a secure, temporary connect URL and key that automatically expires after **30 minutes** (or after its first use). This is ideal for quick sessions on public computers or sharing access safely.

---

## Performance & Connectivity

### What protocols does 9Remote use?
9Remote uses a hybrid transport layer:
- **WebRTC Data Channels:** Direct peer-to-peer connection for ultra-low latency screen and terminal streaming.
- **WebSocket over Cloudflare Tunnel:** Encrypted tunnel fallback ensuring reliable connectivity across restrictive corporate firewalls and mobile networks.

### Can I access `localhost:3000` running on my computer from my phone?
Yes! Use the **Site Browser** tab inside the 9Remote web app. The built-in Service Worker bridge securely tunnels HTTP and asset traffic over your existing connection, allowing you to test mobile responsive web apps without opening public ports.

---

## Help & Troubleshooting

### How do I stop the server?
Press `Ctrl+C` in the terminal where `9remote` or `9remote start` is running.

### Where can I find more help?
- Check our [Troubleshooting Guide](troubleshooting)
- Review the [Getting Started Guide](getting-started)
