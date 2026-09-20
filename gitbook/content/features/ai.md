# AI & Coding Agents

Turn 9Remote into your mobile AI coding station with native support for Claude Code, OpenCode, Codex, and Jarvis.

## What It Does

9Remote goes beyond a dumb terminal pipe: it integrates deeply with modern CLI coding agents. It understands agent turn structures, tool invocations, file diffs, and live transcripts so you can direct and monitor autonomous AI agents from your phone as comfortably as from a desktop IDE.

## Supported AI Agents

9Remote provides tailored runtime adapters for popular AI coding tools:

- **Claude Code** (`claude`) - Anthropic's agentic coding CLI with tool calling, bash execution, and architecture skills.
- **OpenCode** (`opencode`) - Open-source AI coding assistant.
- **Codex** (`codex`) - Code generation and agent workflows.
- **Antigravity** - Experimental multi-model agents.

---

## Core Capabilities

### 1. Dual View: Terminal & Structured Chat
- **Terminal View:** Watch the raw terminal output as the agent runs.
- **AI Chat Pane:** Slide open a clean, structured conversation UI that formats:
  - User prompts and assistant responses.
  - Tool calls (file reading, editing, bash commands) with collapsible output.
  - Thinking blocks and status badges (running, waiting for input, completed).

### 2. Live Transcript & Rewind
- **Live Event Streaming:** Real-time state synchronizes across devices with host-authoritative clocks.
- **Turn Rewind:** Rewind agent turns back to a previous point in the conversation tree to re-try with different instructions without losing your workspace state.

### 3. Artifact Drawer
- When agents produce UI components, HTML mockups, SVG graphics, or reports:
  - 9Remote automatically opens the **Artifact Viewer** next to your terminal.
  - Renders live HTML, interactive diagrams, and formatted markdown without leaving your session.

### 4. Quota & Token Tracking
- Live tracking of token consumption and rate limits.
- Model selector allowing you to switch between Claude models (Sonnet, Haiku, Opus) or local providers.

### 5. Jarvis & Task Kanban Board
- **Jarvis Assistant:** Quick voice or text commands to dispatch tasks across your repositories.
- **Kanban Board:** View and organize agent tasks across multiple sessions in one central board (`todo`, `in_progress`, `needs_input`, `done`).

---

## Workflow: Running Claude Code on Your Phone

1. Open **Terminal** in 9Remote on your phone.
2. Select or type `claude` (or start your coding agent).
3. Tap the **AI Chat** toggle to view the structured card view.
4. Issue prompts, approve bash/tool executions with single-tap buttons, and view code diffs.
5. Lock your phone or switch apps: 9Remote sends a **Push Notification** when the turn completes or requires your approval.

---

## Next Steps

- Test web apps built by your AI using [Site Browser](site-browser)
- Manage code changes with [File Explorer & Git](file-explorer)
