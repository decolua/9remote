# File Explorer

Browse directories, edit code, transfer files, and manage Git repositories and worktrees from anywhere.

## What It Does

9Remote File Explorer provides a full cloud-IDE file management experience in your browser or phone. Navigate your computer's filesystem, edit source code with syntax highlighting, upload and download files, and perform Git operations without touching SSH or FTP.

## Core Features

### File Tree Navigation
- Browse any authorized directory on your computer with fast file indexing.
- Expand and collapse folder trees with infinite scroll support.
- Quick navigation with interactive breadcrumbs.
- Workspace switcher: Jump between active project directories and recent folders.

### File Upload & Download
- **Upload Files:** Upload files or archives from your phone or client browser directly to any folder on your computer.
- **Download Files:** Download individual files or directories (zipped automatically) back to your device.
- **Resilient Transfers:** Chunked streaming transfer manager (`TransferManager`) with acknowledgment tracking ensures large file transfers succeed even on unstable cellular connections.

### Built-in Code Editor
- Lightweight, fast code editor designed for desktop and mobile:
  - Syntax highlighting for 20+ programming languages (JavaScript, TypeScript, Python, Rust, Go, HTML, CSS, JSON, Markdown, YAML, etc.).
  - Line numbers, indentation guides, and matching bracket highlights.
  - Search and replace with regex support.
  - Multi-tab editing: keep multiple files open simultaneously.

### Git & Worktree Integration
- **Status & Diffs:** Real-time visibility into modified, added, staged, and untracked files with color-coded badges and side-by-side diffs.
- **Commits & Push:** Stage files, write commit messages, and push to remote repositories directly from the UI.
- **Git Worktree Management:**
  - Create isolated Git worktrees for parallel branch work without stashing or switching branches.
  - Delete or clean up worktrees safely with root header controls and branch safety checks.

### File Previews & Artifacts
- Built-in previewers for Markdown documents, images, SVG graphics, and interactive web artifacts.

---

## How to Use

### Uploading & Downloading
1. Navigate to the desired folder in the file tree.
2. Tap the **Upload** button to select files from your phone or drag and drop files from your desktop.
3. To download, right-click (or long-press) any file and choose **Download**.

### Working with Git
1. Open a folder that is a Git repository.
2. Tap the **Git** tab to view changed files.
3. Click any changed file to view the line-by-line diff.
4. Stage changes, type a commit message, and tap **Commit & Push**.

---

## Editor Shortcuts

- **Ctrl+S** - Save file
- **Ctrl+F** - Find in file
- **Ctrl+H** - Find and replace
- **Ctrl+Z / Ctrl+Y** - Undo / Redo
- **Tab / Shift+Tab** - Indent / Outdent

---

## Security: Path Jail (`pathGuard`)

9Remote enforces strict path-jail boundaries on the host machine. Directory traversal attacks (`../`) and unauthorized system paths are automatically rejected by the host's security guard, ensuring client sessions can only access explicitly configured workspaces.

---

## Next Steps

- Check out [Terminal & Sessions](terminal)
- Inspect generated code with [AI & Coding Agents](ai)
- Review [Troubleshooting](troubleshooting)
