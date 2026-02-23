# Frequently Asked Questions

Quick answers to common questions about 9Remote.

## General

### Is 9Remote free?

Yes! 9Remote is completely free and open source. No subscriptions, no hidden fees.

### Do I need a public IP address?

No! That's the beauty of 9Remote. Cloudflare tunnel handles all the networking automatically. No port forwarding, no firewall configuration needed.

### What operating systems are supported?

**Server (where you install CLI):**
- macOS
- Linux (Ubuntu, Debian, Fedora, etc.)
- Windows (with Node.js)

**Client (where you connect from):**
- Any device with a modern browser
- iOS, Android, Windows, macOS, Linux

### Is there a limit on sessions?

No limits! Create as many terminal sessions as you need. Run multiple features simultaneously.

## Security

### Is 9Remote secure?

Yes. All connections are encrypted through Cloudflare tunnel. Your data travels through secure HTTPS connections.

### Who can access my computer?

Only people with your access key can connect. Keep your key private, and regenerate it if you think it's been compromised.

### Can I use it on public WiFi?

Yes, it's safe. All traffic is encrypted. However, for sensitive work, we recommend using a VPN as an extra layer of security.

### What about one-time keys?

One-time keys expire after 30 minutes or one use (whichever comes first). Perfect for temporary access or sharing with others.

## Technical

### What is Cloudflare tunnel?

Cloudflare tunnel creates a secure connection between your computer and the internet without exposing your IP address or opening ports. It's like a VPN, but automatic and built-in.

### Why do I need Node.js?

The 9Remote CLI is built with Node.js. It's required to run the server on your computer.

### Can I use a custom domain?

Not currently, but it's on our roadmap. For now, all connections go through `9remote.cc`.

### Does it support IPv6?

Yes, Cloudflare tunnel supports both IPv4 and IPv6.

### How much bandwidth does it use?

- **Terminal:** Very little (< 1 MB/hour)
- **Remote Desktop:** 5-50 MB/hour depending on quality
- **File Explorer:** Minimal, only when loading files

## Usage

### How do I stop the server?

Press `Ctrl+C` in the terminal where the server is running.

### Can I run it in the background?

Yes, but you'll need to use a process manager like `pm2` or run it in a `screen`/`tmux` session:

```bash
# Using screen
screen -S 9remote
9remote start
# Press Ctrl+A then D to detach

# Reattach later
screen -r 9remote
```

### What if I forget my key?

You can't recover it, but you can regenerate a new one:

```bash
9remote
# Select: Manage Key → Regenerate Key
```

### Can multiple people connect at once?

Yes! Multiple devices can connect with the same key and use different features simultaneously.

### Does it work offline?

No, both your computer (server) and connecting device need internet access.

## Features

### Does Remote Desktop support audio?

Not yet. Audio streaming is on our roadmap for future releases.

### Can I transfer files?

Currently, you can edit files through File Explorer. File upload/download feature is coming soon.

### Does it support multiple monitors?

Currently, only the primary monitor is streamed. Multi-monitor support is planned.

### Can I use it for gaming?

Not recommended. Remote Desktop is optimized for productivity, not high-FPS gaming.

## Troubleshooting

### Why does tunnel take so long to connect?

Cloudflare tunnel needs 30-60 seconds to establish connection and propagate DNS. This is normal. Wait for "Connection established" message.

### Server keeps crashing, what do I do?

Check the error messages in terminal. Common causes:
- Port 2208 already in use
- Insufficient permissions
- Network issues

Try restarting your computer and running again.

### Mobile keyboard not working?

Make sure you're in landscape mode and tap the keyboard icon to show the on-screen keyboard.

## Pricing & Limits

### Will it always be free?

The core features will always be free. We may add premium features in the future, but basic remote access will remain free forever.

### Are there any usage limits?

No hard limits, but please be reasonable. Don't abuse the service or use it for illegal activities.

## Getting Help

### Where can I report bugs?

GitHub Issues: https://github.com/yourusername/9remote/issues

### How can I request features?

Open a feature request on GitHub Issues with the "enhancement" label.

### Is there a community?

Check our GitHub repository for discussions and community support.

---

**Didn't find your answer?**

Check our [Troubleshooting Guide](troubleshooting) or open an issue on GitHub.

[← Back: Troubleshooting](troubleshooting)
