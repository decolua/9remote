# Background Services & Daemon

Keep 9Remote running 24/7 as an unattended background service on Linux, macOS, and cloud servers.

## Overview

When using 9Remote for remote development or server management, you typically want the host running permanently in the background, starting automatically on boot and recovering from crashes without keeping a terminal open.

---

## 1. Linux: systemd (Recommended for Servers & VPS)

For Ubuntu, Debian, CentOS, Fedora, Arch, and most modern Linux distributions, `systemd` is the cleanest and most robust approach.

### Step 1: Create the systemd Service File
Create a new service file at `/etc/systemd/system/9remote.service`:

```ini
[Unit]
Description=9Remote Host Service
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
Environment=PATH=/usr/local/bin:/usr/bin:/bin:/home/YOUR_USERNAME/.nvm/versions/node/$(node -v)/bin
WorkingDirectory=/home/YOUR_USERNAME
ExecStart=/usr/bin/env 9remote start
Restart=always
RestartSec=5

# Optional: ensure file descriptors and processes for PTY
LimitNOFILE=65536
LimitNPROC=4096

[Install]
WantedBy=multi-user.target
```

> **Tip:** Replace `YOUR_USERNAME` with your actual Linux username. Run `which 9remote` to ensure the path matches your Node.js global binaries.

### Step 2: Enable & Start the Service
```bash
sudo systemctl daemon-reload
sudo systemctl enable 9remote
sudo systemctl start 9remote
```

### Step 3: Check Status & Retrieve Your Key
```bash
sudo systemctl status 9remote

# View logs to get your QR code or access key:
journalctl -u 9remote -f -n 50

# Or query directly using the headless CLI:
9remote key
```

---

## 2. macOS: launchd (LaunchAgent)

On macOS, running 9Remote as a user `LaunchAgent` allows it to start automatically when you log into your Mac and maintain access to screen recording and terminal permissions.

### Step 1: Create the Plist File
Create `~/Library/LaunchAgents/cc.9remote.agent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>cc.9remote.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/sh</string>
        <string>-c</string>
        <string>source ~/.zshrc; 9remote start</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/9remote.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/9remote.err</string>
</dict>
</plist>
```

### Step 2: Load the Service
```bash
launchctl load ~/Library/LaunchAgents/cc.9remote.agent.plist
```

To stop or unload:
```bash
launchctl unload ~/Library/LaunchAgents/cc.9remote.agent.plist
```

---

## 3. Cross-Platform: PM2 Process Manager

If you already use `pm2` for Node.js microservices:

```bash
# Start 9Remote in headless start mode
pm2 start "9remote start" --name "9remote"

# Save configuration for automatic system boot
pm2 save
pm2 startup
```

Monitor logs with:
```bash
pm2 logs 9remote
```

---

## 4. Headless Server Maintenance

Once 9Remote is running as a service, manage it from your terminal using headless commands:

```bash
# View current access key and URL
9remote key

# View approved and pending devices
9remote devices

# Automatically approve all incoming devices using your key
9remote auto-approve on

# Create a temporary one-time connection key
9remote otk
```

---

## Next Steps

- Set up an [Advanced AI Workflow](ai-workflow)
- Learn how to [Self-Host 9Remote Backend](self-hosting)
