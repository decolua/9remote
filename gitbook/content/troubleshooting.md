# Troubleshooting

Common issues and how to fix them.

## 1. Cannot Install CLI

**Problem:** `npm install -g 9remote` fails

**Solutions:**

Try with sudo (macOS/Linux):
```bash
sudo npm install -g 9remote
```

Check Node.js version:
```bash
node -v
```
Need version 18 or higher. Update if needed:
```bash
# Using nvm
nvm install 18
nvm use 18

# Or download from nodejs.org
```

Clear npm cache:
```bash
npm cache clean --force
npm install -g 9remote
```

## 2. Server Won't Start

**Problem:** Server fails to start or crashes immediately

**Solutions:**

**Port 2208 already in use:**
```bash
# macOS/Linux - Kill process on port
lsof -ti:2208 | xargs kill -9

# Windows - Kill process on port
netstat -ano | findstr :2208
taskkill /PID <PID> /F

# Then restart
9remote
```

**Wait for tunnel:**
- Tunnel takes 30-60 seconds to connect
- Don't interrupt during setup
- Look for "Connection established" message

**Restart computer:**
- Sometimes a simple restart fixes everything
- Clears stuck processes
- Resets network

## 3. Cannot Connect / Invalid Key

**Problem:** Can't connect to server or key doesn't work

**Solutions:**

**Check server is running:**
- Look for terminal window with server
- Should see "Connection established"
- QR code should be visible

**Regenerate key:**
```bash
# Stop current server (Ctrl+C)
# Start menu
9remote

# Select: Manage Key → Regenerate Key
# Then start server again
```

**Try one-time key:**
```bash
9remote
# Select: Manage Key → Create One-Time Key
# Use this key to connect
```

**Clear browser cache:**
- Clear cookies and cache
- Try incognito/private mode
- Try different browser

## 4. Terminal/Desktop Lag

**Problem:** Slow response, high latency

**Solutions:**

**Check network:**
- Use WiFi instead of mobile data
- Move closer to router
- Close other apps using bandwidth

**Reduce quality (Remote Desktop):**
- Click Settings
- Change quality to "Low"
- Restart streaming

**Close unused sessions:**
- Close terminal tabs you're not using
- Stop Remote Desktop when not needed
- One feature at a time

**Server performance:**
- Close heavy apps on remote computer
- Check CPU usage
- Restart server if needed

## 5. Lost Connection

**Problem:** Suddenly disconnected

**Solutions:**

**Server stopped:**
```bash
# Check if server terminal is still open
# If closed, restart:
9remote
```

**Network issue:**
- Check internet connection
- Reconnect to WiFi
- Try mobile hotspot

**Tunnel expired:**
- Cloudflare tunnel may timeout
- Restart server:
```bash
# Ctrl+C to stop
9remote
```

**Browser issue:**
- Refresh page
- Clear cache
- Try different browser

## Additional Help

### Check Server Status

```bash
# See if server is running
ps aux | grep node

# Check port 2208
lsof -i:2208  # macOS/Linux
netstat -ano | findstr :2208  # Windows
```

### View Logs

Server logs appear in the terminal where you ran `9remote`. Look for error messages there.

### Reset Everything

If nothing works, complete reset:

```bash
# Stop server
Ctrl+C

# Regenerate key
9remote
# → Manage Key → Regenerate Key

# Restart server
9remote

# Connect with new key
```

## Still Having Issues?

**GitHub Issues:**
Report bugs or ask for help:
https://github.com/yourusername/9remote/issues

**Before reporting:**
- Include error messages
- Describe what you tried
- Mention your OS and Node.js version
- Include server logs if possible

## Quick Fixes Summary

| Problem | Quick Fix |
|---------|-----------|
| Can't install | `sudo npm install -g 9remote` |
| Port in use | Kill process on port 2208 |
| Can't connect | Regenerate key |
| Lag | Reduce quality, close apps |
| Disconnected | Restart server |

[← Back: File Explorer](features/file-explorer) | [Next: FAQ →](faq)
