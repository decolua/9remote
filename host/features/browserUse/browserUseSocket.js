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
  switchTab, closeTab, matchActionId
} from "./engine.js";
import { ensureExtensionInstall, extStatus } from "./extRelay.js";
import { ALLOWED_MODES, AUTO_CONTINUE_CHUNKS, CONSOLE_FAIL_TAIL, ELEMENT_DEEP_CAP, JEV_CONFIG_DEFAULTS, KEEP_REPORTS, KV_KEY, MAX_MS_DEFAULT, MAX_MS_HARD, MAX_STEPS_DEFAULT, MAX_STEPS_HARD } from "./constants.js";
import { grepContent } from "./grep.js";
import { installSkillForEngine, removeAllInstalledSkills, SKILL_ENGINES } from "./skill.js";
import { renderTreeLines } from "./compress.js";
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
      // A parked mode (attach/extension) in old KV must not resurrect itself.
      if (!ALLOWED_MODES.includes(config.mode)) config.mode = "own";
    }
  } catch { /* daemon down: defaults hold */ }
  return config;
}

// Exported for tests: {persist:false, syncSkill:false} enables transiently
// without touching the daemon KV or agents' installed skills.
export function setConfig(patch = {}, { persist = true, syncSkill = true } = {}) {
  const wasEnabled = !!config.enabled;
  const next = { ...config };
  for (const key of ["enabled", "preset", "endpoint", "model", "apiKey", "headless"]) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (ALLOWED_MODES.includes(patch.mode)) next.mode = patch.mode;
  if (typeof patch.minConfidence === "number") {
    next.minConfidence = Math.min(1, Math.max(0, patch.minConfidence));
  }
  config = next;
  // Tests pass {persist:false, syncSkill:true→false}: a transient enable must
  // never install/uninstall the skill on agents running on this host.
  if (persist) void kvSet(KV_KEY, config).catch((e) => logger.error(`config persist failed: ${e.message}`));
  if (syncSkill && !!config.enabled !== wasEnabled) {
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
      if (!ALLOWED_MODES.includes("attach")) return { ok: false, error: "attach mode disabled" };
      return { ok: true, ...(await attachStatus()) };
    case "attach.open":
      if (!ALLOWED_MODES.includes("attach")) return { ok: false, error: "attach mode disabled" };
      return { ok: true, ...openAttachGuide() };
    case "ext.status":
      if (!ALLOWED_MODES.includes("extension")) return { ok: false, error: "extension mode disabled" };
      return { ok: true, ...extStatus() };
    case "ext.install":
      if (!ALLOWED_MODES.includes("extension")) return { ok: false, error: "extension mode disabled" };
      return { ok: true, ...ensureExtensionInstall() };
    case "tabs": {
      const opts = sessionOpts(payload);
      return { ok: true, tabs: await listTabs(opts) };
    }
    case "go": {
      // url → navigate (tab reuse built in); tab selector → switch; new → fresh tab.
      const tabSel = payload.tab ?? payload.target ?? null;
      if (tabSel != null && !payload.url) {
        return { ok: true, ...(await switchTab(sessionOpts(payload), tabSel)), state: await stateAfter(payload) };
      }
      // Returns the element table too — kills the go→ls double round trip.
      return { ok: true, ...(await waitGate(payload)), state: await withSession({
        ...sessionOpts(payload), url: required(payload, "url"), newTab: Boolean(payload.newTab)
      }, async (session) => session.steady()) };
    }
    case "ls": {
      // Windowed element table: from/len page-side; tail/parent host-side.
      const parent = typeof payload.parent === "string" && payload.parent.trim() ? payload.parent : null;
      const len = Number.isFinite(+payload.len) && +payload.len > 0 ? Math.floor(+payload.len) : 248;
      const from = Number.isFinite(+payload.from) && +payload.from > 0 ? Math.floor(+payload.from) : 0;
      // --tail N carries its own window size; a bare --tail uses the default len
      // (+true === 1 must not shrink the window to a single element).
      const tailN = payload.tail === true ? len
        : Number.isFinite(+payload.tail) && +payload.tail > 0 ? Math.floor(+payload.tail) : len;
      const state = await withSession(sessionOpts(payload), async (session) => {
        if (payload.tail) {
          // Deep collect once, window the tail host-side (synthetic controls re-append).
          const s = await session.listState({ len: ELEMENT_DEEP_CAP, cap: ELEMENT_DEEP_CAP });
          const real = s.actions.filter((a) => typeof a.node === "number");
          const synth = s.actions.filter((a) => typeof a.node !== "number");
          s.actions = [...real.slice(Math.max(0, real.length - tailN)), ...synth];
          s.element_from = Math.max(0, real.length - tailN);
          return s;
        }
        return session.listState({ from, len, cap: from > 0 ? ELEMENT_DEEP_CAP : undefined });
      });
      if (parent) state.actions = scopeByParent(state.actions, parent);
      return { ok: true, ...state,
        dialogs: await withSession(sessionOpts(payload), (session) => session.dialogLog) };
    }
    case "undbg": {
      // Drop chrome.debugger for the working tab and let the page breathe:
      // Google GIS refuses to render its button (FedCM cooldown) while a
      // debugger is attached — detach, wait, then serve a fresh state. The
      // next CDP call re-attaches automatically (shim retry).
      const opts = sessionOpts(payload);
      if (!ALLOWED_MODES.includes("extension")) {
        throw new Error("undbg is extension-mode only — extension mode is temporarily disabled");
      }
      if (opts.mode !== "extension") {
        throw new Error("undbg is extension-mode only — in other modes the debugger IS the engine connection");
      }
      const ms = Math.min(60000, Math.max(500, Number(payload.ms) || 15000));
      const url = typeof payload.url === "string" && /^https?:\/\//i.test(payload.url) ? payload.url : null;
      const result = await withSession(opts, async (session) => {
        // Arm a delayed navigation BEFORE detaching (if one is wanted): the
        // page then loads while NO debugger is attached — GIS decides to render
        // its button at load time, so a post-hoc detach changes nothing.
        if (url) {
          await session.client.call("Runtime.evaluate",
            { expression: `setTimeout(() => { location.href = ${JSON.stringify(url)} }, 200)` },
            session.sessionId);
        }
        await session.client.call("SHIM.Debugger.detach", { targetId: session.sessionId });
        await new Promise((r) => setTimeout(r, ms));
        session.lastState = null; // serve a fresh table, not the pre-detach cache
        return { detached: true, ms, ...(url ? { url } : {}) };
      });
      return { ok: true, ...result, state: await stateAfter(payload) };
    }
    case "clear": {
      // Wipe site data for one origin — resets GIS One-Tap cooldowns ("button
      // vanished") without touching the signed-in Google profile cookies.
      const opts = sessionOpts(payload);
      const origin = /^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(String(payload.origin ?? "")) ? payload.origin : null;
      let usedOrigin = origin;
      const result = await withSession(opts, async (session) => {
        if (!usedOrigin) {
          const url = (await session.current()).url;
          usedOrigin = new URL(url).origin;
        }
        await session.client.call("Storage.clearDataForOrigin",
          { origin: usedOrigin, storageTypes: "all" }, session.sessionId);
        return { cleared: usedOrigin };
      });
      return { ok: true, ...result };
    }
    case "console":
      // Console ring — read-only, no session side effects (same shape as state)
      return { ok: true, lines: await withSession(sessionOpts(payload), (session) => session.consoleLog) };
    case "read": {
      // Markdown-lite page read; parent scopes to a tree section, from/len
      // window past the cap, head/tail cut the rendered lines.
      const parent = typeof payload.parent === "string" && payload.parent.trim() ? payload.parent : null;
      const from = Number.isFinite(+payload.from) && +payload.from > 0 ? Math.floor(+payload.from) : 0;
      const len = Number.isFinite(+payload.len) && +payload.len > 0 ? Math.floor(+payload.len) : null;
      const read = await withSession(sessionOpts(payload), (session) => session.readSection(parent, from, len));
      let lines = String(read.text || "").split("\n");
      if (Number.isFinite(+payload.head) && +payload.head > 0) lines = lines.slice(0, Math.floor(+payload.head));
      else if (Number.isFinite(+payload.tail) && +payload.tail > 0) lines = lines.slice(-Math.floor(+payload.tail));
      read.text = lines.join("\n");
      return { ok: true, from, ...read };
    }
    case "search": {
      // search/grep over page content: context, line numbers, invert, links, caps.
      const parent = typeof payload.parent === "string" && payload.parent.trim() ? payload.parent : null;
      let read = await withSession(sessionOpts(payload), (session) => session.readSection(parent));
      const grepOpts = {
        context: payload.context, before: payload.before, after: payload.after,
        lineNumbers: payload.lineNumbers !== false && payload.n !== false,
        invert: Boolean(payload.invert), max: payload.max, links: Boolean(payload.links),
        head: payload.head, tail: payload.tail
      };
      let r = grepContent(read.text, { ...grepOpts, pattern: payload.pattern ?? "" });
      if (!r.matched && !payload.quiet && !payload.invert) {
        for (const variant of searchUrlVariants(payload.pattern)) {
          const rv = grepContent(read.text, { ...grepOpts, pattern: variant });
          if (rv.matched) { r = rv; break; }
        }
      }
      // Self-heal: If 0 matches on non-quiet, wait brief grace and re-read once
      // to absorb late rendering / hydration race (GitHub trending pattern).
      if (!r.matched && !payload.quiet && !payload.invert && String(payload.pattern || "").trim()) {
        try {
          const fresh = await withSession(sessionOpts(payload), async (session) => {
            await new Promise((res) => setTimeout(res, 800));
            await session.settle();
            return session.readSection(parent);
          });
          if (fresh?.text && fresh.text !== read.text) {
            read = fresh;
            r = grepContent(read.text, {
              pattern: payload.pattern ?? "",
              context: payload.context, before: payload.before, after: payload.after,
              lineNumbers: payload.lineNumbers !== false && payload.n !== false,
              invert: Boolean(payload.invert), max: payload.max, links: Boolean(payload.links),
              head: payload.head, tail: payload.tail
            });
          }
        } catch {}
      }
      return { ok: true, ...r, quiet: Boolean(payload.quiet) };
    }
    case "find": {
      // Element-table filter (find(1)): id, label, role or href substring.
      const needle = String(required(payload, "pattern") || "").toLowerCase();
      const state = await withSession(sessionOpts(payload), async (session) => {
        const win = Number.isFinite(+payload.from) && +payload.from > 0
          ? { from: Math.floor(+payload.from), len: ELEMENT_DEEP_CAP, cap: ELEMENT_DEEP_CAP }
          : { len: ELEMENT_DEEP_CAP, cap: ELEMENT_DEEP_CAP };
        return session.listState(win);
      });
      const hits = state.actions.filter((a) =>
        String(a.id || "").toLowerCase().includes(needle) ||
        String(a.label || "").toLowerCase().includes(needle) ||
        String(a.role || "").toLowerCase().includes(needle) ||
        String(a.href || "").toLowerCase().includes(needle));
      return { ok: true, matched: hits.length, total: state.actions.length, actions: hits };
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
      const dialogTail = consoleTail ? await dialogsAfter(payload) : null;
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
        ...(dialogTail?.length ? { dialogs: dialogTail } : {}),
        state: await stateAfter(payload) };
    }
    case "click": {
      const opts = sessionOpts(payload);
      const result = await clickById(opts.profile, required(payload, "id"),
        { promptText: typeof payload.promptText === "string" ? payload.promptText : null,
          nowait: Boolean(payload.nowait) });
      // A prompt answered with "" (no --prompt armed) is a failed action in
      // spirit — fail fast and tell the agent the one way to answer it.
      if (result.dialog?.type === "prompt" && typeof payload.promptText !== "string") {
        return { ok: false,
          error: `click opened window.prompt(${JSON.stringify(result.dialog.message)}) and it was auto-answered "" — ` +
            `click the same id again with --prompt "your answer"`,
          dialog: result.dialog, state: await stateAfter(payload) };
      }
      if (payload.nowait) return { ok: true, ...result };
      return { ok: true, ...result, ...(await waitGate(payload)), state: await stateAfter(payload) };
    }
    case "clickxy": {
      const opts = sessionOpts(payload);
      await withSession(opts, (session) =>
        session.clickPoint(Number(required(payload, "x")), Number(required(payload, "y"))));
      return { ok: true, state: await stateAfter(payload) };
    }
    case "scroll": {
      const opts = sessionOpts(payload);
      let action;
      if (payload.edge) action = (s) => s.scrollToEdge(payload.edge);
      else if (Number.isFinite(Number(payload.y))) action = (s) => s.scrollToY(Number(payload.y));
      else if (typeof payload.to === "string" && payload.to.trim()) {
        const needle = payload.to.trim();
        action = async (s) => {
          const state = await s.current();
          const el = state.actions.find((a) => matchActionId(a, needle)) ||
            state.actions.find((a) => String(a.label || "").replace(/\s+/g, " ").trim().toLowerCase() === needle.toLowerCase());
          if (el) return s.scrollToAction(el);
          const burst = await s.scrollBurstTo([needle]);
          if (!burst.found) {
            throw new Error(`scroll to "${needle}": not found before ${burst.bottom ? "page bottom" : "burst cap"} (y=${burst.y})`);
          }
          return burst;
        };
      } else action = (s) => s.scrollBy(payload.direction || (["down", "up"].includes(String(payload.px)) ? String(payload.px) : (Number(payload.px) || "down")));
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
    case "tabclose": {
      const target = payload.target ?? payload.id ?? payload.index ?? null;
      return { ok: true, ...(await closeTab(sessionOpts(payload), target)) };
    }
    case "type": {
      const opts = sessionOpts(payload);
      const result = await withSession(opts, async (session) => {
        let state = await session.current();
        let action = state.actions.find((a) => matchActionId(a, required(payload, "id")) && a.kind === "fill");
        if (!action) { // table shifted since the caller's observe — one retry
          state = await session.observe();
          action = state.actions.find((a) => matchActionId(a, required(payload, "id")) && a.kind === "fill");
        }
        if (!action) throw new Error(`Field ${required(payload, "id")} not observed (or not editable)`);
        await session.act(action, required(payload, "text"), { nowait: Boolean(payload.nowait) });
        if (payload.enter) await session.pressEnter();
        return { typed: payload.text };
      });
      if (payload.nowait) return { ok: true, ...result };
      return { ok: true, ...result, ...(await waitGate(payload)), state: await stateAfter(payload) };
    }
    case "upload": {
      const opts = sessionOpts(payload);
      const file = required(payload, "file");
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
      const result = await withSession(opts, async (session) => {
        let state = await session.current();
        let action = state.actions.find((a) => matchActionId(a, required(payload, "id")) && a.kind === "upload");
        if (!action) { // table shifted since the caller's observe — one retry
          state = await session.observe();
          action = state.actions.find((a) => matchActionId(a, required(payload, "id")) && a.kind === "upload");
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
    case "chain": {
      const opts = sessionOpts(payload);
      const owed = chainDebt.get(opts.profile) || null;
      const res = await runChain({ ...opts, decide: payload.decide, goal: payload.goal || null },
        payload.steps, payload.parent || null);
      // Debt bookkeeping: a break with pending steps owes them; anything else clears.
      if (res.ok === false && Array.isArray(res.pending) && res.pending.length) {
        chainDebt.set(opts.profile, res.pending.map((s) => s.op));
      } else {
        chainDebt.delete(opts.profile);
      }
      const allRead = Array.isArray(payload.steps) && payload.steps.length > 0 &&
        payload.steps.every((s) => READ_ONLY_CHAIN_OPS.has(s.op));
      if (allRead) {
        const n = (readOnlyStreaks.get(opts.profile) || 0) + 1;
        readOnlyStreaks.set(opts.profile, n);
        if (n >= 2) res.note = `${n} read-only chains in a row — declare the reads inside the action chain`;
      } else {
        readOnlyStreaks.delete(opts.profile);
      }
      // A lone action step is a single verb in chain clothing — same shot burner.
      if (res.ok !== false && payload.steps?.length === 1 && ACTION_CHAIN_OPS.has(payload.steps[0].op)) {
        res.note = [res.note, "1-step action chain — pack the WHOLE journey into this one call"].filter(Boolean).join("; ");
      }
      if (owed) {
        res.note = [res.note, `previous chain broke owing [${owed.join(", ")}] — finish those steps in this chain`]
          .filter(Boolean).join("; ");
      }
      return res;
    }
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
// Dialog ring for a failed run — a swallowed prompt often explains the failure.
const dialogsAfter = async (payload) => {
  try { return await withSession(sessionOpts(payload), (s) => s.dialogLog); }
  catch { return null; }
};

// ---- chain: many steps in ONE call (openclaw batch pattern) -------------------
// Canonical names first (text/elements/shot/upload/delegate); the rest are hidden
// aliases kept for old scripts — the skill only ever teaches the canonical set.
const CHAIN_OPS = new Set(["go", "wait", "click", "type", "select", "hover", "enter", "scroll", "upload", "read", "search", "find", "run", "shot"]);
const READ_ONLY_CHAIN_OPS = new Set(["read", "search", "find", "shot"]);

// Links render path-only on the same origin (shortUrl) — an absolute pattern
// like "https://host/path" would never match. Same text, other spellings.
const searchUrlVariants = (pattern) => {
  const raw = String(pattern || "").trim();
  if (!/^https?:\/\//i.test(raw)) return [];
  try {
    const u = new URL(raw);
    const short = u.pathname + u.search + u.hash;
    return [short, u.host + short].filter((v) => v && v !== raw);
  } catch { return []; }
};
const MAX_CHAIN_STEPS = 50;
// Default line bound for an unscoped chain read: keeps N full reads inside ONE
// chain response (under the caller-side persisted-output cap). head/tail/from
// still override it; the summary names the cut tail so the agent can page on.
const CHAIN_READ_DEFAULT_HEAD = 60;
// Consecutive read-only chains per profile: exploration via one-poke-per-call
// is the same shot burner as action ping-pong, so the second in a row gets called out.
const readOnlyStreaks = new Map();
// Chain debt: ops a broken chain still owed. The next chain on the profile is
// reminded once — the repair shot must finish the journey, not start a fragment.
const chainDebt = new Map();
const ACTION_CHAIN_OPS = new Set(["go", "click", "type", "select", "hover", "enter", "scroll", "upload"]);
const MAX_CHAIN_DEPTH = 3; // root chain + 2 nested run.steps levels
const WAIT_TEXT_CAP_MS = 3000;

// when-guard: a step whose precondition is unmet is SKIPPED, not failed —
// complementary guards on two steps compose into if/else (shell && / ||).
async function whenMet(session, when) {
  try {
    const state = await session.current();
    const hay = `${state.text || ""}\n${(state.actions || []).map((a) => `${a.label} ${a.href || ""}`).join("\n")}`.toLowerCase();
    if (typeof when.url === "string" && !String(state.url || "").toLowerCase().includes(when.url.toLowerCase())) return false;
    if (typeof when.text === "string" && !hay.includes(when.text.toLowerCase())) return false;
    if (typeof when.textNot === "string" && hay.includes(when.textNot.toLowerCase())) return false;
    return true;
  } catch { return false; } // unreadable page = precondition unknown = skip
}

// Only a verified-claim outcome may continue a chain — every other outcome
// means the page is NOT what the LLM predicted, so the remaining guesses are void.
export function chainRunError(result) {
  if (result?.outcome === "needs_verification") return null;
  return new Error(`run ${result?.outcome || "unknown"}: ${result?.reason || "no reason"}`);
}

async function waitText(session, text, timeoutMs = WAIT_TEXT_CAP_MS) {
  const needle = String(text || "").toLowerCase();
  const deadline = Date.now() + Math.max(500, Number(timeoutMs) || WAIT_TEXT_CAP_MS);
  while (Date.now() < deadline) {
    const state = await session.current();
    const hay = `${state.text || ""}\n${(state.actions || []).map((a) => a.label).join("\n")}`.toLowerCase();
    if (hay.includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

// Total step count across nested sub-chains — the flatten bound for MAX_CHAIN_STEPS.
const countChainSteps = (steps) => steps.reduce((n, s) =>
  n + 1 + (Array.isArray(s.steps) ? countChainSteps(s.steps) : 0), 0);

async function runChain(opts, steps, chainParent = null) {
  if (!Array.isArray(steps) || !steps.length) throw new Error(`chain needs 1..${MAX_CHAIN_STEPS} steps`);
  const total = countChainSteps(steps);
  if (total > MAX_CHAIN_STEPS) {
    throw new Error(`chain has ${total} steps (nested included) — max is ${MAX_CHAIN_STEPS}`);
  }
  return withSession(opts, async (session) => {
    const results = [];
    let lastUrl = null;       // url the previous step ended on (null = first step)
    let idsUntrusted = false; // a navigation happened — bare id steps need a label guard
    const scopeOf = (step) => step.parent || chainParent || null;
    // Step numbers are issued at step START (a run parent numbers before its
    // sub-steps), so ids stay unique across nesting regardless of push order.
    let stepCounter = 0;
    // Recursive executor: a `run` step may carry `steps` (sub-chain) executed
    // right after the run passes its expects — chain ⇄ run nesting in ONE call.
    // depth > 0 = sub-chain: a click/select that navigates is ACCEPTED (lastUrl
    // adopted) — multi-page funnels are the whole point of nesting.
    const execSteps = async (subSteps, depth) => {
      for (let i = 0; i < subSteps.length; i++) {
      const step = subSteps[i];
      const parent = scopeOf(step);
      let summary = step.op;
      const stepNo = ++stepCounter;
      if (session.cancelRequested) {
        session.cancelRequested = false; // consume-once: the next chain starts clean
        results.push({ step: stepNo, op: step.op, ok: false, error: "cancelled" });
        return { ok: false, failedStep: stepNo, results, state: await stateAfterSafe(session) };
      }
      try {
        if (!CHAIN_OPS.has(step.op)) throw new Error(`Unknown chain op: ${step.op}`);
        if (step.when && !(await whenMet(session, step.when))) {
          results.push({ step: stepNo, op: step.op, ok: true, skipped: true,
            summary: `when not met — skipped` });
          continue;
        }
        if (step.op === "go") {
          const tabSel = step.tab ?? step.target ?? null;
          if (tabSel != null && !step.url) {
            const tabResult = await session.switchTab(tabSel);
            lastUrl = (await session.current()).url;
            idsUntrusted = true;
            summary = `go tab #${tabResult.index || tabSel} (${String(tabResult.title || tabResult.url || "").slice(0, 30)})`;
          } else {
            if (!step.url) throw new Error("Missing field: url");
            const prevUrl = lastUrl;
            await session.openOrReuseTab(String(step.url), { newTab: Boolean(step.newTab) });
            lastUrl = (await session.current()).url;
            idsUntrusted = prevUrl === null || prevUrl !== lastUrl;
            summary = `go ${String(step.url).slice(0, 40)}`;
          }
        } else if (step.op === "read") {
          // from/len window past the page-level char cap (long-page continuation).
          const read = await session.readSection(parent,
            Number(step.from) > 0 ? Math.floor(Number(step.from)) : 0,
            Number(step.len) > 0 ? Math.floor(Number(step.len)) : null);
          const full = String(read.text || "");
          let lines = full.split("\n");
          if (Number.isFinite(+step.head) && +step.head > 0) lines = lines.slice(0, Math.floor(+step.head));
          else if (Number.isFinite(+step.tail) && +step.tail > 0) lines = lines.slice(-Math.floor(+step.tail));
          else if (!(Number(step.from) > 0) && lines.length > CHAIN_READ_DEFAULT_HEAD) lines = lines.slice(0, CHAIN_READ_DEFAULT_HEAD);
          const text = lines.join("\n");
          const cut = full.length - text.length;
          results.push({ step: stepNo, op: step.op, ok: true,
            summary: cut > 0
              ? `${step.op} ${text.length}/${full.length} chars (+${cut} more: head/tail/from)`
              : `${step.op} ${text.length} chars`, text });
          continue;
        } else if (step.op === "search") {
          let read = await session.readSection(parent);
          const grepOpts = {
            context: step.context, before: step.before, after: step.after,
            lineNumbers: step.lineNumbers !== false, invert: Boolean(step.invert),
            max: step.max, links: Boolean(step.links), head: step.head, tail: step.tail
          };
          let r = grepContent(read.text, { ...grepOpts, pattern: step.pattern ?? "" });
          const hasPattern = String(step.pattern || "").trim().length > 0;
          // Links render path-only on the same origin — an absolute URL pattern
          // must also try its short spellings before the miss counts.
          if (!r.matched && !step.quiet && !step.invert && hasPattern) {
            for (const variant of searchUrlVariants(step.pattern)) {
              const rv = grepContent(read.text, { ...grepOpts, pattern: variant });
              if (rv.matched) { r = rv; break; }
            }
          }
          // for=N: evidence wait — poll until the pattern lands (bounded), for
          // content that appears long after the page went quiet.
          if (!r.matched && !step.quiet && !step.invert && hasPattern && Number(step.for) > 0
              && await waitText(session, String(step.pattern), Math.min(30000, Number(step.for)))) {
            await session.settle();
            read = await session.readSection(parent);
            r = grepContent(read.text, {
              pattern: step.pattern ?? "", context: step.context, before: step.before, after: step.after,
              lineNumbers: step.lineNumbers !== false, invert: Boolean(step.invert),
              max: step.max, links: Boolean(step.links), head: step.head, tail: step.tail
            });
          }
          // Self-heal: If 0 matches on a non-quiet search, wait brief grace and re-read once
          // to absorb late rendering / hydration race (GitHub trending pattern).
          if (!r.matched && !step.quiet && !step.invert && hasPattern) {
            try {
              await new Promise((res) => setTimeout(res, 800));
              await session.settle();
              const freshRead = await session.readSection(parent);
              if (freshRead?.text && freshRead.text !== read.text) {
                read = freshRead;
                r = grepContent(read.text, {
                  pattern: step.pattern ?? "", context: step.context, before: step.before, after: step.after,
                  lineNumbers: step.lineNumbers !== false, invert: Boolean(step.invert),
                  max: step.max, links: Boolean(step.links), head: step.head, tail: step.tail
                });
              }
            } catch {}
          }
          if (!r.matched && !step.quiet && !step.invert && hasPattern) {
            throw new Error(`${step.op} "${step.pattern}": no match`);
          }
          results.push({ step: stepNo, op: step.op, ok: true,
            summary: `${step.op} "${String(step.pattern || "(links)").slice(0, 20)}" → ${r.matched} hits`,
            text: r.text, matched: r.matched });
          continue;
        } else if (step.op === "find") {
          // One verb for the table: pattern filters it, no pattern returns a windowed read.
          const q = String(step.pattern ?? "").trim();
          if (q) {
            const needle = q.toLowerCase();
            const state = await session.current();
            const pool = parent ? scopeByParent(state.actions, parent) : state.actions;
            const hits = pool.filter((a) =>
              String(a.id || "").toLowerCase().includes(needle) ||
              String(a.label || "").toLowerCase().includes(needle) ||
              String(a.role || "").toLowerCase().includes(needle) ||
              String(a.href || "").toLowerCase().includes(needle));
            results.push({ step: stepNo, op: step.op, ok: true,
              summary: `${step.op} "${needle.slice(0, 20)}" → ${hits.length}/${pool.length}`,
              text: renderTreeLines(hits, { coords: true }), matched: hits.length });
          } else {
            const len = Number.isFinite(+step.len) && +step.len > 0 ? Math.floor(+step.len) : 248;
            const from = Number.isFinite(+step.from) && +step.from > 0 ? Math.floor(+step.from) : 0;
            const state = await session.listState({ from, len, cap: from > 0 ? ELEMENT_DEEP_CAP : undefined });
            let actions = state.actions;
            if (Number.isFinite(+step.tail) && +step.tail > 0) {
              const real = actions.filter((a) => typeof a.node === "number");
              const synth = actions.filter((a) => typeof a.node !== "number");
              actions = [...real.slice(Math.max(0, real.length - Math.floor(+step.tail))), ...synth];
            }
            if (parent) actions = scopeByParent(actions, parent);
            results.push({ step: stepNo, op: step.op, ok: true,
              summary: `elements ${actions.length}${state.total_elements ? ` of ${state.total_elements}` : ""}`,
              text: renderTreeLines(actions, { coords: true }), matched: actions.length });
          }
          continue;
        } else if (step.op === "shot") {
          // Visual proof as a chain step: file on disk, path in results —
          // agents Read the file instead of burning a base64 round trip.
          // session.screenshot() directly — shoot(profile) would queue a
          // second session behind the one this chain already holds.
          const image = await session.screenshot();
          const file = `/tmp/9remote-shot-chain-${Date.now()}.jpg`;
          fs.writeFileSync(file, Buffer.from(image, "base64"));
          results.push({ step: stepNo, op: step.op, ok: true, summary: `shot ${file}`, path: file });
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
            // In-process callers (tests) may stub the model; over the wire the
            // function never survives JSON serialization, so this stays local.
            decide: typeof opts.decide === "function" ? opts.decide : undefined,
            // A chain run step may lower Jev's confidence gate — long multi-step
            // goals read as uncertain even when each action is sound.
            policy: Number.isFinite(Number(step.minConfidence))
              ? { ...policyFromConfig(), minConfidence: Math.min(1, Math.max(0, Number(step.minConfidence))) }
              : policyFromConfig(),
            only: step.only || null,
            parent,
            fields: sanitizeFields(step.fields),
            maxSteps: clampSteps(step.maxSteps),
            maxMs: clampMs(step.maxMs),
            expect,
            onStep: emitStep
          });
          // Evidence beats confidence: an expect that passes on the live page
          // means the delegated work DID land — a low-confidence finish must
          // not void a journey that already reached its declared destination.
          const verification = expect ? checkExpectations(await session.observe(), expect) : null;
          const runError = chainRunError(result);
          if (runError && !(expect && verification?.passed)) throw runError;
          if (expect && !verification.passed) {
            throw new Error(`expect not met after run: ${Object.entries(verification.checks)
              .filter(([, ok]) => !ok).map(([check]) => check).join(", ")}`);
          }
          if (step.expectUrl) { // the run was declared to end elsewhere — adopt the new page
            lastUrl = (await session.current()).url;
            idsUntrusted = true;
          }
          summary = `run -> ${result.outcome}`;
          // Nested sub-chain: executed after the run verified PASS. A sub-step
          // failure propagates (fail-fast) attributed to this parent step.
          if (Array.isArray(step.steps) && step.steps.length) {
            if (depth + 1 >= MAX_CHAIN_DEPTH) {
              throw new Error(`chain nesting too deep — max ${MAX_CHAIN_DEPTH} levels`);
            }
            const sub = await execSteps(step.steps, depth + 1);
            if (sub && !sub.ok) {
              // A sub-chain break still owes the parent's remaining steps too.
              sub.pending = [...(sub.pending || []), ...subSteps.slice(i + 1)];
              return sub; // never swallow: the chain stops HERE
            }
          }
        } else {
          let state = await session.current();
          // A main-frame nav the previous click's settle never saw committed
          // (location.href assignments fire no frameRequestedNavigation) —
          // settle once more before ruling, so the failure names the NAV
          // instead of a vanishing element.
          if (lastUrl !== null && state.url === lastUrl &&
              session.navReq && session.navReq.ts > session.navCommit) {
            state = await session.steady();
          }
          if (lastUrl !== null && state.url !== lastUrl) {
            throw new Error(`unexpected navigation to ${state.url} — the page left ${lastUrl}; re-plan from the returned state`);
          }
          lastUrl = state.url;
          let pool = scopeByParent(state.actions, parent);
          const refreshPool = async () => {
            const fresh = await session.observe();
            pool = scopeByParent(fresh.actions, parent);
            return fresh;
          };
          // Fail-fast lookup: no first-match-wins. Ambiguity throws, a wrong
          // id under a label guard throws BEFORE the click, and bare ids are
          // refused outright once the page has navigated.
          // Label-only steps (no id) resolve by exact label — chain ids survive
          // wizard steps that renumber the table between renders.
          const find = (target, expectedKind = null, guard = null, labelOnly = false) => {
            if (!target) throw new Error("Missing element target");
            if (!labelOnly && guard == null && idsUntrusted && /^([a-z]*)\d+(-\d+)?$/i.test(String(target))) {
              throw new Error(`page navigated — id steps need a label guard (click ${target} 'Label')`);
            }
            const lower = String(target).toLowerCase();
            const kindPool = expectedKind ? pool.filter((a) => a.kind === expectedKind) : pool;
            const normHit = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
            const labelHit = (a) => normHit(a.label) === normHit(target) ||
              (a.kind === "select" && (a.value === target || a.label?.toLowerCase().endsWith(`→ ${lower}`) || a.label?.toLowerCase().endsWith(`-> ${lower}`)));
            let candidates = pool.filter((a) => matchActionId(a, target));
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
            // Whitespace-insensitive guard: the printed table collapses runs of
            // spaces, so an agent copying the label verbatim from it must still
            // match a DOM label containing double spaces.
            const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
            if (guard != null && norm(action.label) !== norm(guard)) {
              throw new Error(`label mismatch: ${action.id} is "${action.label}", expected "${guard}" — the page changed under this id`);
            }
            return action;
          };
          // One-shot booster: try every guessed label (tryLabels), and on a
          // not-observed miss re-observe ONCE (render race) before giving up.
          // Config errors (ambiguous, guard mismatch, bare-id-after-nav) still
          // fail fast — those are wrong guesses about the WRONG thing.
          const findAny = async (step, kind) => {
            const variants = step.id
              ? [step.id]
              : [step.label, ...(Array.isArray(step.tryLabels) ? step.tryLabels : [])]
                .filter((x) => typeof x === "string" && x.trim());
            if (!variants.length) throw new Error("Missing element target");
            let lastErr = null;
            for (let round = 0; round < 2; round++) {
              for (const v of variants) {
                try {
                  return step.id
                    ? find(v, kind, step.label ?? null)
                    : find(v, kind, null, true);
                } catch (e) {
                  if (!/not observed/i.test(e.message)) throw e;
                  lastErr = e;
                }
              }
              if (round === 0) await refreshPool();
            }
            throw lastErr;
          };
          if (step.op === "upload") {
            const file = required(step, "file");
            if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
            const action = await findAny(step, "upload");
            await session.uploadFile(action, file);
            summary = `upload ${action.id} (${String(action.label || "").slice(0, 30)})`;
          } else if (step.op === "click" || step.op === "select") {
            const action = await findAny(step, step.op);
            // Arm a prompt answer BEFORE the click so a chained click can pass
            // a native prompt gate in the same shot ("prompt":"SEC-42").
            if (typeof step.prompt === "string") session.pendingPromptText = step.prompt;
            const actStart = Date.now();
            try {
              const done = await session.act(action);
              if (done.dialog?.type === "prompt") {
                throw new Error(`window.prompt(${JSON.stringify(done.dialog.message)}) opened and was auto-answered "" — ` +
                  `re-click with a prompt field: {"op":"click","id":"${action.id}","prompt":"answer"}`);
              }
            } finally {
              // A failed act must not leave the answer armed for whoever
              // triggers the next dialog on this session.
              if (typeof step.prompt === "string") session.pendingPromptText = null;
            }
            summary = `${step.op} ${action.id} (${String(action.label || "").slice(0, 40)})`;
            // A SPA route (pushState, same document) may legitimately follow a
            // click — adopt the new url so the next step is not failed on a
            // stale guard. A FULL navigation this click committed stays
            // un-adopted at depth 0: the next step's guard throws "unexpected
            // navigation" (the chain never declared the move; only go/expectUrl
            // may). Inside a run.steps sub-chain multi-page funnels ARE the
            // point — accept the move.
            const req = session.navReq;
            const fullNav = req && !["newTab", "download"].includes(req.disposition) &&
              session.navCommit >= req.ts && req.ts >= actStart - 200;
            // nav:true = the model DECLARED this click navigates (link to the
            // next page) — adopt the landing page instead of failing the next
            // step for a move the chain itself predicted.
            if (!fullNav || depth > 0 || step.nav === true) {
              const nowUrl = (await session.current()).url;
              if (nowUrl !== lastUrl) { lastUrl = nowUrl; idsUntrusted = true; }
            }
          } else if (step.op === "type") {
            const action = await findAny(step, "fill");
            if (action.kind !== "fill") throw new Error(`${action.id} is not an editable field`);
            await session.act(action, String(step.text ?? ""));
            if (step.enter) await session.pressEnter();
            // enter = declared submission: adopt wherever it landed — the next
            // step must not die on a navigation the step itself predicted.
            if (step.enter) {
              lastUrl = (await session.current()).url;
              idsUntrusted = true;
            }
            summary = `type ${action.id}${step.enter ? " +enter" : ""}`;
          } else if (step.op === "enter") {
            await session.pressEnter();
            // Same contract as type+enter: a pressed enter is a declared submit.
            lastUrl = (await session.current()).url;
            idsUntrusted = true;
          } else if (step.op === "hover") {
            // Resolve any element kind (menu items are often links or divs),
            // then move the mouse onto it — menus revealed by :hover appear.
            const action = await findAny(step, null);
            await session.hoverAction(action);
            summary = `hover ${action.id} (${String(action.label || "").slice(0, 40)})`;
          } else if (step.op === "scroll") {
            if (Number.isFinite(Number(step.y))) {
              // Coordinate primitive: document-absolute Y centered mid-viewport.
              await session.scrollToY(Number(step.y));
              summary = `scroll y=${Math.round(Number(step.y))}`;
            } else if (typeof step.to === "string" && step.to.trim()) {
              const needle = step.to.trim();
              // Element id/label hit wins (live resolve, nested containers);
              // anything else is a text needle hunted by the one-shot burst.
              const el = pool.find((a) => matchActionId(a, needle)) ||
                pool.find((a) => String(a.label || "").replace(/\s+/g, " ").trim()
                  .toLowerCase() === needle.toLowerCase());
              if (el) {
                await session.scrollToAction(el);
                summary = `scroll to ${el.id} (${String(el.label || "").slice(0, 30)})`;
              } else {
                const textScroll = await session.scrollToText?.(needle);
                if (textScroll?.found) {
                  summary = `scroll to "${needle.slice(0, 30)}"`;
                } else {
                  const burst = await session.scrollBurstTo([needle]);
                  if (!burst.found) {
                    throw new Error(`scroll to "${needle}": not found before ${burst.bottom ? "page bottom" : "burst cap"} (y=${burst.y})`);
                  }
                  summary = `scroll to text "${needle.slice(0, 30)}" ×${burst.hops}`;
                }
              }
            } else {
              const id = step.direction === "up" ? "scroll_up" : "scroll_down";
              await session.act(find(id));
              summary = `scroll ${step.direction || "down"}`;
            }
          } else if (step.op === "wait") {
            await session.settle();
            const ms = Math.min(10000, Number(step.ms) || 0);
            if (ms && !step.text) await new Promise((r) => setTimeout(r, ms));
            if (step.text) {
              const waitLimit = ms || WAIT_TEXT_CAP_MS;
              if (!(await waitText(session, String(step.text), waitLimit))) {
                throw new Error(`Timed out waiting for text: ${step.text}`);
              }
              summary = `wait "${String(step.text).slice(0, 30)}"`;
            }
          }
        }
        results.push({ step: stepNo, op: step.op, ok: true, summary });
      } catch (e) {
        results.push({ step: stepNo, op: step.op, ok: false, error: e.message });
        // Fail fast: return where the chain broke plus the live page state,
        // cropped to the failing step's section so the LLM re-plans in place.
        let broken = null;
        try { broken = await session.current(); } catch { /* keep results anyway */ }
        if (broken && parent) broken = { ...broken, actions: scopeByParent(broken.actions, parent) };
        // Console tail rides along — a JS error usually IS why the step broke,
        // and the agent must not spend a round trip asking for it.
        // pending: the steps still to run, so the repair shot is copy-paste.
        // goal/progress anchor the repair to the declared destination.
        return { ok: false, failedStep: stepNo, results, pending: subSteps.slice(i + 1),
          ...(opts.goal ? { goal: opts.goal, progress: `${stepNo}/${total}` } : {}),
          state: broken, console: session.consoleLog.slice(-CONSOLE_FAIL_TAIL) };
      }
      }
    };
    const outcome = await execSteps(steps, 0); // null = completed cleanly
    if (outcome) return outcome;
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
const MODES = ALLOWED_MODES;
const sessionOpts = (payload = {}) => {
  const mode = MODES.includes(payload.mode) ? payload.mode : config.mode;
  const base = mode === "attach" ? "__attach__" : mode === "extension" ? "__extension__" : (payload.profile || "default");
  return {
    profile: base,
    mode,
    headless: config.headless,
    newTab: Boolean(payload.newTab)
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
