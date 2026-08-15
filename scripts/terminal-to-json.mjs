#!/usr/bin/env node
// Convert terminal content into structured JSON events.
//
//   node scripts/terminal-to-json.mjs agent/test/fixtures/claude-session.raw
//   cat capture.raw | node scripts/terminal-to-json.mjs
//   node scripts/terminal-to-json.mjs --session session-123      # live, via the daemon replay
//   node scripts/terminal-to-json.mjs --screen agent/test/fixtures/claude-session.raw  # screen text only
//
// Output: one JSON object per line — { screen } or { events: [...] } — ready to diff,
// pipe into jq, or store as fixtures for the parser's tests.
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

const { parseScreen, applyScreenStream } = await import("../agent/features/agentChat/screenParser.js");
const { CLAUDE_PROFILE } = await import("../agent/features/agentChat/cliProfiles.js");

const args = process.argv.slice(2);
const screenOnly = args.includes("--screen");
const sessionIdx = args.indexOf("--session");
const files = args.filter((a) => !a.startsWith("--") && a !== (sessionIdx >= 0 ? args[sessionIdx + 1] : null));

let bytes = "";
if (sessionIdx >= 0) {
  bytes = await readLiveSession(args[sessionIdx + 1]);
} else if (files.length) {
  bytes = fs.readFileSync(files[0], "utf8");
} else {
  bytes = fs.readFileSync(0, "utf8");   // stdin
}

const profile = CLAUDE_PROFILE;
const screen = parseScreen(bytes, profile);

if (screenOnly) {
  console.log(JSON.stringify({ screen }));
} else {
  const events = applyScreenStream(screen, profile);
  console.log(JSON.stringify({ profile: profile.id, events }, null, 2));
}

// Pull the daemon's join replay — the same tail the browser receives on connect.
function readLiveSession(sessionId) {
  return new Promise((resolve, reject) => {
    const socketPath = process.platform === "win32"
      ? "\\\\.\\pipe\\9remote-pty"
      : path.join(os.homedir(), ".9remote", "pty-daemon.sock");
    const sock = net.connect(socketPath);
    let buf = "";
    const parts = [];
    sock.on("connect", () => sock.write(JSON.stringify({ type: "joinSession", sessionId, requestId: 1 }) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "output" && msg.data) parts.push(Buffer.from(msg.data, "base64").toString("utf8"));
        if (msg.type === "joinResult") { sock.end(); return resolve(parts.join("")); }
      }
    });
    sock.on("error", reject);
    setTimeout(() => { sock.destroy(); reject(new Error("timeout talking to the pty daemon")); }, 4000);
  });
}
