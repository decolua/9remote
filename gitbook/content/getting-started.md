# Getting Started

Get up and running with 9Remote in just 2 minutes.

## Installation

Install the 9Remote CLI globally using npm:

```bash
npm install -g 9remote
```

**Requirements:**
- Node.js 18 or higher
- macOS, Linux, or Windows

**Verify installation:**
```bash
9remote --version
```

## Start Server

You can start 9Remote in interactive mode or headless mode:

### 1. Interactive Mode (Default)
Run:
```bash
9remote
```
Launches an interactive terminal menu (TUI) where you can start the server, regenerate keys, manage connected devices, and view status.

### 2. Headless Mode (Recommended for Servers & SSH)
Run:
```bash
9remote start
```
Starts the server and secure Cloudflare tunnel directly in the foreground without the interactive menu. Perfect for background services, systemd, or remote SSH sessions.

### 3. Web UI Mode
Run:
```bash
9remote ui
```
Starts the server with a local web dashboard available at `http://localhost:2208`.

---

## Connect to Your Computer

When 9Remote starts, it sets up a secure Cloudflare tunnel and generates:
1. **A QR Code** displayed in your terminal
2. **A Permanent Access Key**
3. **A Web App URL**: `https://9remote.cc/login`

### Option 1: Scan QR Code (Fastest)
1. Open your phone camera or QR scanner.
2. Scan the QR code displayed in the terminal.
3. The 9Remote web app opens with your access key prefilled.

### Option 2: Manual Key Entry
1. Visit `https://9remote.cc/login`.
2. Enter the permanent key shown in your terminal.
3. Tap **Connect**.

### Device Approval Flow
For security, 9Remote uses a two-step authentication mechanism:
- When a new device connects for the first time, it enters a **Pending Approval** state.
- **In TUI/UI mode:** You will see a notification on the host computer to approve the device.
- **In Headless mode:** View pending devices and approve them using:
  ```bash
  9remote devices
  9remote approve <socketId>
  ```
- **Auto-Approve:** To automatically allow connections using your key:
  ```bash
  9remote auto-approve on
  ```

### Temporary Access: One-Time Keys (OTK)
If you need to connect from a temporary browser or share access briefly:
```bash
9remote otk
```
Generates a one-time connection URL and key valid for **30 minutes** (or one connection).

---

## CLI Management Commands

You can control a running 9Remote instance directly from your terminal using headless commands:

```bash
9remote start                  # Run server + tunnel in foreground
9remote key                    # Display current permanent key and URL
9remote key --new              # Regenerate the permanent key
9remote otk                    # Generate a 30-minute one-time key
9remote devices                # List approved devices
9remote auto-approve <on|off>  # Toggle automatic device approval
9remote approve <socketId>     # Approve a pending device connection
9remote help                   # View all available CLI commands
```

---

## Workspace Features

Once connected, your 9Remote Workspace provides:

- **[icon:terminal] Terminal** - PTY daemon backed, multi-session tabs, Git worktree support, push alerts
- **[icon:bot] AI & Coding Agents** - Native chat and control for Claude Code, OpenCode, and Codex
- **[icon:globe] Site Browser** - Access localhost dev servers (`localhost:3000`, etc.) directly on your phone
- **[icon:mouse] Remote Desktop** - Real-time low-latency desktop control via WebRTC
- **[icon:folder] File Explorer & Git** - File editor, file upload/download, branch diffs, and worktree manager

## Stop Server

To stop the running 9Remote server:
- Press `Ctrl+C` in the terminal running `9remote` or `9remote start`.

## Next Steps

- Explore [Terminal & Sessions](features/terminal)
- Use [AI & Coding Agents](features/ai)
- Browse your local sites via [Site Browser](features/site-browser)
- Try [Remote Desktop](features/remote-desktop)
- Learn about [File Explorer & Transfer](features/file-explorer)
