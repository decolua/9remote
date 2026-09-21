// Agent CLI conversation history — the sessions each coding CLI keeps in its own
// store (~/.claude/projects, ~/.codex/sessions, …), listed for one cwd so the
// sidebar can offer "resume this conversation" next to the terminal it belongs to.
//
// Run: node --test agent/test/agentHistory.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, existsSync } from "fs";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import { tmpdir } from "os";
import { join } from "path";
import crypto from "crypto";

const home = mkdtempSync(join(tmpdir(), "9r-hist-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
delete process.env.CODEX_HOME;

const { listAgentSessions, encodeCwdForAgent, resumeCommand, clearHistoryCache, deleteAgentSession } =
  await import("../features/terminal/agentHistory.js");

const CWD = "/Users/Working/9remote";
const OTHER = "/Users/Working/other";

function write(relPath, content, mtimeSec) {
  const full = join(home, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content);
  if (mtimeSec) utimesSync(full, mtimeSec, mtimeSec);
  return full;
}


// Build an opencode SQLite store shaped like the real one (only the columns the
// scanner reads). Skipped when the runtime has no sqlite — so does the scanner.
let sqliteAvailable = true;
try { await import("node:sqlite"); } catch { sqliteAvailable = false; }

// Earlier tests seed the legacy file store; a db test that also wants the files
// says so explicitly rather than inheriting whatever ran before it.
function clearOpencodeFiles() {
  rmSync(join(home, ".local/share/opencode/storage/session"), { recursive: true, force: true });
}

function writeOpencodeDb(rows) {
  const dbPath = join(home, ".local/share/opencode/opencode.db");
  mkdirSync(join(dbPath, ".."), { recursive: true });
  rmSync(dbPath, { force: true });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session (id text PRIMARY KEY, project_id text, parent_id text,
    directory text NOT NULL, title text NOT NULL, time_created integer, time_updated integer)`);
  for (const r of rows) {
    db.prepare("INSERT INTO session (id, parent_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?)")
      .run(r.id, r.parent_id ?? null, r.directory, r.title, r.time_created ?? 1, r.time_updated);
  }
  db.close();
}

const listOpencode = async (cwd) => (await listAgentSessions({ cwd })).filter((s) => s.agent === "opencode");

const jsonl = (...lines) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

// --- cwd → store directory name ---

test("claude and droid encode cwd by replacing separators with dashes", () => {
  assert.equal(encodeCwdForAgent("claude", CWD), "-Users-Working-9remote");
  assert.equal(encodeCwdForAgent("droid", CWD), "-Users-Working-9remote");
});

test("grok percent-encodes the cwd", () => {
  assert.equal(encodeCwdForAgent("grok", CWD), "%2FUsers%2FWorking%2F9remote");
});

test("qwen hashes the cwd with sha256", () => {
  const digest = crypto.createHash("sha256").update(CWD).digest("hex");
  assert.equal(encodeCwdForAgent("qwen-code", CWD), digest);
});

test("an agent with no directory encoding returns null", () => {
  assert.equal(encodeCwdForAgent("codex", CWD), null);
});

// --- resume commands ---

test("resumeCommand builds each CLI's own resume invocation", () => {
  assert.equal(resumeCommand("claude", "abc"), "claude --resume abc");
  assert.equal(resumeCommand("codex", "abc"), "codex resume abc");
  assert.equal(resumeCommand("opencode", "abc"), "opencode --session abc");
  assert.equal(resumeCommand("cursor", "abc"), "cursor-agent --resume abc");
  assert.equal(resumeCommand("droid", "abc"), "droid --resume abc");
  assert.equal(resumeCommand("grok", "abc"), "grok --resume abc");
});

test("resumeCommand quotes an id containing shell metacharacters", () => {
  assert.equal(resumeCommand("claude", "a b;rm -rf /"), "claude --resume 'a b;rm -rf /'");
});

test("resumeCommand returns null for an unknown agent", () => {
  assert.equal(resumeCommand("nope", "abc"), null);
});

test("resumeCommand can re-apply the CLI's own skip-permission flag", () => {
  assert.equal(resumeCommand("claude", "abc", true), "claude --resume abc --dangerously-skip-permissions");
  assert.equal(resumeCommand("codex", "abc", true), "codex resume abc --dangerously-bypass-approvals-and-sandbox");
  // An agent with no such flag is unchanged rather than given someone else's.
  assert.equal(resumeCommand("droid", "abc", true), "droid --resume abc");
});

// --- listing ---

test("missing stores yield an empty list rather than throwing", async () => {
  clearHistoryCache();
  assert.deepEqual(await listAgentSessions({ cwd: "/nowhere/at/all" }), []);
});

test("claude sessions are listed for their own cwd only", async () => {
  write(".claude/projects/-Users-Working-9remote/aaa.jsonl", jsonl(
    { type: "user", message: { role: "user", content: "fix the login bug" }, timestamp: "2026-08-01T00:00:00Z" }
  ), 2000);
  write(".claude/projects/-Users-Working-other/bbb.jsonl", jsonl(
    { type: "user", message: { role: "user", content: "unrelated work" } }
  ), 2000);
  clearHistoryCache();

  const mine = await listAgentSessions({ cwd: CWD });
  assert.deepEqual(mine.map((s) => s.sessionId), ["aaa"]);
  assert.equal(mine[0].agent, "claude");
  assert.equal(mine[0].title, "fix the login bug");
  assert.equal(mine[0].cwd, CWD);

  const theirs = await listAgentSessions({ cwd: OTHER });
  assert.deepEqual(theirs.map((s) => s.sessionId), ["bbb"]);
});

test("a custom claude title wins over the first user prompt", async () => {
  write(".claude/projects/-Users-Working-9remote/titled.jsonl", jsonl(
    { type: "user", message: { role: "user", content: "first prompt" } },
    { type: "custom-title", customTitle: "Login rewrite" }
  ), 3000);
  clearHistoryCache();

  const row = (await listAgentSessions({ cwd: CWD })).find((s) => s.sessionId === "titled");
  assert.equal(row.title, "Login rewrite");
});

test("codex sessions are matched by the cwd inside session_meta", async () => {
  write(".codex/sessions/2026/08/01/rollout-2026-08-01T00-00-00-c1.jsonl", jsonl(
    { type: "session_meta", payload: { id: "c1", cwd: CWD } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>\n  <cwd>/x</cwd>\n</environment_context>" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "add a retry" }] } }
  ), 1000);
  write(".codex/sessions/2026/08/01/rollout-2026-08-01T00-00-00-c2.jsonl", jsonl(
    { type: "session_meta", payload: { id: "c2", cwd: OTHER } }
  ), 1000);
  clearHistoryCache();

  const rows = (await listAgentSessions({ cwd: CWD })).filter((s) => s.agent === "codex");
  assert.deepEqual(rows.map((s) => s.sessionId), ["c1"]);
  // The injected environment block is machinery, not the user's first prompt.
  assert.equal(rows[0].title, "add a retry");
});

test("codex looks past its multi-kilobyte instruction preamble to find the prompt", async () => {
  const bulk = "x".repeat(120 * 1024);
  write(".codex/sessions/2026/08/02/rollout-2026-08-02T00-00-00-c3.jsonl", jsonl(
    { type: "session_meta", payload: { id: "c3", cwd: CWD, base_instructions: { text: bulk } } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: bulk }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "buried prompt" }] } }
  ), 1050);
  clearHistoryCache();

  const row = (await listAgentSessions({ cwd: CWD })).find((s) => s.sessionId === "c3");
  assert.equal(row.title, "buried prompt");
});

test("a claude slash-command turn is skipped in favour of the real prompt", async () => {
  write(".claude/projects/-Users-Working-9remote/slash.jsonl", jsonl(
    { type: "user", message: { role: "user", content: "<command-name>/clear</command-name>\n<command-message>clear</command-message>" } },
    { type: "user", message: { role: "user", content: "the actual question" } }
  ), 3500);
  clearHistoryCache();

  const row = (await listAgentSessions({ cwd: CWD })).find((s) => s.sessionId === "slash");
  assert.equal(row.title, "the actual question");
});

test("harness-injected user turns never become a title", async () => {
  write(".claude/projects/-Users-Working-9remote/injected.jsonl", jsonl(
    { type: "user", message: { role: "user", content: "<local-command-stdout>Login successful</local-command-stdout>" } },
    { type: "user", message: { role: "user", content: "now the real one" } }
  ), 3600);
  write(".codex/sessions/2026/08/03/rollout-2026-08-03T00-00-00-c4.jsonl", jsonl(
    { type: "session_meta", payload: { id: "c4", cwd: CWD } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /Users/Working/9remote\n\nuse tabs" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "codex real prompt" }] } }
  ), 1060);
  clearHistoryCache();

  const rows = await listAgentSessions({ cwd: CWD });
  assert.equal(rows.find((s) => s.sessionId === "injected").title, "now the real one");
  assert.equal(rows.find((s) => s.sessionId === "c4").title, "codex real prompt");
});

test("opencode sessions are matched by their directory field", async () => {
  write(".local/share/opencode/storage/session/global/ses_one.json", JSON.stringify({
    id: "ses_one", directory: CWD, title: "Greeting", time: { created: 1, updated: 1767931868854 }
  }), 1500);
  write(".local/share/opencode/storage/session/global/ses_two.json", JSON.stringify({
    id: "ses_two", directory: OTHER, title: "Elsewhere", time: { created: 1, updated: 2 }
  }), 1500);
  clearHistoryCache();

  const rows = (await listAgentSessions({ cwd: CWD })).filter((s) => s.agent === "opencode");
  assert.deepEqual(rows.map((s) => s.sessionId), ["ses_one"]);
  assert.equal(rows[0].title, "Greeting");
});

test("grok sessions come from the percent-encoded cwd directory", async () => {
  write(".grok/sessions/%2FUsers%2FWorking%2F9remote/g1/summary.json", JSON.stringify({
    info: { id: "g1", cwd: CWD }, session_summary: "chào", updated_at: "2026-08-18T18:04:57Z"
  }), 1200);
  clearHistoryCache();

  const rows = (await listAgentSessions({ cwd: CWD })).filter((s) => s.agent === "grok");
  assert.deepEqual(rows.map((s) => s.sessionId), ["g1"]);
  assert.equal(rows[0].title, "chào");
});

test("qwen sessions come from the sha256 cwd directory", async () => {
  const digest = crypto.createHash("sha256").update(CWD).digest("hex");
  write(`.qwen/tmp/${digest}/chats/session-2026-01-01T10-18-abcd.json`, JSON.stringify({
    sessionId: "qwen-1",
    lastUpdated: "2026-01-01T10:18:13.382Z",
    messages: [{ type: "user", content: "hello there", timestamp: "2026-01-01T10:02:11Z" }]
  }), 1100);
  clearHistoryCache();

  const rows = (await listAgentSessions({ cwd: CWD })).filter((s) => s.agent === "qwen-code");
  assert.deepEqual(rows.map((s) => s.sessionId), ["qwen-1"]);
  assert.equal(rows[0].title, "hello there");
});

test("droid reads its title from the session_start record", async () => {
  write(".factory/sessions/-Users-Working-9remote/d1.jsonl", jsonl(
    { type: "session_start", id: "d1", title: "create 3 files", cwd: CWD }
  ), 1300);
  clearHistoryCache();

  const rows = (await listAgentSessions({ cwd: CWD })).filter((s) => s.agent === "droid");
  assert.deepEqual(rows.map((s) => s.sessionId), ["d1"]);
  assert.equal(rows[0].title, "create 3 files");
});

test("cursor strips the injected timestamp wrapper from its first prompt", async () => {
  write(".cursor/projects/-Users-Working-9remote/agent-transcripts/cur1/cur1.jsonl", jsonl(
    { role: "user", message: { content: [{ type: "text", text: "<timestamp>Sat</timestamp>\n<user_query>\nwhy is it slow\n</user_query>" }] } }
  ), 1400);
  clearHistoryCache();

  const rows = (await listAgentSessions({ cwd: CWD })).filter((s) => s.agent === "cursor");
  assert.deepEqual(rows.map((s) => s.sessionId), ["cur1"]);
  assert.equal(rows[0].title, "why is it slow");
});

test("rows are newest first and carry a runnable resume command", async () => {
  clearHistoryCache();
  const rows = await listAgentSessions({ cwd: CWD });
  const times = rows.map((s) => s.updatedAt);
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  for (const row of rows) assert.equal(typeof row.resume, "string");
});

test("limit caps the number of rows returned", async () => {
  clearHistoryCache();
  const rows = await listAgentSessions({ cwd: CWD, limit: 2 });
  assert.equal(rows.length, 2);
});

test("a session with no readable prompt still lists, untitled", async () => {
  write(".claude/projects/-Users-Working-9remote/empty.jsonl", jsonl(
    { type: "mode", mode: "normal" }
  ), 4000);
  clearHistoryCache();

  const row = (await listAgentSessions({ cwd: CWD })).find((s) => s.sessionId === "empty");
  assert.ok(row);
  assert.equal(row.title, "");
});

// --- opencode's SQLite store ---
// OpenCode moved its sessions from one-JSON-file-each into a single SQLite db;
// the old storage/ tree lingers on disk holding only pre-migration sessions, so
// reading just the files silently shows a months-old list as if it were current.

test("sessions come from the SQLite db, matched on their own directory column", async () => {
  clearOpencodeFiles();
  writeOpencodeDb([
    { id: "ses_a", directory: CWD, title: "Chào mừng", time_updated: 3000 },
    { id: "ses_b", directory: OTHER, title: "elsewhere", time_updated: 3000 }
  ]);
  clearHistoryCache();

  const rows = await listOpencode(CWD);
  assert.deepEqual(rows.map((s) => s.sessionId), ["ses_a"]);
  assert.equal(rows[0].title, "Chào mừng");
  assert.equal(rows[0].updatedAt, 3000);
});

test("a subagent session is not offered as its own conversation", async () => {
  clearOpencodeFiles();
  writeOpencodeDb([
    { id: "ses_parent", directory: CWD, title: "the real one", time_updated: 3000 },
    { id: "ses_child", directory: CWD, title: "spawned worker", time_updated: 3100, parent_id: "ses_parent" }
  ]);
  clearHistoryCache();

  assert.deepEqual((await listOpencode(CWD)).map((s) => s.sessionId), ["ses_parent"]);
});

test("db sessions and leftover pre-migration files appear once each", async () => {
  // The file store is not deleted on migration, so the same session can be in
  // both places — and older sessions live only in the files.
  clearOpencodeFiles();
  write(".local/share/opencode/storage/session/global/ses_a.json", JSON.stringify({
    id: "ses_a", directory: CWD, title: "stale copy", time: { created: 1, updated: 1 }
  }), 1500);
  write(".local/share/opencode/storage/session/global/ses_old.json", JSON.stringify({
    id: "ses_old", directory: CWD, title: "only in files", time: { created: 1, updated: 2000 }
  }), 1500);
  writeOpencodeDb([{ id: "ses_a", directory: CWD, title: "current", time_updated: 3000 }]);
  clearHistoryCache();

  const rows = await listOpencode(CWD);
  assert.deepEqual(rows.map((s) => s.sessionId), ["ses_a", "ses_old"]);
  // The db is authoritative where both have the session.
  assert.equal(rows[0].title, "current");
});

test("a missing, empty or corrupt db falls back to the files instead of throwing", async () => {
  writeFileSync(join(home, ".local/share/opencode/opencode.db"), "this is not a database");
  clearHistoryCache();
  assert.deepEqual((await listOpencode(CWD)).map((s) => s.sessionId), ["ses_old", "ses_a"]);
});

test("deleteAgentSession deletes Claude session file and updates cache", async () => {
  const filePath = write(".claude/projects/-Users-Working-9remote/to_delete.jsonl", jsonl(
    { type: "user", message: { content: "Test query to delete" } }
  ), 5000);
  clearHistoryCache();

  let rows = await listAgentSessions({ cwd: CWD });
  assert.ok(rows.some((r) => r.sessionId === "to_delete"));

  const deleted = await deleteAgentSession({ agent: "claude", sessionId: "to_delete", cwd: CWD });
  assert.equal(deleted, true);
  assert.equal(existsSync(filePath), false);

  rows = await listAgentSessions({ cwd: CWD });
  assert.equal(rows.some((r) => r.sessionId === "to_delete"), false);
});


// --- antigravity (a single index, not a transcript tree) ---

function writeAntigravityIndex(conversations) {
  write(".gemini/antigravity-cli/cache/conversation_metadata.json",
    JSON.stringify({ conversations }, null, 2));
}

const agEntry = (id, cwd, preview, updatedAt) => [id, {
  summary: { ID: id, Title: "", Preview: preview, NumSteps: 3, UpdatedAt: updatedAt,
    WorkspaceURIs: [cwd ? `file://${cwd}` : null].filter(Boolean), ProjectID: "p1" },
  is_internal: false,
  last_modified_time: updatedAt
}];

const listAntigravity = async (cwd) => (await listAgentSessions({ cwd })).filter((s) => s.agent === "antigravity");

test("antigravity lists only conversations whose workspace is the cwd", async () => {
  writeAntigravityIndex(Object.fromEntries([
    agEntry("ag_here", CWD, "Fix the parser", "2026-05-01T10:00:00Z"),
    agEntry("ag_other", OTHER, "Unrelated work", "2026-05-02T10:00:00Z"),
    agEntry("ag_none", null, "One-off in /tmp", "2026-05-03T10:00:00Z")
  ]));
  clearHistoryCache();

  const rows = await listAntigravity(CWD);
  assert.deepEqual(rows.map((s) => s.sessionId), ["ag_here"]);
  // Title is empty in the real index — the preview line is the only label there is.
  assert.equal(rows[0].title, "Fix the parser");
  // The catalog's resume form is what the row hands the terminal.
  assert.equal(rows[0].resume, "agy --conversation ag_here");
});

test("antigravity ignores a missing or corrupt index instead of throwing", async () => {
  writeFileSync(join(home, ".gemini/antigravity-cli/cache/conversation_metadata.json"), "{ not json");
  clearHistoryCache();
  assert.deepEqual(await listAntigravity(CWD), []);
});

function writeAntigravityDb(rows) {
  const dbPath = join(home, ".gemini/antigravity-cli/conversation_summaries.db");
  mkdirSync(join(dbPath, ".."), { recursive: true });
  rmSync(dbPath, { force: true });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY,
    title text, preview text, last_modified_time text, workspace_uris text)`);
  for (const r of rows) {
    db.prepare("INSERT INTO conversation_summaries (conversation_id, title, preview, last_modified_time, workspace_uris) VALUES (?,?,?,?,?)")
      .run(r.conversation_id, r.title ?? "", r.preview ?? "", r.last_modified_time ?? "", r.workspace_uris ?? "");
  }
  db.close();
}

test("deleteAgentSession drops the antigravity entry from the index", async () => {
  writeAntigravityIndex(Object.fromEntries([
    agEntry("ag_keep", CWD, "Keep me", "2026-05-01T10:00:00Z"),
    agEntry("ag_drop", CWD, "Drop me", "2026-05-02T10:00:00Z")
  ]));
  clearHistoryCache();
  assert.deepEqual((await listAntigravity(CWD)).map((s) => s.sessionId), ["ag_drop", "ag_keep"]);

  const deleted = await deleteAgentSession({ agent: "antigravity", sessionId: "ag_drop", cwd: CWD });
  assert.equal(deleted, true);
  clearHistoryCache();
  assert.deepEqual((await listAntigravity(CWD)).map((s) => s.sessionId), ["ag_keep"]);
});

test("antigravity lists conversations from SQLite database matching cwd", { skip: !sqliteAvailable }, async () => {
  rmSync(join(home, ".gemini/antigravity-cli/cache/conversation_metadata.json"), { force: true });
  writeAntigravityDb([
    { conversation_id: "ag_db1", title: "DB session", preview: "first prompt", last_modified_time: "2026-05-02T10:00:00Z", workspace_uris: JSON.stringify([`file://${CWD}`]) },
    { conversation_id: "ag_other", title: "Other DB", preview: "other prompt", last_modified_time: "2026-05-01T10:00:00Z", workspace_uris: JSON.stringify([`file://${OTHER}`]) }
  ]);
  clearHistoryCache();
  const rows = await listAntigravity(CWD);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sessionId, "ag_db1");
  assert.equal(rows[0].title, "DB session");

  const deleted = await deleteAgentSession({ agent: "antigravity", sessionId: "ag_db1", cwd: CWD });
  assert.equal(deleted, true);
  clearHistoryCache();
  assert.deepEqual(await listAntigravity(CWD), []);
});
