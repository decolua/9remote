// A resumed conversation is found by id, not by the directory the terminal happens
// to be standing in: the CLI writes its transcript under the directory it STARTED
// in, and the terminal may have `cd`'d away since. Getting this wrong is silent —
// the chat pane opens empty on a conversation that plainly exists.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "recover-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const startedIn = "/Users/someone/repo";
const elsewhere = "/tmp";
const projectsDir = path.join(home, ".claude", "projects");
const dir = path.join(projectsDir, startedIn.replace(/[/\\:]/g, "-"));
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${ID}.jsonl`), [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hello there" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })
].join("\n"));

const { recoverFromClaudeTranscript: recover } = await import("../features/ai/claudeTranscript.js");

const found = recover(elsewhere, ID);
assert.ok(found, "transcript must be found even when cwd has moved on");
assert.equal(found.filter((e) => e.event === "user_message").length, 1);
assert.equal(found.filter((e) => e.event === "delta").length, 1);

// The id stays untrusted: a path-shaped one must not escape the projects dir.
assert.equal(recover(elsewhere, "../../../etc/passwd"), null);
assert.equal(recover(elsewhere, "-flag-shaped"), null);
assert.equal(recover(elsewhere, "no/slashes"), null);

// A turn the CLI wrote itself — the note left where a turn was interrupted — must not
// come back as something the user typed. It carries no turn_complete after it, so a
// replayed log ending on one reads as "a turn is still running" to every client, and the
// chat stops sending. Both shapes were seen in the wild; the shorter one is older.
const HARNESS_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
fs.writeFileSync(path.join(dir, `${HARNESS_ID}.jsonl`), [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "real question" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "an answer" }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "[Image #1]" }] } })
].join("\n"));

const harness = recover(elsewhere, HARNESS_ID);
const texts = harness.filter((e) => e.event === "user_message").map((e) => e.data.text);
assert.deepEqual(texts, ["real question", "[Image #1]"],
  `interrupt notes must not replay as prompts, got: ${JSON.stringify(texts)}`);

fs.rmSync(home, { recursive: true, force: true });
console.log("recoverTranscript: ok");
