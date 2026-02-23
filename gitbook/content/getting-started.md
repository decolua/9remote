# Getting Started

Get up and running with 9Remote in just 2 minutes.

## Installation

Install the CLI tool globally using npm:

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

Start the 9Remote server on your computer:

```bash
9remote start
```

The server will:
1. Start local server on port 2208
2. Create a secure Cloudflare tunnel
3. Generate a QR code for easy connection

Wait about 30-60 seconds for the tunnel to be ready.

## Connect

You have two ways to connect:

### Option 1: QR Code (Recommended)

1. Open your phone camera or QR scanner
2. Scan the QR code displayed in terminal
3. Browser opens automatically → You're connected!

### Option 2: Manual Key Entry

1. Visit: `https://9remote.cc/login`
2. Enter the access key shown in terminal
3. Click "Connect"

## Using Codespaces (Alternative)

Want to try 9Remote without installing? Use GitHub Codespaces - it runs in your browser!

[icon:arrow-right] **[Try in Browser (Codespaces)](getting-started/codespaces)**

Quick overview:
1. Open 9Remote on GitHub
2. Click "Code" → "Create Codespace"
3. Wait 1-2 minutes for setup
4. QR code appears → Scan with phone
5. Start using 9Remote instantly!

No installation, no setup, just try it!

---

## Choose Your Feature

Once connected, you'll see three options:

- **Terminal** - Access command line
- **Remote Desktop** - Control your screen
- **File Explorer** - Browse and edit files

Click any feature to start using it.

## Stop Server

To stop the server, press `Ctrl+C` in the terminal where it's running.

## Next Steps

- Learn about [Terminal](features/terminal) features
- Try [Remote Desktop](features/remote-desktop) control
- Explore [File Explorer](features/file-explorer) capabilities

## Troubleshooting

Having issues? Check our [Troubleshooting Guide](troubleshooting) for common solutions.
