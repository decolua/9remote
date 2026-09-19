// The pure mapper that turns the agent's MCP manifest into Gemini Live
// functionDeclarations. The schemas must survive with upper-case type strings
// and everything else intact — the manifest is the single source, this only
// re-cases it.
//
// Run: node --import ./test/loader-alias.mjs test/jarvisLive.test.mjs
import assert from "node:assert/strict";
import { liveToolDeclarations, JARVIS_LIVE_MODEL, JARVIS_LIVE_SYSTEM_PROMPT } from "@/shared/lib/jarvisConstants";
import { createSpeechGate } from "@/features/jarvis/hooks/useJarvisLiveVoice";

let pass = 0, fail = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

console.log("Running jarvis live voice tests...");

test("maps the manifest with upper-cased schema types, keeping required and enums", () => {
  const [decl] = liveToolDeclarations([{
    name: "dispatch_prompt",
    description: "Giao việc",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "worker" },
        prompt: { type: "string" }
      },
      required: ["sessionId", "prompt"]
    }
  }]);
  assert.equal(decl.name, "dispatch_prompt");
  assert.equal(decl.parameters.type, "OBJECT");
  assert.equal(decl.parameters.properties.sessionId.type, "STRING");
  assert.deepEqual(decl.parameters.required, ["sessionId", "prompt"]);
});

test("nested arrays and enum values pass through untouched", () => {
  const [decl] = liveToolDeclarations([{
    name: "create_session",
    description: "Mở session",
    inputSchema: {
      type: "object",
      properties: {
        engine: { type: "string", enum: ["claude", "codex"] },
        yolo: { type: "boolean" }
      },
      required: ["engine"]
    }
  }]);
  assert.deepEqual(decl.parameters.properties.engine.enum, ["claude", "codex"]);
  assert.equal(decl.parameters.properties.yolo.type, "BOOLEAN");
});

test("incomplete tools are skipped; a tool without a schema gets no parameters", () => {
  const decls = liveToolDeclarations([
    { description: "no name" },
    { name: "no_description" },
    { name: "bare", description: "no schema" }
  ]);
  assert.equal(decls.length, 1);
  assert.equal(decls[0].name, "bare");
  assert.equal(decls[0].parameters, undefined);
});

test("the live constants carry the model id and the conductor prompt", () => {
  assert.equal(typeof JARVIS_LIVE_MODEL, "string");
  assert.match(JARVIS_LIVE_MODEL, /^gemini-/);
  assert.match(JARVIS_LIVE_SYSTEM_PROMPT, /list_fleet/);
  assert.match(JARVIS_LIVE_SYSTEM_PROMPT, /user's language/);
});

test("the speech gate sends nothing while the user is silently idle", () => {
  const sent = [];
  let t = 0;
  const gate = createSpeechGate({ sendChunk: (c) => sent.push(["chunk", c]), sendStreamEnd: () => sent.push(["end"]), now: () => t });
  for (let i = 0; i < 20; i++) { t += 100; gate.onChunk(`silence-${i}`, 0.001); }
  assert.equal(sent.length, 0, "idle silence costs nothing");
});

test("speech flushes the pre-roll, hangover feeds the VAD, then the stream pauses", () => {
  const sent = [];
  let t = 0;
  const gate = createSpeechGate({ sendChunk: (c) => sent.push(["chunk", c]), sendStreamEnd: () => sent.push(["end"]), now: () => t });

  // 5 silent chunks build the pre-roll unheard…
  for (let i = 0; i < 5; i++) { t += 70; gate.onChunk(`pre-${i}`, 0.001); }
  assert.equal(sent.length, 0);
  // …then speech: pre-roll flushes first, the speaking chunk rides behind it.
  t += 70;
  gate.onChunk("speech", 0.2);
  assert.deepEqual(sent.map(([k, c]) => c), ["pre-0", "pre-1", "pre-2", "pre-3", "pre-4", "speech"]);

  // Short pause (<500ms): hangover audio keeps flowing, no finalize yet.
  t += 300;
  gate.onChunk("hangover-1", 0.001);
  assert.ok(sent.some(([k, c]) => c === "hangover-1"), "hangover chunk sent");

  // 500ms quiet: exactly one audioStreamEnd, chunks still flow until 1s.
  t += 250;
  gate.onChunk("quiet-550", 0.001);
  assert.equal(sent.filter(([k]) => k === "end").length, 1, "finalized once");
  assert.ok(sent.some(([, c]) => c === "quiet-550"), "still streaming under the pause threshold");

  // Past 1s of quiet: the stream stops — nothing more leaves.
  const countAtPause = sent.length;
  t += 600;
  gate.onChunk("after-pause", 0.001);
  assert.equal(sent.length, countAtPause, "silence past 1s is not sent");

  // Speech again: the pre-roll (which includes the quiet tail) flushes, sending resumes.
  t += 70;
  gate.onChunk("speech-2", 0.2);
  const tail = sent.slice(countAtPause).map(([, c]) => c);
  assert.equal(tail[tail.length - 1], "speech-2");
  assert.ok(tail.length >= 2, "the new onset carried its pre-roll");
});

for (const { name, fn } of cases) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.error(`  ✗ ${name}\n    ${e.message}`); }
}
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
