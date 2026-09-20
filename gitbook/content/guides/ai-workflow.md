# Advanced AI Workflow

Master the complete mobile vibe-coding loop: Git Worktrees, Claude Code, Artifacts, and Site Browser.

## The Problem: Coding Away From Your Desk

Running AI coding agents (like Anthropic's Claude Code or OpenCode) often requires frequent approval of bash commands, file diff inspections, and testing local web applications. Staring at your monitor for minutes while an agent works is unproductive, yet switching to a phone usually means clunky SSH apps without mobile formatting.

9Remote provides a cohesive end-to-end mobile development workflow designed specifically for autonomous AI agents.

---

## The 6-Step Mobile AI Loop

```text
┌─────────────────────────┐
│ 1. Create Git Worktree  │ Isolated sandbox branch
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 2. Launch Coding Agent  │ Claude Code / OpenCode
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 3. Structured Chat View │ Follow turn state & tools
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 4. Push Notification    │ Get alerted on completion
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 5. Inspect Artifacts    │ Live UI & diagram preview
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│ 6. Test on Site Browser │ Preview localhost on phone
└─────────────────────────┘
```

---

### Step 1: Create an Isolated Git Worktree
Never let an autonomous agent modify your working branch directly.
1. In 9Remote Terminal, tap the **Location Picker** at the top.
2. Select **New Worktree**.
3. Name your branch (e.g. `feat/auth-redesign`).
4. 9Remote creates a clean Git worktree and automatically switches the session's working directory.

### Step 2: Launch Your Coding Agent
In the terminal tab, launch your assistant:
```bash
claude
# Or your preferred agent: opencode, codex
```

### Step 3: Switch to the Structured AI Chat Pane
Tap the **AI Chat** icon on the top toolbar:
- **Card-based Turns:** Clean chat bubbles for user prompts and assistant reasoning.
- **Collapsible Tool Calls:** Tool executions (file edits, grep searches, bash commands) are rendered as expandable cards rather than wall-of-text console dumps.
- **Single-Tap Approvals:** When Claude asks permission to run a bash command, tap **Approve** right from the mobile card.

### Step 4: Walk Away with Push Notifications
You don't need to keep the app open:
- Lock your phone or switch to messaging apps.
- 9Remote monitors the agent's turn status.
- When the agent finishes or needs your input, your phone receives a native push notification:
  > *"Claude Code finished task: 4 files modified, tests passing"*

### Step 5: View Generated Artifacts
If the agent outputs a visual mockup, diagram, or report:
- 9Remote slides out the **Artifact Viewer** next to your terminal.
- Test interactive HTML components, SVG wireframes, or formatted markdown documentation immediately.

### Step 6: Test Live in Site Browser
Verify the agent's code in a real browser:
1. Ensure your dev server is running in a terminal tab (`npm run dev`).
2. Navigate to the **Site Browser** tab.
3. Enter `localhost:3000`.
4. Test mobile responsiveness, touch interactions, and CSS layouts on your actual smartphone.

### Step 7: Review & Merge
1. Open the **File Explorer** tab to inspect file diffs and commit changes.
2. Merge or push the branch to GitHub.
3. Clean up: tap the worktree root header in File Explorer to safely remove the worktree.

---

## Integrating MCP Tools with 9Remote

9Remote supports MCP (Model Context Protocol) tool servers:
- Configure MCP servers in your agent's config (e.g., `~/.claude/settings.json` or project settings).
- 9Remote surfaces MCP tool requests cleanly in the AI chat stream with input and output inspectors.

---

## Next Steps

- Explore [Self-Hosting 9Remote](self-hosting)
- Read [Troubleshooting](../troubleshooting)
