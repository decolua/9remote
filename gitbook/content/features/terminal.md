# Terminal

Access your terminal from anywhere with full command-line capabilities.

## What It Does

9Remote Terminal gives you complete terminal access through your browser. It's like sitting in front of your computer, but you can be anywhere in the world.

## Core Features

### Multiple Sessions

Run multiple terminal sessions simultaneously:
- Click "New Session" to create a new tab
- Switch between sessions instantly
- Each session is independent
- Sessions persist until you close them

### Copy & Paste

Full clipboard support:
- **Copy**: Select text → Right-click → Copy (or Ctrl+C)
- **Paste**: Right-click → Paste (or Ctrl+V)
- Works seamlessly between your device and remote terminal

### Theme Options

Choose from 6 beautiful themes:
- Default (dark)
- Light
- Dracula
- Monokai
- Solarized Dark
- Solarized Light

Change theme from the menu (☰) → Settings → Theme

### Mobile Keyboard

Special on-screen keyboard for mobile devices:
- Ctrl, Alt, Shift, Esc keys
- Arrow keys
- Tab key
- Function keys (F1-F12)
- Tap to expand/collapse

## How to Use

### Create a Session

1. Click "New Session" button
2. Terminal opens immediately
3. Start typing commands

### Rename Session

1. Click session tab
2. Click "Rename" from menu
3. Enter new name
4. Easier to identify multiple sessions

### Switch Sessions

- Click any tab to switch
- Swipe left/right on mobile
- All sessions run in background

### Close Session

1. Click session tab
2. Click "Close" from menu
3. Or type `exit` in terminal

## Mobile Tips

**Use Landscape Mode**
- Better keyboard layout
- More screen space
- Easier typing

**On-Screen Keyboard**
- Tap keyboard icon to show/hide
- Use Ctrl/Alt combinations
- Swipe to scroll terminal

**Touch Scroll**
- Swipe up/down to scroll
- Smooth inertia scrolling
- Pinch to zoom (if needed)

## Common Commands

```bash
# Navigate directories
cd /path/to/directory
ls -la

# Edit files
nano file.txt
vim file.txt

# System info
top
htop
df -h

# Network
ping google.com
curl https://example.com

# Process management
ps aux
kill <pid>
```

## Tips & Tricks

**Use tmux or screen**
- Sessions persist even if disconnected
- Multiple panes in one session
- Detach and reattach anytime

```bash
# Install tmux
sudo apt install tmux  # Ubuntu/Debian
brew install tmux      # macOS

# Start tmux
tmux

# Detach: Ctrl+B then D
# Reattach: tmux attach
```

**Customize Your Prompt**
Make your prompt more informative:

```bash
# Add to ~/.bashrc or ~/.zshrc
export PS1="\u@\h:\w$ "
```

**Use Aliases**
Save time with shortcuts:

```bash
# Add to ~/.bashrc or ~/.zshrc
alias ll='ls -la'
alias gs='git status'
alias gp='git pull'
```

## Keyboard Shortcuts

- **Ctrl+C** - Interrupt current command
- **Ctrl+D** - Exit shell (close session)
- **Ctrl+L** - Clear screen
- **Ctrl+R** - Search command history
- **Tab** - Auto-complete
- **↑/↓** - Navigate command history

## Need Help?

- Terminal not responding? Refresh browser
- Lost connection? Check if server is still running
- Can't type? Click terminal area to focus
- Mobile keyboard not showing? Tap keyboard icon

[← Back to Getting Started](getting-started) | [Next: Remote Desktop →](remote-desktop)
