// Tests for the Antigravity (agy) adapter's stream-json normalization.
// Run: node agent/test/antigravityAdapter.test.mjs
import assert from "node:assert/strict";
import { AntigravityAdapter } from "../features/ai/adapters/antigravityAdapter.js";

let pass = 0, fail = 0;
const test = (name, fn) => {
  return Promise.resolve()
    .then(fn)
    .then(() => { pass++; console.log(`  ✓ ${name}`); })
    .catch((e) => { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); });
};

// Collects the events an adapter emits while replaying recorded `agy` output lines.
function replay(lines, setup = () => {}) {
  const events = [];
  const adapter = new AntigravityAdapter({ cwd: "/tmp", onEvent: (e, d) => events.push([e, d]) });
  setup(adapter);
  for (const line of lines) adapter.handleEvent(JSON.parse(line));
  return { adapter, events, of: (name) => events.filter(([e]) => e === name) };
}

const INIT = JSON.stringify({
  event: "init",
  conversation_id: "conv-1",
  init: { model: "gemini-3.8-flash-low", permission_mode: "request-review" }
});

const step = (o) => JSON.stringify({ event: "step_update", step_update: o });

console.log("Running Antigravity adapter tests...");

await test("registers agy as its own doctor command", () => {
  assert.deepEqual(AntigravityAdapter.doctorSpec(), { command: "agy", args: ["--version"] });
});

await test("attaches the prompt with = so it is not eaten by a following flag", () => {
  const { adapter } = replay([]);
  const args = adapter.buildArgs("hello world");
  assert.equal(args.at(-1), "-p=hello world");
  assert.ok(args.includes("--output-format") && args.includes("stream-json"));
});

await test("defaults to accept-edits, and plan mode replaces the bypass flag", () => {
  const { adapter } = replay([]);
  assert.ok(adapter.buildArgs("x").includes("--dangerously-skip-permissions"));

  adapter.setOptions({ mode: "plan" });
  const args = adapter.buildArgs("x");
  assert.deepEqual(args.slice(args.indexOf("--mode"), args.indexOf("--mode") + 2), ["--mode", "plan"]);
  assert.ok(!args.includes("--dangerously-skip-permissions"));
});

await test("a model carrying its own tier never rides with --effort — agy refuses the pair", () => {
  const { adapter } = replay([]);
  adapter.setOptions({ model: "gemini-3.8-flash-low", mode: "accept-edits" });
  assert.ok(!adapter.buildArgs("x").some((a) => a === "--effort" || a.startsWith("--effort=")));

  // Picking a level drops the suffix instead, and the two go out as model + effort.
  adapter.setOptions({ effort: "high" });
  const args = adapter.buildArgs("x");
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "gemini-3.8-flash"]);
  assert.deepEqual(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2), ["--effort", "high"]);

  // A tierless model keeps both; a level `agy` does not know is ignored, not sent.
  adapter.setOptions({ model: "gemini-3.1-pro", effort: "medium" });
  assert.ok(adapter.buildArgs("x").includes("--effort"));
  adapter.setOptions({ effort: "bogus" });
  const kept = adapter.buildArgs("x");
  assert.deepEqual(kept.slice(kept.indexOf("--effort"), kept.indexOf("--effort") + 2), ["--effort", "medium"]);

  // A model string carrying a tab-separated label is sanitized to the clean ID.
  adapter.setOptions({ model: "gemini-3.8-flash-high\tGemini 3.8 Flash (High)", effort: "" });
  const sanitized = adapter.buildArgs("x");
  assert.deepEqual(sanitized.slice(sanitized.indexOf("--model"), sanitized.indexOf("--model") + 2), ["--model", "gemini-3.8-flash-high"]);
});

await test("adopts the conversation id so the next turn can resume", () => {
  const { adapter, of } = replay([INIT]);
  assert.equal(adapter.activeConversationId, "conv-1");
  // Emitted as `sessionId`: that is the key aiSession reads to persist the id.
  assert.equal(of("init")[0][1].sessionId, "conv-1");
  assert.ok(adapter.buildArgs("x").includes("conv-1"));
});

await test("persists the conversation id on the session, so a reload can resume it", async () => {
  const { AiSession } = await import("../features/ai/aiSession.js");
  const s = new AiSession({ id: "antigravity-test", engine: "antigravity", cwd: "/tmp", options: {}, onEvent: () => {} });
  s.emitNormalized("init", { sessionId: "conv-xyz" });
  assert.equal(s.cliSessionId, "conv-xyz");
  assert.equal(s.metadata().sessionId, "conv-xyz");
});

await test("forwards every text_delta — the DONE event carries the reply's tail", () => {
  // Recorded from a real turn: the CLI cuts mid-word, so the DONE delta is not just a
  // newline. Keeping only ACTIVE deltas truncated this reply at "…successfu".
  const { of } = replay([
    INIT,
    step({ step_index: 0, state: "DONE", step_type: "user_input" }),
    step({ step_index: 1, state: "DONE", step_type: "agent_response", usage: { output_tokens: 750 } }),
    step({ step_index: 3, state: "ACTIVE", step_type: "agent_response", text_delta: "I have successfu" }),
    step({ step_index: 3, state: "DONE", step_type: "agent_response", text_delta: "lly executed it.\n", usage: { output_tokens: 252 } })
  ]);
  assert.equal(of("delta").map(([, d]) => d.text).join(""), "I have successfully executed it.\n");
});

await test("pairs a tool start with its result under the same id", () => {
  const { of } = replay([
    INIT,
    step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "list_dir", tool_info: { parameters: { DirectoryPath: "/tmp" } } }),
    step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "list_dir", tool_info: { output: "a.txt" } })
  ]);
  const [start] = of("tool_start");
  const [result] = of("tool_result");
  assert.equal(start[1].id, result[1].id);
  assert.equal(result[1].output, "a.txt");
});

await test("a denied tool becomes an escalating blocked card, not a tool error", () => {
  const { of } = replay([
    INIT,
    step({
      step_index: 4,
      state: "ERROR",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { error: { type: "TOOL_ERROR", message: "permission check failed for command: user denied permission to run command" } }
    })
  ], (a) => a.setOptions({ mode: "plan" }));
  assert.equal(of("tool_result").length, 0);
  const [blocked] = of("blocked");
  assert.equal(blocked[1].engine, "antigravity");
  assert.equal(blocked[1].escalate.mode, "accept-edits");
});

await test("at the top of the ladder a denial has nothing to escalate to", () => {
  const { of } = replay([
    INIT,
    step({
      step_index: 4,
      state: "ERROR",
      step_type: "tool",
      tool_name: "run_command",
      tool_info: { error: { message: "permission check failed for command: user denied permission to run command" } }
    })
  ]);
  const [blocked] = of("blocked");
  assert.equal(blocked[1].escalate, undefined);
});

await test("a real tool failure stays a tool error", () => {
  const { of } = replay([
    INIT,
    step({
      step_index: 5,
      state: "ERROR",
      step_type: "tool",
      tool_name: "write_to_file",
      tool_info: { error: { type: "TOOL_ERROR", message: "invalid_args: not a valid artifact path" } }
    })
  ]);
  assert.equal(of("blocked").length, 0);
  assert.equal(of("tool_result")[0][1].status, "error");
});

await test("counts usage once per turn — result.usage is cumulative, not a delta", () => {
  const { adapter, of } = replay([
    INIT,
    step({ step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 13001, output_tokens: 2, thinking_tokens: 0 } }),
    JSON.stringify({
      event: "result",
      result: { conversation_id: "conv-1", status: "SUCCESS", response: "PONG\n", usage: { input_tokens: 13001, output_tokens: 2, thinking_tokens: 0 } }
    })
  ]);
  assert.equal(adapter.stats.outputTokens, 2);
  assert.equal(of("stats").at(-1)[1].stats.totalTurns, 1);
});

await test("totalTurns counts turns, not steps — a tool-using turn is still one", () => {
  const { adapter } = replay([
    INIT,
    step({ step_index: 1, state: "DONE", step_type: "agent_response", usage: { output_tokens: 10 } }),
    step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "list_dir", tool_info: {} }),
    step({ step_index: 3, state: "DONE", step_type: "agent_response", usage: { output_tokens: 20 } }),
    step({ step_index: 4, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: {} }),
    step({ step_index: 5, state: "DONE", step_type: "agent_response", usage: { output_tokens: 30 } }),
    JSON.stringify({ event: "result", result: { status: "SUCCESS" } })
  ]);
  assert.equal(adapter.stats.totalTurns, 1);
  assert.equal(adapter.stats.outputTokens, 60);
});

await test("a non-SUCCESS result surfaces as an error", () => {
  const { of } = replay([INIT, JSON.stringify({ event: "result", result: { status: "ERROR", error: "quota exhausted" } })]);
  assert.equal(of("error")[0][1].message, "quota exhausted");
});

await test("a landed write_to_file draws a diff card when the args are whole, under the CLI's own names", () => {
  // Arg names read off a real transcript: TargetFile / CodeContent. The live stream
  // strips the content (verified on 1.2.2), so it is the replay door that feeds this.
  const { of } = replay([
    step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "/tmp/a.js", CodeContent: "hello" } } })
  ]);
  const [diff] = of("diff");
  assert.deepEqual(diff[1], { file: "/tmp/a.js", name: "write_to_file", patch: "", content: "hello" });
});

await test("the live stream's stripped args draw NO diff — an empty card must not hide the tool row", () => {
  // Recorded from a real turn: live write_to_file carries TargetFile alone, on both
  // ACTIVE and DONE. The tool row stays; a reopen swaps in the diff card.
  const { of } = replay([
    step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "/tmp/a.js" } } }),
    step({ step_index: 2, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { parameters: { TargetFile: "/tmp/a.js" } } })
  ]);
  assert.equal(of("tool_result").length, 1);
  assert.equal(of("diff").length, 0);
});

await test("a landed replace_file_content draws its -/+ lines, and a denied one does not", () => {
  const { of } = replay([
    step({ step_index: 3, state: "DONE", step_type: "tool", tool_name: "replace_file_content", tool_info: { parameters: { TargetFile: "/tmp/a.js", TargetContent: "old\n", ReplacementContent: "new" } } }),
    step({ step_index: 4, state: "ERROR", step_type: "tool", tool_name: "replace_file_content", tool_info: { parameters: { TargetFile: "/tmp/b.js", TargetContent: "x", ReplacementContent: "y" }, error: { message: "user denied permission" } } })
  ]);
  const [diff] = of("diff");
  assert.equal(diff[1].file, "/tmp/a.js");
  assert.equal(diff[1].patch, "-old\n+new"); // the trailing \n must not become an empty line
  assert.equal(of("diff").length, 1); // the denied edit stays a tool row
});

await test("forwards thinking events from agent_response and thinking steps", () => {
  const { of } = replay([
    INIT,
    step({ step_index: 1, state: "ACTIVE", step_type: "agent_response", thinking_delta: "Thinking about the sky..." }),
    step({ step_index: 2, state: "ACTIVE", step_type: "thinking", text: "Refining Rayleigh scattering details." })
  ]);
  const thinkings = of("thinking").map(([, d]) => d.text);
  assert.deepEqual(thinkings, ["Thinking about the sky...", "Refining Rayleigh scattering details."]);
});

await test("a landed multi_replace_file_content draws a diff card", () => {
  const { of } = replay([
    step({
      step_index: 5,
      state: "DONE",
      step_type: "tool",
      tool_name: "multi_replace_file_content",
      tool_info: {
        parameters: {
          TargetFile: "/tmp/multi.js",
          replacements: [
            { target: "foo", replacement: "bar" },
            { target: "baz", replacement: "qux" }
          ]
        }
      }
    })
  ]);
  const [diff] = of("diff");
  assert.ok(diff, "diff card must be emitted for multi_replace_file_content");
  assert.equal(diff[1].file, "/tmp/multi.js");
  assert.ok(diff[1].patch.includes("-foo\n+bar"));
  assert.ok(diff[1].patch.includes("-baz\n+qux"));
});

await test("ask_question args reshape to the question card's contract, from an array or a JSON string", () => {
  // Arg shapes read off real transcripts: `questions` holds {question, options:[string],
  // is_multi_select}, and sometimes arrives JSON-encoded as a single string.
  const arrayArgs = { questions: [{ is_multi_select: false, options: ["Web app", "CLI tool"], question: "Làm gì?" }] };
  const [start] = replay([
    step({ step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "ask_question", tool_info: { parameters: arrayArgs } })
  ]).of("tool_start");
  assert.deepEqual(start[1].input, {
    questions: [{ question: "Làm gì?", options: [{ label: "Web app", description: "" }, { label: "CLI tool", description: "" }], multiSelect: false }]
  });

  const [strStart] = replay([
    step({ step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "ask_question", tool_info: { parameters: { questions: JSON.stringify(arrayArgs.questions) } } })
  ]).of("tool_start");
  assert.deepEqual(strStart[1].input, start[1].input);

  // Unparsable args fall back to the raw input — the generic row, not a broken card.
  const [rawStart] = replay([
    step({ step_index: 4, state: "ACTIVE", step_type: "tool", tool_name: "ask_question", tool_info: { parameters: { questions: "not json" } } })
  ]).of("tool_start");
  assert.deepEqual(rawStart[1].input, { questions: "not json" });
});

await test("an invoke_subagent tool step names the launching sub-agent", () => {
  // Real transcript args: Subagents entries carry Role/TypeName/Prompt in PascalCase.
  const { of } = replay([
    step({
      step_index: 1,
      state: "ACTIVE",
      step_type: "tool",
      tool_name: "invoke_subagent",
      tool_info: { parameters: { Subagents: [{ Model: "inherit", Prompt: "Run ls -la", Role: "Command Runner", TypeName: "self" }] } }
    })
  ]);
  const [start] = of("tool_start");
  assert.equal(start[1].input.subagent_type, "Command Runner");
  assert.equal(start[1].input.prompt, "Run ls -la");
});

await test("a subagent step reads its info under both casings", () => {
  const { of } = replay([
    step({
      step_index: 2,
      state: "ACTIVE",
      step_type: "subagent",
      tool_name: "invoke_subagent",
      subagent_info: { subagents: [{ Role: "Watcher", Prompt: "Watch the logs", TypeName: "self" }] }
    })
  ]);
  const [start] = of("tool_start");
  assert.equal(start[1].input.subagent_type, "Watcher");
  assert.equal(start[1].input.prompt, "Watch the logs");
});

await test("a persistent run_command settles as an async row, not a finished one", () => {
  // RunPersistent hands the command off at DONE — claude's async shape keeps it on the
  // SHELLS strip until the session watchdog settles it.
  const { of } = replay([
    step({ step_index: 6, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "server", RunPersistent: true } } }),
    step({ step_index: 6, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "server", RunPersistent: true }, output: "detached" } })
  ]);
  const [result] = of("tool_result");
  assert.equal(result[1].status, "running");
  assert.equal(result[1].async, true);
  assert.equal(result[1].handle, result[1].id);

  // The live stream may strip params off DONE — the flag remembered at ACTIVE still counts.
  const [stripped] = replay([
    step({ step_index: 7, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "watch", RunPersistent: true } } }),
    step({ step_index: 7, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { output: "detached" } })
  ]).of("tool_result");
  assert.equal(stripped[1].status, "running");
});

await test("the transcript door surfaces an ask_question the live stream black-boxed as an unknown step", async () => {
  // Recorded from a real turn: agy emits ask_question ONLY as an empty step_type
  // "unknown"; the args and result live in the CLI's transcript (questions arrives as a
  // JSON-encoded string, other values JSON-quoted).
  const fsMod = await import("node:fs");
  const osMod = await import("node:os");
  const pathMod = await import("node:path");
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "9remote-agy-door-"));
  process.env.ANTIGRAVITY_HOME = root;
  const convId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const logsDir = pathMod.join(root, "brain", convId, ".system_generated", "logs");
  fsMod.mkdirSync(logsDir, { recursive: true });
  fsMod.writeFileSync(pathMod.join(logsDir, "transcript.jsonl"), [
    { step_index: 0, type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>\nask a question\n</USER_REQUEST>" },
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", tool_calls: [{ name: "ask_question", args: { questions: JSON.stringify([{ is_multi_select: false, options: ["Red", "Green", "Blue"], question: "What color?" }]), toolAction: "\"Asking color\"" } }] },
    { step_index: 2, type: "GENERIC", status: "DONE", content: "Created At: now\nA1: User Skipped" },
    { step_index: 3, type: "PLANNER_RESPONSE", status: "DONE", content: "The tool returned: skipped." }
  ].map((r) => JSON.stringify(r)).join("\n"));

  const init = JSON.stringify({ event: "init", conversation_id: convId, init: {} });
  const unknown = step({ step_index: 2, state: "DONE", step_type: "unknown" });
  const { of } = replay([init, unknown, unknown]);
  const [qStart] = of("tool_start");
  assert.equal(qStart[1].name, "ask_question");
  assert.deepEqual(qStart[1].input.questions, [
    { question: "What color?", options: [{ label: "Red", description: "" }, { label: "Green", description: "" }, { label: "Blue", description: "" }], multiSelect: false }
  ]);
  const [qResult] = of("tool_result");
  assert.equal(qResult[1].id, qStart[1].id);
  assert.match(qResult[1].output, /User Skipped/);
  // Idempotent: the second unknown step emitted nothing new.
  assert.equal(of("tool_start").length, 1);
  assert.equal(of("tool_result").length, 1);

  // A call the live stream DID show is not re-emitted by the door.
  const { of: of2 } = replay([
    init,
    step({ step_index: 4, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { parameters: { CommandLine: "ls" } } }),
    unknown
  ]);
  assert.equal(of2("tool_start").filter(([, d]) => d.name === "run_command").length, 1);
  assert.equal(of2("tool_start").filter(([, d]) => d.name === "ask_question").length, 1);

  fsMod.rmSync(root, { recursive: true, force: true });
  delete process.env.ANTIGRAVITY_HOME;
});

await test("the headless rule installs into agy's global GEMINI.md, idempotently", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const mod = await import("../features/ai/adapters/antigravityAdapter.js");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "9remote-agy-rule-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // An empty config: the rule creates the file with only its own block.
    mod.ensureHeadlessRule();
    const file = path.join(home, ".gemini", "config", "GEMINI.md");
    let text = fs.readFileSync(file, "utf8");
    assert.match(text, /<!-- 9remote:headless -->/);
    assert.match(text, /ask_question tool cannot be answered/);
    assert.ok(!text.includes("system-note")); // the prompt hack is gone for good

    // A user's own content survives untouched, and re-running changes nothing.
    fs.writeFileSync(file, "My own rule.\n" + text);
    mod.ensureHeadlessRule();
    assert.ok(fs.readFileSync(file, "utf8").startsWith("My own rule.\n"));
    assert.equal(fs.readFileSync(file, "utf8").split("<!-- 9remote:headless -->").length, 2);
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await test("sendPrompt carries no note — the conversation title builds from the user's words", async () => {
  const calls = [];
  const stub = { start: ({ args }) => { calls.push(args); return Promise.resolve(null); } };
  const a = new AntigravityAdapter({ cwd: "/tmp", onEvent: () => {}, proc: stub });
  const home = (await import("node:fs")).mkdtempSync("/tmp/9remote-agy-rule2-");
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    a.sendPrompt("hello world", null);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(calls[0].at(-1), "-p=hello world");
    assert.ok(!calls[0].at(-1).includes("system-note"));
  } finally {
    process.env.HOME = realHome;
  }
});

console.log(`=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
