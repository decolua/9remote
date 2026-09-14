// Rebuilding a chat log from Claude's own transcript file. Split out of ptyDaemon
// so the lookup can be tested without starting a daemon — an unbound conversation
// shows as an empty chat pane, which looks like a UI bug rather than a lookup miss.
import fs from "fs";
import path from "path";
import os from "os";

// `cliSessionId` can originate from a client (a /resume choice), so it is untrusted:
// only a plain id is accepted — the first character may not be "-" (argv would read it
// as a flag) and no path separator or whitespace is allowed — and the resolved path is
// confirmed to sit inside the projects directory. Without this, `..` in the id would
// escape the directory and read any file on disk.
export const CLAUDE_SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;

const readdirOr = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

function findTranscript(cwd, cliSessionId) {
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  const safeCwd = String(cwd).replace(/[/\\:]/g, "-");
  let p = path.join(projectsDir, safeCwd, `${cliSessionId}.jsonl`);
  if (!fs.existsSync(p) && !safeCwd.startsWith("-")) {
    p = path.join(projectsDir, `-${safeCwd}`, `${cliSessionId}.jsonl`);
  }
  // The transcript lives under the directory the CLI was STARTED in, which the
  // terminal may have since `cd`'d away from — so a miss on the cwd-derived path
  // says nothing about the conversation existing. Find it by id instead.
  if (!fs.existsSync(p)) {
    for (const entry of readdirOr(projectsDir)) {
      const candidate = path.join(projectsDir, entry, `${cliSessionId}.jsonl`);
      if (fs.existsSync(candidate)) { p = candidate; break; }
    }
  }
  // Defense in depth: even with the id validated, never read outside the projects dir.
  const resolved = path.resolve(p);
  if (!resolved.startsWith(path.resolve(projectsDir) + path.sep)) return null;
  return fs.existsSync(resolved) ? resolved : null;
}

export function recoverFromClaudeTranscript(cwd, cliSessionId, startSeq = 1) {
  if (!cwd || !cliSessionId) return null;
  if (!CLAUDE_SESSION_ID_RE.test(cliSessionId)) return null;
  const resolved = findTranscript(cwd, cliSessionId);
  if (!resolved) return null;

  try {
    const lines = fs.readFileSync(resolved, "utf8").trim().split("\n");
    const events = [];
    let seq = startSeq;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        // A sidechain record is a sub-agent's own turn, not one the user typed. Kept out
        // of the log for the same reason the rewind list keeps it out: the pane would
        // show it as a prompt nobody sent, and every turn after it would be counted one
        // too high — which is exactly what the rewind control names turns by.
        if (d.type === "user" && d.message && !d.isSidechain) {
          const textBlock = (d.message.content || []).find((c) => c.type === "text");
          if (textBlock && textBlock.text) {
            events.push({ seq: seq++, event: "user_message", data: { text: textBlock.text } });
          }
          const toolResults = (d.message.content || []).filter((c) => c.type === "tool_result");
          for (const tr of toolResults) {
            events.push({
              seq: seq++,
              event: "tool_result",
              data: {
                id: tr.tool_use_id,
                output: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content)
              }
            });
          }
        } else if (d.type === "assistant" && d.message) {
          for (const item of d.message.content || []) {
            if (item.type === "thinking" && item.thinking) {
              events.push({ seq: seq++, event: "thinking", data: { text: item.thinking } });
            } else if (item.type === "tool_use") {
              events.push({ seq: seq++, event: "tool_start", data: { id: item.id, name: item.name, input: item.input } });
            } else if (item.type === "text" && item.text) {
              events.push({ seq: seq++, event: "delta", data: { text: item.text } });
            }
          }
          events.push({ seq: seq++, event: "turn_complete", data: { stats: {} } });
        }
      } catch {}
    }

    return events.length > 0 ? events : null;
  } catch {
    return null;
  }
}
