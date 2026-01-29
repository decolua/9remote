# Using GitHub Codespaces

Access your Codespace from anywhere using 9Remote - perfect for coding on the go!

## What is This?

GitHub Codespaces gives you a cloud development environment. With 9Remote, you can access it from your phone or any device, anywhere.

## Quick Setup

### Step 1: Install 9Remote in Your Codespace

Open the terminal in your Codespace and run:

```bash
npm install -g 9remote
```

### Step 2: Enable Auto-Start (Recommended)

**Method 1: From 9Remote App (Easiest)**

1. Connect to your Codespace with 9Remote
2. Open the menu (☰)
3. Tap "Codespace"
4. Toggle "Auto Start 9Remote" ON

Now 9Remote will start automatically every time you open this Codespace!

**Method 2: Using devcontainer.json**

Create or edit `.devcontainer/devcontainer.json` in your repo:

```json
{
  "postStartCommand": "9remote start"
}
```

This will start 9Remote automatically without showing the menu.

### Step 3: Connect from Your Phone

After 9Remote starts, you'll see:
- **QR Code** - Scan with your phone camera
- **Access Key** - Or enter manually at `remote.9router.com/login`

That's it! Now you can code from your phone.

## What Can You Do?

Once connected:
- [icon:check-circle] Run terminal commands
- [icon:check-circle] Edit code files
- [icon:check-circle] View desktop (if enabled)
- [icon:check-circle] Access your dev server
- [icon:check-circle] Debug from anywhere

## Usage Tips

**Free Tier**
- 60 hours/month free
- Perfect for side projects
- No credit card needed

**Auto-Stop**
- Codespace stops after 30 min idle
- Your work is saved
- 9Remote reconnects when you restart

**Port Forwarding**
- Dev servers (3000, 8080, etc.) work automatically
- Access via 9Remote tunnel
- No manual port setup needed

## Common Use Cases

**1. Code on the Go**
- Stuck in traffic? Fix that bug from your phone
- At cafe without laptop? Review PRs
- Traveling light? Full dev environment in pocket

**2. Quick Fixes**
- Emergency hotfix needed
- Check logs remotely
- Restart services

**3. Show & Tell**
- Demo your work from phone
- Share screen in meetings
- Quick code reviews

## Troubleshooting

**9Remote not starting?**
```bash
# Check if installed
9remote --version

# Reinstall if needed
npm install -g 9remote
```

**Can't connect from phone?**
- Wait 30 seconds after Codespace starts
- Check QR code is visible
- Try manual key entry

**Codespace stopped?**
- Just restart it from GitHub
- 9Remote auto-starts (if configured)
- Reconnect from phone

## Ready for Local Use?

If you want 9Remote on your own computer:

[icon:arrow-right] **[Installation Guide](/getting-started)**

Local installation:
- Faster performance
- No time limits
- Works offline
- Your own machine

---

**Questions?** Check our [FAQ](/faq) or [Troubleshooting](/troubleshooting) guide.


