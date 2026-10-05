// The single door into browserUse. Socket (web) and the local API (CLI) both
// call invoke(action, payload) — one decision gate, one config source.
// Task runs broadcast each step so any open view follows along.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../../lib/logger.js";
import { getIO } from "../../transport/server.js";
import { broadcast } from "../../transport/broadcast.js";
import { kvGet, kvSet } from "../terminal/ptyDaemonClient.js";
import { testConfig } from "./jevClient.js";
import { DEFAULT_POLICY, checkExpectations, scopeByParent } from "./agentLoop.js";
export { checkExpectations };
import {
  attachStatus, closeProfile, listTabs, openAttachGuide, readStepFrame, framePathFor,
  requestCancel, runTask, sessionStatus, shoot, withSession, clickById, typeById, pressEnter,
  switchTab, closeTab
} from "./engine.js";
import { ensureExtensionInstall, extStatus } from "./extRelay.js";
import { AUTO_CONTINUE_CHUNKS, CONSOLE_FAIL_TAIL, JEV_CONFIG_DEFAULTS, KEEP_REPORTS, KV_KEY, MAX_MS_DEFAULT, MAX_MS_HARD, MAX_STEPS_DEFAULT, MAX_STEPS_HARD } from "./constants.js";
import { installSkillForEngine, removeAllInstalledSkills, SKILL_ENGINES } from "./skill.js";
import { globalAiManager } from "../ai/aiManager.js";
import { getLiveConversations } from "../terminal/statusManager.js";
import { engineFromAgent } from "../terminal/conversationModes.js";

const logger = createLogger("browserUse");

// ---- config: one in-memory object, KV write-through (voice/jarvis pattern) ---
let config = { ...JEV_CONFIG_DEFAULTS };
let configLoaded = false;

export async function loadConfig() {
  if (configLoaded) return config;
  configLoaded = true;
  try {
    const saved = await kvGet(KV_KEY);
    if (saved && typeof saved === "object") {
      const merged = { ...JEV_CONFIG_DEFAULTS, ...saved };
      // Drop keys removed from newer versions (e.g. the old allowlist) so they
      // never resurface in responses or get re-persisted.
      config = Object.fromEntries(Object.entries(merged).filter(([k]) => k in JEV_CONFIG_DEFAULTS));
    }
  } catch { /* daemon down: defaults hold */ }
  return config;
}

export function setConfig(patch = {}) {
  const wasEnabled = !!config.enabled;
  const next = { ...config };
  for (const key of ["enabled", "preset", "endpoint", "model", "apiKey", "headless"]) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.mode === "own" || patch.mode === "attach" || patch.mode === "extension") next.mode = patch.mode;
  if (typeof patch.minConfidence === "number") {
    next.minConfidence = Math.min(1, Math.max(0, patch.minConfidence));
  }
  config = next;
  void kvSet(KV_KEY, config).catch((e) => logger.error(`config persist failed: ${e.message}`));
  // The skill follows the switch: on = engines in use, off = removed everywhere.
  if (!!config.enabled !== wasEnabled) {
    if (config.enabled) void syncSkillForActiveEngines().catch((e) => logger.debug(`skill sync skipped: ${e.message}`));
    else removeAllInstalledSkills();
  }
  return { ok: true, config: publicConfig() };
}

// Engines with a live foot on this host: open AI chats plus terminals running
// an agent CLI. Nothing else gets the skill — that is the point.
function activeEngines() {
  const set = new Set(globalAiManager.listSessions().map((s) => s.engine));
  for (const conv of getLiveConversations()) {
    if (conv.agent) set.add(engineFromAgent(conv.agent) || conv.agent);
  }
  return [...set].filter((e) => SKILL_ENGINES.includes(e));
}

// Just-in-time gate: session creation funnels here via skill.js's
// queueSkillInstall (dynamic import — this file statically imports skill.js).
export async function installSkillIfEnabled(engine) {
  if (!SKILL_ENGINES.includes(engine)) return;
  await loadConfig();
  if (config.enabled) await installSkillForEngine(engine);
}

// Reconcile on connect and on toggle-on: install only for engines in use.
export async function syncSkillForActiveEngines() {
  await loadConfig();
  if (!config.enabled) return;
  for (const engine of activeEngines()) await installSkillForEngine(engine);
}

const publicConfig = () => ({ ...config, apiKey: config.apiKey ? "__SET__" : "" });

function requireRunConfig() {
  if (!config.enabled) throw new Error("browserUse is disabled — enable it in settings");
}

function policyFromConfig() {
  return { ...DEFAULT_POLICY, minConfidence: config.minConfidence };
}

// ---- reports -----------------------------------------------------------------
function reportsRoot() {
  return path.join(os.homedir(), ".9remote", "browserUse");
}

function pruneReports() {
  try {
    const entries = fs.readdirSync(reportsRoot()).filter((d) => d.startsWith("t-")).sort();
    for (const old of entries.slice(0, Math.max(0, entries.length - KEEP_REPORTS))) {
      fs.rmSync(path.join(reportsRoot(), old), { recursive: true, force: true });
    }
  } catch { /* nothing to prune yet */ }
}

async function writeReport(taskId, { goal, result, image }) {
  const dir = path.join(reportsRoot(), taskId);
  fs.mkdirSync(dir, { recursive: true });
  const report = {
    taskId, goal, ts: Date.now(),
    outcome: result.outcome, reason: result.reason, url: result.url,
    steps: result.steps, metrics: result.metrics
  };
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 2));
  if (image) fs.writeFileSync(path.join(dir, "final.jpg"), Buffer.from(image, "base64"));
  pruneReports();
  return { dir, report };
}

const pushOutcome = (goal, result) => {
  // pushManager's channel is AI-tool-shaped (tool/type/sessionId) and would render
  // a misleading "AI needs your input" — a browserUse-shaped notification belongs
  // to a pushManager extension, not a forced reuse. Report + log only for now.
  logger.info(`task done: ${goal.slice(0, 60)} -> ${result.outcome}`);
};

// ---- one action table ----------------------------------------------------------
const emitStep = (step) => {
  const io = getIO();
  if (io) broadcast(io, "browserUse:step", step);
  logger.info(`#${step.seq} ${step.operation} ${step.targetIndex ? `[${step.targetIndex}]` : ""} ` +
    `"${String(step.label || "").slice(0, 50)}" · ${step.result} · ${step.latencyMs}ms`);
};

// Optional completion gate for action commands: --wait "<text>" holds the SAME
// call until the page visibly shows the evidence (bounded), so the agent learns
// action + outcome + table in one round trip.
const waitGate = async (payload) => {
  if (!payload.wait) return {};
  const { found } = await withSession(sessionOpts(payload), (session) =>
    session.waitText(String(payload.wait), Number(payload.timeoutMs) || 5000));
  return { found };
};

export async function invoke(action, payload = {}) {
  await loadConfig();
  switch (action) {
    case "config.get":
      return { ok: true, config: publicConfig() };
    case "config.set":
      return setConfig(payload);
    case "test":
      await loadConfig();
      return { ok: true, ...(await testConfig({ ...config, ...pickOverrides(payload) })) };
    case "status":
      return { ok: true, config: publicConfig(), sessions: sessionStatus() };
    case "attach.status":
      return { ok: true, ...(await attachStatus()) };
    case "attach.open":
      return { ok: true, ...openAttachGuide() };
    case "ext.status":
      return { ok: true, ...extStatus() };
    case "ext.install":
      return { ok: true, ...ensureExtensionInstall() };
    case "tabs": {
      const opts = sessionOpts(payload);
      return { ok: true, tabs: await listTabs(opts) };
    }
    case "open":
      // Returns the element table too — kills the open→state double round trip.
      return { ok: true, ...(await waitGate(payload)), state: await withSession({
        ...sessionOpts(payload), url: required(payload, "url")
      }, async (session) => session.steady()) };
    case "state":
      return { ok: true, ...(await withSession(sessionOpts(payload), (session) => session.current())) };
    case "console":
      // Console ring — read-only, no session side effects (same shape as state)
      return { ok: true, lines: await withSession(sessionOpts(payload), (session) => session.consoleLog) };
    case "read": {
      // Markdown-lite read; --parent scopes to a tree section, --from/--len
      // window past the cap, --grep filters lines host-side.
      const parent = typeof payload.parent === "string" && payload.parent.trim() ? payload.parent : null;
      const from = Number.isFinite(+payload.from) && +payload.from > 0 ? Math.floor(+payload.from) : 0;
      const len = Number.isFinite(+payload.len) && +payload.len > 0 ? Math.floor(+payload.len) : null;
      const read = await withSession(sessionOpts(payload), (session) => session.readSection(parent, from, len));
      if (typeof payload.grep === "string" && payload.grep.trim()) {
        let re;
        try { re = new RegExp(payload.grep, "i"); }
        catch { throw new Error(`Invalid --grep pattern: ${payload.grep}`); }
        read.text = read.text.split("\n").filter((line) => re.test(line)).join("\n");
      }
      return { ok: true, from, ...read };
    }
    case "run": {
      requireRunConfig();
      const taskId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const goal = required(payload, "goal");
      const fragments = (Array.isArray(payload.expectText) ? payload.expectText : [payload.expectText])
        .filter((t) => typeof t === "string" && t.trim());
      const expect = (payload.expectUrl || payload.expectTitle || fragments.length)
        ? { url: payload.expectUrl || null, title: payload.expectTitle || null, text: fragments }
        : null;
      const runOpts = { ...sessionOpts(payload), url: payload.url };
      // Chrome launch is dead time for the Jev connection — warm it in parallel
      // so the first decision skips TLS setup (only when a launch is imminent).
      if (!sessionStatus().some((s) => s.profile === runOpts.profile)) {
        testConfig(config).catch(() => {});
      }
      const { result, verification } = await withSession(runOpts, (session) => {
        // A site asking for input via window.prompt() has no DOM field Jev could
        // fill — arm the first answer so the loop is not answered with "".
        session.pendingPromptText = typeof payload.promptText === "string" ? payload.promptText : null;
        return runAutoContinue(session, {
        goal, expect,
        fields: sanitizeFields(payload.fields),
        maxSteps: clampSteps(payload.maxSteps),
        maxMs: clampMs(payload.maxMs),
        resume: payload.resume || null,
        only: payload.only || null,
        parent: payload.parent || null,
        onStep: emitStep
        });
      });
      // The report reuses the loop's own last step frame — no extra capture.
      const image = result.metrics.steps ? readStepFrame(runOpts) : null;
      // A failed run explains itself in-response (same rationale as the chain tail).
      const consoleTail = (result.outcome === "action_error" || result.outcome === "no_progress")
        ? await consoleAfter(payload) : null;
      // A report failure must not swallow the run result — the agent would
      // retry the whole Jev loop and re-run every action.
      let report = null;
      try { report = (await writeReport(taskId, { goal, result, image })).report; }
      catch (e) { logger.error(`report write failed: ${e.message}`); }
      pushOutcome(goal, result);
      logger.info(`run ${taskId}: ${result.outcome}${verification ? ` · verify ${verification.passed ? "PASSED" : "FAILED"}` : ""} (${result.metrics.steps} steps)`);
      // The run's own last-step frame rides along — the agent reads this file
      // instead of shooting a fresh, possibly-moved screenshot.
      return { ok: true, taskId, ...result, report, verification,
        frame: framePathFor(runOpts), ...(consoleTail ? { console: consoleTail } : {}),
        state: await stateAfter(payload) };
    }
    case "click": {
      const opts = sessionOpts(payload);
      return { ok: true, ...(await clickById(opts.profile, required(payload, "id"),
        { promptText: typeof payload.promptText === "string" ? payload.promptText : null })),
        ...(await waitGate(payload)), state: await stateAfter(payload) };
    }
    case "clickxy": {
      const opts = sessionOpts(payload);
      await withSession(opts, (session) =>
        session.clickPoint(Number(required(payload, "x")), Number(required(payload, "y"))));
      return { ok: true, state: await stateAfter(payload) };
    }
    case "scroll": {
      const opts = sessionOpts(payload);
      const action = payload.edge
        ? (session2) => session2.scrollToEdge(payload.edge)
        : (session2) => session2.scrollBy(Number(payload.px));
      await withSession(opts, action);
      return { ok: true, state: await stateAfter(payload) };
    }
    case "back":
    case "forward": {
      const opts = sessionOpts(payload);
      await withSession(opts, (session) => session.historyGo(action === "back" ? -1 : 1));
      return { ok: true, state: await stateAfter(payload) };
    }
    case "reload": {
      const opts = sessionOpts(payload);
      await withSession(opts, (session) => session.reload());
      return { ok: true, state: await stateAfter(payload) };
    }
    case "key": {
      const opts = sessionOpts(payload);
      await withSession(opts, (session) => session.sendKey(required(payload, "name")));
      return { ok: true, state: await stateAfter(payload) };
    }
    case "hover": {
      const opts = sessionOpts(payload);
      await withSession(opts, (session) => session.hoverById(required(payload, "id")));
      return { ok: true, state: await stateAfter(payload) };
    }
    case "wait": {
      const opts = sessionOpts(payload);
      const { found, state } = await withSession(opts, (session) =>
        session.waitText(required(payload, "text"), Number(payload.timeoutMs) || undefined));
      return { ok: true, found, state };
    }
    case "tab": {
      return { ok: true, ...(await switchTab(sessionOpts(payload), Number(required(payload, "index")))),
        state: await stateAfter(payload) };
    }
    case "tabclose": {
      return { ok: true, ...(await closeTab(sessionOpts(payload), payload.index ? Number(payload.index) : null)) };
    }
    case "type": {
      const opts = sessionOpts(payload);
      const result = await withSession(opts, async (session) => {
        let state = await session.current();
        let action = state.actions.find((a) => a.id === required(payload, "id") && a.kind === "fill");
        if (!action) { // table shifted since the caller's observe — one retry
          state = await session.observe();
          action = state.actions.find((a) => a.id === required(payload, "id") && a.kind === "fill");
        }
        if (!action) throw new Error(`Field ${required(payload, "id")} not observed (or not editable)`);
        await session.act(action, required(payload, "text"));
        if (payload.enter) await session.pressEnter();
        return { typed: payload.text };
      });
      return { ok: true, ...result, ...(await waitGate(payload)), state: await stateAfter(payload) };
    }
    case "upload": {
      const opts = sessionOpts(payload);
      const file = required(payload, "file");
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
      const result = await withSession(opts, async (session) => {
        let state = await session.current();
        let action = state.actions.find((a) => a.id === required(payload, "id") && a.kind === "upload");
        if (!action) { // table shifted since the caller's observe — one retry
          state = await session.observe();
          action = state.actions.find((a) => a.id === required(payload, "id") && a.kind === "upload");
        }
        if (!action) throw new Error(`${required(payload, "id")} is not an observed file input`);
        return await session.uploadFile(action, file);
      });
      return { ok: true, ...result, state: await stateAfter(payload) };
    }
    case "download": {
      const opts = sessionOpts(payload);
      const result = await withSession(opts, async (session) =>
        await session.waitDownload(Number(payload.timeout) || 15000));
      if (!result) throw new Error("No download completed within the timeout");
      return { ok: true, download: result };
    }
    case "drag": {
      const opts = sessionOpts(payload);
      const result = await withSession(opts, async (session) => {
        const grab = async (key) => {
          const id = required(payload, key);
          let state = await session.current();
          let action = state.actions.find((a) => a.id === id);
          if (!action) { // table shifted since the caller's observe — one retry
            state = await session.observe();
            action = state.actions.find((a) => a.id === id);
          }
          if (!action) throw new Error(`Element ${id} not observed`);
          return action;
        };
        const from = await grab("from");
        const to = await grab("to");
        return await session.dragTo(from, to);
      });
      return { ok: true, ...result };
    }
    case "enter": {
      const opts = sessionOpts(payload);
      return { ok: true, ...(await pressEnter(opts.profile)),
        state: await stateAfter(payload) };
    }
    case "shot": {
      const opts = sessionOpts(payload);
      return { ok: true, ...(await shoot(opts.profile)) };
    }
    case "run.cancel": {
      const opts = sessionOpts(payload);
      return { ok: true, ...requestCancel(opts.profile) };
    }
    case "chain":
      return await runChain(sessionOpts(payload), payload.steps, payload.parent || null);
    case "close": {
      const opts = sessionOpts(payload);
      return { ok: true, ...(await closeProfile(opts.profile)) };
    }
    default:
      throw new Error(`Unknown browserUse action: ${action}`);
  }
}

// Run with declared end conditions: a FAILED verification means the goal is not
// reached yet — resume the SAME session up to AUTO_CONTINUE_CHUNKS extra chunks.
// Expectations never enter the Jev prompt; they only judge, so this cannot be gamed.
export async function runAutoContinue(session, {
  goal, decide = undefined, expect = null, config: cfg = config, policy = null,
  maxSteps = 12, maxMs = 45000, only = null, parent = null, resume = null, onStep = null, fields = null
} = {}) {
  const runOpts = () => ({
    goal, config: cfg, policy: policy || policyFromConfig(),
    maxSteps, maxMs, only, parent, onStep, fields, expect,
    ...(decide ? { decide } : {})
  });
  let combined = await runTask(session, { ...runOpts(), resume });
  let verification = null;
  for (let chunk = 0; expect && chunk < AUTO_CONTINUE_CHUNKS; chunk++) {
    try { verification = checkExpectations(await session.observe(), expect); }
    catch (e) { verification = { passed: false, checks: {}, error: e.message }; }
    if (verification.passed || combined.outcome === "cancelled") break;
    if (session.cancelRequested) {
      session.cancelRequested = false; // consume-once, before the next chunk resets it
      combined = { ...combined, outcome: "cancelled", reason: "user cancelled" };
      break;
    }
    const next = await runTask(session, {
      ...runOpts(),
      resume: { history: combined.history, steps: combined.steps, metrics: combined.metrics }
    });
    combined = { ...next, steps: [...combined.steps, ...next.steps] };
  }
  if (expect && !verification) {
    try { verification = checkExpectations(await session.observe(), expect); }
    catch (e) { verification = { passed: false, checks: {}, error: e.message }; }
  }
  return { result: combined, verification };
}

// Post-action state for the response — cached when the page did not change.
// Single-shot observe only: a page navigating away must not burn settle retries
// here. Never let a failed observation swallow the action result either — the
// action already ran, and reporting it as an error would make the agent retry.
const stateAfter = async (payload) => {
  try {
    return await withSession(sessionOpts(payload), async (s) => {
      if (s.lastState && await s.fresh(s.lastState)) return s.lastState;
      try { return await s.observe(); } catch { return null; } // mid-navigation — no retries
    });
  } catch { return null; }
};

// Console tail for a failed run — same session, read-only slice.
const consoleAfter = async (payload) => {
  try { return await withSession(sessionOpts(payload), (s) => s.consoleLog.slice(-CONSOLE_FAIL_TAIL)); }
  catch { return null; }
};

// ---- chain: many steps in ONE call (openclaw batch pattern) -------------------
const CHAIN_OPS = new Set(["click", "select", "type", "enter", "scroll", "wait", "run", "open", "read"]);
const MAX_CHAIN_STEPS = 30;
const WAIT_TEXT_CAP_MS = 3000;

// Only a verified-claim outcome may continue a chain — every other outcome
// means the page is NOT what the LLM predicted, so the remaining guesses are void.
export function chainRunError(result) {
  if (result?.outcome === "needs_verification") return null;
  return new Error(`run ${result?.outcome || "unknown"}: ${result?.reason || "no reason"}`);
}

async function waitText(session, text) {
  const deadline = Date.now() + WAIT_TEXT_CAP_MS;
  while (Date.now() < deadline) {
    const state = await session.current();
    if (state.text?.includes(text)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function runChain(opts, steps, chainParent = null) {
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_CHAIN_STEPS) {
    throw new Error(`chain needs 1..${MAX_CHAIN_STEPS} steps`);
  }
  return withSession(opts, async (session) => {
    const results = [];
    let lastUrl = null;       // url the previous step ended on (null = first step)
    let idsUntrusted = false; // a navigation happened — bare id steps need a label guard
    const scopeOf = (step) => step.parent || chainParent || null;
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const parent = scopeOf(step);
      let summary = step.op;
      if (session.cancelRequested) {
        session.cancelRequested = false; // consume-once: the next chain starts clean
        results.push({ step: i + 1, op: step.op, ok: false, error: "cancelled" });
        return { ok: false, failedStep: i + 1, results, state: await stateAfterSafe(session) };
      }
      try {
        if (!CHAIN_OPS.has(step.op)) throw new Error(`Unknown chain op: ${step.op}`);
        if (step.op === "open") {
          if (!step.url) throw new Error("Missing field: url");
          const prevUrl = lastUrl;
          await session.openOrReuseTab(String(step.url));
          lastUrl = (await session.current()).url;
          idsUntrusted = prevUrl === null || prevUrl !== lastUrl;
          summary = `open ${String(step.url).slice(0, 40)}`;
        } else if (step.op === "read") {
          const read = await session.readSection(parent);
          results.push({ step: i + 1, op: step.op, ok: true,
            summary: `read ${read.text.length} chars`, text: read.text });
          continue;
        } else if (step.op === "run") {
          requireRunConfig(); // chain must not bypass the enabled gate
          if (!step.goal) throw new Error("Missing field: goal");
          if (lastUrl !== null && (await session.current()).url !== lastUrl) {
            throw new Error(`unexpected navigation to ${(await session.current()).url} — the page left ${lastUrl}; re-plan from the returned state`);
          }
          const fragments = (Array.isArray(step.expectText) ? step.expectText : [step.expectText])
            .filter((t) => typeof t === "string" && t.trim());
          const expect = (step.expectUrl || step.expectTitle || fragments.length)
            ? { url: step.expectUrl || null, title: step.expectTitle || null, text: fragments }
            : null;
          const result = await runTask(session, {
            goal: String(step.goal),
            config,
            policy: policyFromConfig(),
            only: step.only || null,
            parent,
            fields: sanitizeFields(step.fields),
            maxSteps: clampSteps(step.maxSteps),
            maxMs: clampMs(step.maxMs),
            expect,
            onStep: emitStep
          });
          const runError = chainRunError(result);
          if (runError) throw runError;
          if (expect) {
            const verification = checkExpectations(await session.observe(), expect);
            if (!verification.passed) {
              throw new Error(`expect not met after run: ${Object.entries(verification.checks)
                .filter(([, ok]) => !ok).map(([check]) => check).join(", ")}`);
            }
          }
          if (step.expectUrl) { // the run was declared to end elsewhere — adopt the new page
            lastUrl = (await session.current()).url;
            idsUntrusted = true;
          }
          summary = `run -> ${result.outcome}`;
        } else {
          const state = await session.current();
          if (lastUrl !== null && state.url !== lastUrl) {
            throw new Error(`unexpected navigation to ${state.url} — the page left ${lastUrl}; re-plan from the returned state`);
          }
          lastUrl = state.url;
          const pool = scopeByParent(state.actions, parent);
          // Fail-fast lookup: no first-match-wins. Ambiguity throws, a wrong
          // id under a label guard throws BEFORE the click, and bare ids are
          // refused outright once the page has navigated.
          const find = (target, expectedKind = null, guard = null) => {
            if (!target) throw new Error("Missing element target");
            if (guard == null && idsUntrusted && /^e\d+$/.test(String(target))) {
              throw new Error("page navigated — id steps need a label guard (click e4 'Label')");
            }
            const lower = String(target).toLowerCase();
            const kindPool = expectedKind ? pool.filter((a) => a.kind === expectedKind) : pool;
            const labelHit = (a) => a.label?.toLowerCase() === lower ||
              (a.kind === "select" && (a.value === target || a.label?.toLowerCase().endsWith(`→ ${lower}`) || a.label?.toLowerCase().endsWith(`-> ${lower}`)));
            let candidates = pool.filter((a) => a.id === target);
            if (!candidates.length) candidates = kindPool.filter(labelHit);
            if (!candidates.length) candidates = kindPool.filter((a) => a.label?.toLowerCase().includes(lower));
            if (candidates.length > 1) {
              throw new Error(`ambiguous "${target}"${parent ? ` in ${parent}` : ""}: ` +
                candidates.slice(0, 5).map((a) => `[${a.id}] "${a.label || a.kind}"`).join(", ") +
                (candidates.length > 5 ? ` …(+${candidates.length - 5})` : ""));
            }
            const action = candidates[0];
            if (!action) {
              const list = (kindPool.length ? kindPool : pool).slice(0, 5)
                .map((a) => `[${a.id}] "${a.label || a.kind}"`).join(", ");
              throw new Error(`Element "${target}" not observed${parent ? ` in ${parent}` : ""}` +
                `${list ? `. Available${parent ? ` (${parent})` : ""}: ${list}` : ""}`);
            }
            if (guard != null && String(action.label || "") !== String(guard)) {
              throw new Error(`label mismatch: ${action.id} is "${action.label}", expected "${guard}" — the page changed under this id`);
            }
            return action;
          };
          if (step.op === "click" || step.op === "select") {
            const action = find(step.id, step.op, step.label ?? null);
            await session.act(action);
            summary = `${step.op} ${action.id} (${String(action.label || "").slice(0, 40)})`;
          } else if (step.op === "type") {
            const action = find(step.id, "fill", step.label ?? null);
            if (action.kind !== "fill") throw new Error(`${step.id} is not an editable field`);
            await session.act(action, String(step.text ?? ""));
            if (step.enter) await session.pressEnter();
            summary = `type ${action.id}${step.enter ? " +enter" : ""}`;
          } else if (step.op === "enter") {
            await session.pressEnter();
          } else if (step.op === "scroll") {
            const id = step.direction === "up" ? "scroll_up" : "scroll_down";
            await session.act(find(id));
            summary = `scroll ${step.direction || "down"}`;
          } else if (step.op === "wait") {
            await session.settle();
            if (step.ms) await new Promise((r) => setTimeout(r, Math.min(5000, Number(step.ms) || 0)));
            if (step.text) {
              if (!(await waitText(session, String(step.text)))) throw new Error(`Timed out waiting for text: ${step.text}`);
              summary = `wait "${String(step.text).slice(0, 30)}"`;
            }
          }
        }
        results.push({ step: i + 1, op: step.op, ok: true, summary });
      } catch (e) {
        results.push({ step: i + 1, op: step.op, ok: false, error: e.message });
        // Fail fast: return where the chain broke plus the live page state,
        // cropped to the failing step's section so the LLM re-plans in place.
        let broken = null;
        try { broken = await session.current(); } catch { /* keep results anyway */ }
        if (broken && parent) broken = { ...broken, actions: scopeByParent(broken.actions, parent) };
        // Console tail rides along — a JS error usually IS why the step broke,
        // and the agent must not spend a round trip asking for it.
        return { ok: false, failedStep: i + 1, results, state: broken,
          console: session.consoleLog.slice(-CONSOLE_FAIL_TAIL) };
      }
    }
    let finalState = null;
    try { finalState = await session.current(); } catch { /* keep results anyway */ }
    return { ok: true, results, state: finalState };
  });
}

// In-chain state read that can never fail the chain result itself.
const stateAfterSafe = async (session) => {
  try { return await session.current(); } catch { return null; }
};

// One decision gate for session identity: every caller resolves mode/headless alike.
const MODES = ["own", "attach", "extension"];
const sessionOpts = (payload = {}) => {
  const mode = MODES.includes(payload.mode) ? payload.mode : config.mode;
  return {
    profile: mode === "attach" ? "__attach__" : mode === "extension" ? "__extension__" : (payload.profile || "default"),
    mode,
    headless: config.headless
  };
};

const required = (payload, key) => {
  const value = payload?.[key];
  if (value === undefined || value === null || value === "") throw new Error(`Missing field: ${key}`);
  return value;
};
const pickOverrides = ({ endpoint, model, apiKey }) => ({ ...(endpoint ? { endpoint } : {}), ...(model ? { model } : {}), ...(apiKey ? { apiKey } : {}) });
// Trust boundary for fields: plain object of non-empty label -> non-empty string.
const sanitizeFields = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim();
    if (key && typeof v === "string" && v.trim()) out[key] = v;
  }
  return Object.keys(out).length ? out : null;
};
const clampSteps = (n) => {
  const value = Number(n);
  return Math.min(MAX_STEPS_HARD, Math.max(1, Number.isFinite(value) && value > 0 ? value : MAX_STEPS_DEFAULT));
};
const clampMs = (n) => {
  const value = Number(n);
  return Math.min(MAX_MS_HARD, Math.max(1000, Number.isFinite(value) && value > 0 ? value : MAX_MS_DEFAULT));
};

// ---- socket + local API adapters ----------------------------------------------
export function setupBrowserUseHandlers(socket) {
  void syncSkillForActiveEngines().catch((e) => logger.debug(`skill sync skipped: ${e.message}`));
  socket.on("browserUse:invoke", async ({ action, payload } = {}, cb) => {
    try {
      cb?.({ ok: true, ...(await invoke(action, payload)) });
    } catch (e) {
      logger.error(`${action} failed: ${e.message}`);
      cb?.({ ok: false, error: e.message });
    }
  });
  socket.on("setBrowserUseConfig", async (data = {}) => {
    try { await loadConfig(); setConfig(data.browserUseConfig || data); }
    catch (e) { logger.error(`setBrowserUseConfig failed: ${e.message}`); }
  });
}

// Local API (CLI): POST /api/browser-use {action, payload}
export async function handleBrowserUsePost(req, res) {
  const { parseJsonBody, jsonOk, jsonErr } = await import("../../lib/router.js");
  const data = await parseJsonBody(req, res);
  if (!data) return;
  try {
    const result = await invoke(data.action, data.payload);
    jsonOk(res, result);
  } catch (e) {
    jsonErr(res, 400, e.message);
  }
}
