// Load an image/file into the OS clipboard so terminal CLIs (Claude Code, Codex)
// can read it on Ctrl+V — mirrors pasting directly on the host machine.
import { spawn } from "child_process";

function run(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    if (p.stderr) p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} exited ${code}`))));
    if (input != null) p.stdin.write(input);
    p.stdin.end();
  });
}

// Capture stdout of a command as a string (for reading clipboard text)
function runText(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    if (p.stdout) p.stdout.on("data", (d) => { out += d.toString(); });
    if (p.stderr) p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `${cmd} exited ${code}`))));
  });
}

const isImage = (type) => typeof type === "string" && type.startsWith("image/");

// Per-OS: put an image (pixel data) vs a file reference onto the system clipboard.
const PLATFORM = {
  darwin: {
    image: (p) => run("osascript", ["-e", `set the clipboard to (read (POSIX file ${JSON.stringify(p)}) as «class PNGf»)`]),
    file: (p) => run("osascript", ["-e", `set the clipboard to POSIX file ${JSON.stringify(p)}`])
  },
  linux: {
    image: (p) => run("xclip", ["-selection", "clipboard", "-t", "image/png", "-i", p]),
    file: (p) => run("xclip", ["-selection", "clipboard", "-t", "text/uri-list", "-i"], `file://${p}\n`)
  },
  win32: {
    image: (p) => run("powershell.exe", ["-NonInteractive", "-NoProfile", "-STA", "-Command",
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile(${JSON.stringify(p)}))`]),
    file: (p) => run("powershell.exe", ["-NonInteractive", "-NoProfile", "-STA", "-Command",
      `Set-Clipboard -Path ${JSON.stringify(p)}`])
  }
};

export async function setClipboardFromFile(filePath, type) {
  const handlers = PLATFORM[process.platform];
  if (!handlers) throw new Error(`clipboard unsupported on ${process.platform}`);
  return isImage(type) ? handlers.image(filePath) : handlers.file(filePath);
}

// Per-OS text clipboard read/write for 2-way clipboard sync.
const TEXT_PLATFORM = {
  darwin: {
    get: () => runText("pbpaste", []),
    set: (text) => run("pbcopy", [], text)
  },
  linux: {
    get: () => runText("xclip", ["-selection", "clipboard", "-o"]),
    set: (text) => run("xclip", ["-selection", "clipboard"], text)
  },
  win32: {
    get: () => runText("powershell.exe", ["-NonInteractive", "-NoProfile", "-STA", "-Command", "Get-Clipboard -Raw"]),
    set: (text) => run("powershell.exe", ["-NonInteractive", "-NoProfile", "-STA", "-Command", `$Input | Set-Clipboard`], text)
  }
};

export async function getClipboardText() {
  const ops = TEXT_PLATFORM[process.platform];
  if (!ops) throw new Error(`clipboard unsupported on ${process.platform}`);
  return (await ops.get()).replace(/\r\n/g, "\n");
}

export async function setClipboardText(text) {
  const ops = TEXT_PLATFORM[process.platform];
  if (!ops) throw new Error(`clipboard unsupported on ${process.platform}`);
  return ops.set(text);
}
