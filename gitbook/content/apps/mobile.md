# Mobile App

Control your computer, manage AI agents, and run commands on the go with the native 9Remote mobile app for iOS and Android.

## What It Does

The **9Remote Mobile App** (built with Expo/React Native) provides an experience optimized for touchscreen devices. While you can access 9Remote from any mobile web browser, the native app unlocks background push notifications, biometric security, camera QR scanning, and low-latency touch gestures.

---

## Key Features

### 1. Instant Camera QR Pairing
- Tap the **Scan QR** button to scan the QR code displayed by your host computer.
- Automatically pairs your device and saves the access token in your phone's secure keychain.

### 2. Native Push Notifications
- Never stare at a long build or wait around for Claude Code to finish:
  - Receive instant notifications when long-running terminal commands finish.
  - Get alerted immediately when an AI agent requests confirmation for tool executions or bash commands.
  - Notifications arrive even when the app is in the background or your phone screen is locked.

### 3. Multi-Host Device Management
- Manage all your computers from a single screen:
  - Office workstation
  - Home desktop
  - Cloud VMs and development servers
- View live online/offline status badges and switch between computers with one tap.

### 4. Precision Mobile Controls
- **Virtual Trackpad Mode:** Turn your phone screen into a responsive glass trackpad with left/right click buttons, edge scrolling, and haptic feedback.
- **Developer Keyboard Toolbar:** Floating accessory bar with Esc, Tab, Ctrl, Alt, Shift, arrow keys, and customizable macros.
- **Gesture Shortcuts:** Two-finger tap for right-click, pinch-to-zoom for small code fonts, and swipe gestures to switch terminal tabs.

### 5. Biometric Protection
- Lock your connection keys behind **Face ID**, **Touch ID**, or Android Biometric Authentication.
- Ensures that even if someone unlocks your phone, your remote computers remain completely protected.

---

## Remote Control Dashboard

Beyond coding and terminal access, the mobile app includes a dedicated **Remote Control** mode:
- **Media Controls:** Play/pause, next track, volume up/down, and mute.
- **Power Management:** Lock workstation, sleep, reboot, or display sleep.
- **Presentation Mode:** Advance slides and navigate fullscreen presentations during meetings.

---

## Getting the App

- **iOS:** Available on the Apple App Store or via TestFlight beta.
- **Android:** Download from Google Play Store or get standalone `.apk` releases from GitHub.

---

## Next Steps

- Learn about [Architecture & Transport](../architecture/overview)
- Configure [Background Services & Daemon](../guides/services)
