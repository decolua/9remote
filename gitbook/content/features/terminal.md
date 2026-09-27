# Terminal

Full-featured remote terminal access with persistent daemon sessions, Git worktree support, and AI coding agent integration.

## What It Does

9Remote Terminal delivers complete command-line access through any browser or mobile device. Unlike standard SSH or web terminals, sessions run on a persistent daemon on your computer so your processes stay alive even across network drops or host restarts.

## Core Features

### Persistent PTY Daemon
- **Session Persistence:** Terminal processes run via an independent background daemon (`ptyDaemon`).
- **Survive Disconnects:** Long-running builds, tests, or Docker processes continue executing even if your browser disconnects, your phone locks, or the host restarts.
- **Instant Reattachment:** Reconnecting returns you immediately to your active session and command history.

### Multiple Sessions & Workspace Tabs
- Open and manage multiple terminal tabs simultaneously.
- Rename sessions for clear identification (e.g., `dev-server`, `db-migrate`, `tests`).
- Switch tabs with a tap or keyboard shortcut.
- Sessions run independently in the background.

### Location Picker & Git Worktree Management
- **Directory Switching:** Quickly navigate to recent folders or repositories using the built-in location picker.
- **Git Worktree Support:**
  - Create new Git worktrees directly when launching or configuring a terminal session.
  - Active branch badges indicate the current branch of the session.
  - Delete or clean up worktrees with safe branch verification directly from the UI header.

### AI Coding Agent Integration
- Launch coding assistants (Claude Code, OpenCode, Codex) directly in terminal sessions.
- **AI Chat Pane:** Slide open a dedicated AI chat pane alongside the terminal to follow the assistant's actions, tool executions, and step progress.
- **Artifacts:** Inspect generated HTML pages, SVGs, or markdown artifacts side-by-side with your terminal.

### Mobile Virtual Keyboard & Gestures
- Floating and docked on-screen keyboard optimized for mobile devices:
  - Dedicated modifier keys: **Ctrl**, **Alt**, **Shift**, **Esc**.
  - Navigation keys: **Tab**, **Arrow Keys**, **Home**, **End**, **PageUp/PageDown**.
  - Function keys (**F1-F12**).
  - Modifier locking (sticky keys) for one-handed shortcut execution (e.g., Ctrl+C, Ctrl+R).
- Smooth touch scrolling with momentum and pinch-to-zoom.

### Push Notifications
- Receive push notifications on your phone or browser when:
  - A long-running command finishes.
  - An interactive command or AI agent requests user input.
  - A process exits with an error status.

### Theme & Customization
- Choose from curated themes: Default Dark, Light, Dracula, Monokai, Solarized Dark, and Solarized Light.
- Customizable font size and line height.

---

## Keyboard Shortcuts

- **Ctrl+C** - Interrupt current process
- **Ctrl+D** - EOF / close shell session
- **Ctrl+L** - Clear screen
- **Ctrl+R** - Reverse search command history
- **Tab** - Command / path autocomplete
- **↑ / ↓** - Cycle through command history

---

## Next Steps

- Explore [AI & Coding Agents](ai)
- Try [Site Browser](site-browser) to test web apps
- Learn about [File Explorer & Transfer](file-explorer)
