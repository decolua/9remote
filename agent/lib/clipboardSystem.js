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
