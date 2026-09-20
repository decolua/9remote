# Desktop App

Run 9Remote as a native, zero-friction desktop application on macOS and Windows.

## What It Does

While the 9Remote CLI runs in your terminal, the **9Remote Desktop App** wraps the host agent and web interface in a lightweight native wrapper built with **Tauri**. It lives quietly in your system tray, boots on startup, and eliminates the need to keep a terminal window open.

---

## Key Features

### System Tray & Menu Bar Integration
- **Zero Terminal Clutter:** Runs entirely in the background from your macOS Menu Bar or Windows System Tray.
- **One-Click Controls:**
  - View server connection status and tunnel health.
  - Click to display your permanent access QR code and key.
  - Toggle device auto-approval.
  - Open the local dashboard or web workspace instantly.
  - Gracefully restart or shut down the agent.

### Auto-Start on Boot
- Configurable to launch automatically when you turn on your computer:
  - **macOS:** Native `LaunchAgent` daemon.
  - **Windows:** Windows Startup registry service.
- Ensures your computer is always accessible remotely even after an unexpected reboot.

### High-Performance Native Screen Capture
- Direct integration with native OS capture APIs:
  - **macOS:** Native CoreGraphics / ScreenCaptureKit pipeline.
  - **Windows:** Desktop Duplication API (DXGI) with hardware-accelerated JPEG encoding via `@julusian/jpeg-turbo`.
- Minimal CPU overhead and optimized battery consumption when streaming.

---

## Installation & Setup

### macOS
1. Download the latest `.dmg` or `.app` from releases.
2. Drag **9Remote** to your `Applications` folder.
3. On first launch, grant the required macOS permissions:
   - **Screen Recording:** Required for Remote Desktop streaming.
   - **Accessibility:** Required for remote mouse and keyboard control.
4. The 9Remote icon will appear in your top menu bar.

### Windows
1. Download the `.msi` or `.exe` installer.
2. Run the installer and follow the prompt instructions.
3. If prompted by Windows Defender SmartScreen, click **More info** → **Run anyway**.
4. Allow 9Remote through the Windows Firewall for local peer-to-peer WebRTC connections.
5. The 9Remote tray icon will appear in the bottom-right taskbar.

---

## CLI vs Desktop App Comparison

| Feature | CLI (`9remote` / `9remote start`) | Native Desktop App |
|---|---|---|
| **Platform** | macOS, Linux, Windows | macOS, Windows |
| **System Tray** | No | Yes |
| **Terminal Window** | Required (or via systemd/screen) | None needed |
| **Auto-Start** | Manual setup (systemd/cron) | One-click toggle in Settings |
| **Remote Terminal** | Full PTY daemon | Full PTY daemon |
| **AI Agents** | Full support | Full support |

---

## Next Steps

- Control your computer with the [Mobile App](mobile)
- Deep-dive into [Architecture & Transport](../architecture/overview)
