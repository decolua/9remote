# Troubleshooting

Common issues and solutions when setting up and using 9Remote.

## 1. Installation Issues

**Problem:** `npm install -g 9remote` fails with permission or engine errors.

**Solutions:**
- **Node.js version:** Check your version with `node -v`. 9Remote requires **Node.js 18 or higher**.
- **Permission errors (macOS/Linux):**
  ```bash
  sudo npm install -g 9remote
  ```
  Or better, configure an npm prefix without sudo or use `nvm`:
  ```bash
  nvm install 20
  nvm use 20
  npm install -g 9remote
  ```

---

## 2. Server Startup & Headless Environments

**Problem:** Server crashes or cannot open interactive menu.

**Solutions:**
- **Running over SSH / No TTY:**
  If you are connected to a remote server over SSH without an interactive TTY, running `9remote` will show help text instead of the interactive menu. Use headless mode instead:
  ```bash
  9remote start
  ```
- **Port 2208 already in use:**
  Another 9Remote instance or process is using port 2208.
  ```bash
  # macOS/Linux: Kill process on port 2208
  lsof -ti:2208 | xargs kill -9
  
  # Windows (Command Prompt):
  netstat -ano | findstr :2208
  taskkill /PID <PID> /F
  
  # Then start again:
  9remote start
  ```

---

## 3. Connection & "Waiting for Approval"

**Problem:** You entered the key or scanned the QR code, but the browser is stuck waiting or says invalid key.

**Solutions:**
- **Device Pending Approval (Security Feature):**
  When connecting a new phone or browser, 9Remote requires host approval for security.
  - If you have access to the host screen: click **Approve** on the host notification.
  - If running headless/SSH on the host, run:
    ```bash
    9remote devices
    9remote approve <socketId>
    ```
  - To automatically accept all devices using your key in the future:
    ```bash
    9remote auto-approve on
    ```
- **One-Time Key (OTK) Expired:**
  OTK keys are valid for 30 minutes. If expired, generate a fresh one:
  ```bash
  9remote otk
  ```
- **Key Mismatch:** Check or regenerate your permanent key:
  ```bash
  9remote key
  9remote key --new  # Regenerate if needed
  ```

---

## 4. Terminal & Process Persistence

**Problem:** Terminal disconnects or browser refreshes.

**Behavior & Solution:**
- 9Remote uses a persistent background PTY daemon (`ptyDaemon`). When your browser or mobile connection drops, your running processes (Docker builds, servers, Vim, tests) **do not die**.
- Simply refresh or reopen `https://9remote.cc` and tap into your terminal session; it will reattach immediately to the running shell.

---

## 5. Network Latency & WebRTC Fallback

**Problem:** Remote Desktop or Terminal feels slow or laggy.

**Solutions:**
- **Transport Modes:** 9Remote automatically negotiates WebRTC for direct, low-latency streaming. If strict firewalls block WebRTC UDP ports, it automatically falls back to secure WebSocket over Cloudflare tunnel.
- **Remote Desktop Quality:** In the Remote Desktop settings bar, switch quality to **Performance** or **Balanced** to reduce bandwidth consumption on cellular connections.

---

## 6. Logs & Diagnostics

- **View Agent Logs:**
  - File: Look for `agent.log` in your 9Remote installation or working directory.
  - Web UI: If web mode is active, visit `http://localhost:2208/logs`.
- **Check Server Status:**
  ```bash
  9remote devices    # Verifies server is active and responding to API calls
  ```

---

## Summary of Quick Commands

| Task | Command |
|---|---|
| Start server in background/headless | `9remote start` |
| View current key and connect URL | `9remote key` |
| Generate new 30-min one-time key | `9remote otk` |
| List approved & pending devices | `9remote devices` |
| Turn on automatic device approval | `9remote auto-approve on` |
| Approve a pending device connection | `9remote approve <socketId>` |
