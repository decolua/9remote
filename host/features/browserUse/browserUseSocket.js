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
import { DEFAULT_POLICY } from "./agentLoop.js";
import {
  attachStatus, closeProfile, createProfile, deleteProfile, listProfiles, renameProfile,
  requestCancel, runTask, sessionStatus, shoot, withSession, clickById, typeById, pressEnter
} from "./engine.js";
import { JEV_CONFIG_DEFAULTS, KEEP_REPORTS, KV_KEY, MAX_MS_HARD, MAX_STEPS_HARD } from "./constants.js";
import { ensureSkillInstalled } from "./skill.js";

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
  const next = { ...config };
  for (const key of ["enabled", "preset", "endpoint", "model", "apiKey", "headless"]) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.mode === "own" || patch.mode === "attach") next.mode = patch.mode;
  if (typeof patch.minConfidence === "number") {
    next.minConfidence = Math.min(1, Math.max(0, patch.minConfidence));
  }
  config = next;
  void kvSet(KV_KEY, config).catch((e) => logger.error(`config persist failed: ${e.message}`));
  return { ok: true, config: publicConfig() };
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
      return { ok: true, config: publicConfig(), sessions: sessionStatus(), profiles: listProfiles() };
    case "attach.status":
      return { ok: true, ...attachStatus() };
    case "profiles.list":
      return { ok: true, profiles: listProfiles() };
    case "profiles.create":
      return { ok: true, profile: createProfile(payload.name) };
    case "profiles.rename":
      return { ok: true, ...(await renameProfile(payload.from, payload.to)) };
    case "profiles.delete":
      return { ok: true, ...(await deleteProfile(payload.name)) };
    case "open":
      // Returns the element table too — kills the open→state double round trip.
      return { ok: true, state: await withSession({
        profile: payload.profile || "default",
        url: required(payload, "url"),
        mode: payload.mode === "attach" ? "attach" : config.mode,
        headless: config.headless
      }, async (session) => session.observe()) };
    case "state":
      return { ok: true, ...(await withSession({ profile: payload.profile || "default" }, (session) => session.current())) };
    case "run": {
      requireRunConfig();
      const taskId = `t-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const goal = required(payload, "goal");
      const result = await withSession({
        profile: payload.profile || "default",
        url: payload.url,
        mode: payload.mode === "attach" ? "attach" : config.mode,
        headless: config.headless
      }, (session) => runTask(session, {
        goal,
        config,
        policy: policyFromConfig(),
        maxSteps: clampSteps(payload.maxSteps),
        maxMs: clampMs(payload.maxMs),
        resume: payload.resume || null,
        only: payload.only || null,
        onStep: emitStep
      }));
      let image = null;
      try {
        image = await withSession({ profile: payload.profile || "default" }, (s) => s.screenshot());
      } catch { /* screenshot optional */ }
      // A report failure must not swallow the run result — the agent would
      // retry the whole Jev loop and re-run every action.
      let report = null;
      try { report = (await writeReport(taskId, { goal, result, image })).report; }
      catch (e) { logger.error(`report write failed: ${e.message}`); }
      pushOutcome(goal, result);
      logger.info(`run ${taskId}: ${result.outcome} (${result.metrics.steps} steps)`);
      return { ok: true, taskId, ...result, report, state: await stateAfter(payload.profile || "default") };
    }
    case "click":
      return { ok: true, ...(await clickById(payload.profile || "default", required(payload, "id"))),
        state: await stateAfter(payload.profile || "default") };
    case "type": {
      const profile = payload.profile || "default";
      const result = await typeById(profile, required(payload, "id"), required(payload, "text"));
      if (payload.enter) await pressEnter(profile); // same process, one round trip
      return { ok: true, ...result, state: await stateAfter(profile) };
    }
    case "enter":
      return { ok: true, ...(await pressEnter(payload.profile || "default")),
        state: await stateAfter(payload.profile || "default") };
    case "shot":
      return { ok: true, ...(await shoot(payload.profile || "default")) };
    case "run.cancel":
      return { ok: true, ...requestCancel(payload.profile || "default") };
    case "chain":
      return await runChain(payload.profile || "default", payload.steps);
    case "close":
      return { ok: true, ...(await closeProfile(payload.profile || "default")) };
    default:
      throw new Error(`Unknown browserUse action: ${action}`);
  }
}

// Post-action state for the response — cached when the page did not change.
// Never let a failed observation swallow the action result: the action already
// ran, and reporting it as an error would make the agent retry (double-click).
const stateAfter = async (profile) => {
  try { return await withSession({ profile }, (s) => s.current()); }
  catch { return null; }
};

// ---- chain: many steps in ONE call (openclaw batch pattern) -------------------
const CHAIN_OPS = new Set(["click", "select", "type", "enter", "scroll", "wait", "run"]);
const MAX_CHAIN_STEPS = 30;
const WAIT_TEXT_CAP_MS = 3000;

async function waitText(session, text) {
  const deadline = Date.now() + WAIT_TEXT_CAP_MS;
  while (Date.now() < deadline) {
    const state = await session.current();
    if (state.text?.includes(text)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function runChain(profile, steps) {
  if (!Array.isArray(steps) || !steps.length || steps.length > MAX_CHAIN_STEPS) {
    throw new Error(`chain needs 1..${MAX_CHAIN_STEPS} steps`);
  }
  return withSession({ profile }, async (session) => {
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      let summary = step.op;
      if (session.cancelRequested) {
        session.cancelRequested = false; // consume-once: the next chain starts clean
        results.push({ step: i + 1, op: step.op, ok: false, error: "cancelled" });
        return { ok: false, failedStep: i + 1, results, state: await stateAfterSafe(session) };
      }
      try {
        if (!CHAIN_OPS.has(step.op)) throw new Error(`Unknown chain op: ${step.op}`);
        if (step.op === "run") {
          requireRunConfig(); // chain must not bypass the enabled gate
          if (!step.goal) throw new Error("Missing field: goal");
          const result = await runTask(session, {
            goal: String(step.goal),
            config,
            policy: policyFromConfig(),
            only: step.only || null,
            maxSteps: clampSteps(step.maxSteps),
            maxMs: clampMs(step.maxMs),
            onStep: emitStep
          });
          summary = `run -> ${result.outcome}`;
          if (result.outcome === "decision_error" || result.outcome === "action_error") {
            throw new Error(result.reason);
          }
        } else {
          const state = await session.current();
          const find = (id) => {
            const action = state.actions.find((a) => a.id === id);
            if (!action) throw new Error(`Element ${id} not observed`);
            return action;
          };
          if (step.op === "click" || step.op === "select") {
            const action = find(step.id);
            await session.act(action);
            summary = `${step.op} ${step.id} (${String(action.label || "").slice(0, 40)})`;
          } else if (step.op === "type") {
            const action = find(step.id);
            if (action.kind !== "fill") throw new Error(`${step.id} is not an editable field`);
            await session.act(action, String(step.text ?? ""));
            if (step.enter) await session.pressEnter();
            summary = `type ${step.id}${step.enter ? " +enter" : ""}`;
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
        // Fail fast: return where the chain broke plus the live page state.
        let broken = null;
        try { broken = await session.current(); } catch { /* keep results anyway */ }
        return { ok: false, failedStep: i + 1, results, state: broken };
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

const required = (payload, key) => {
  const value = payload?.[key];
  if (value === undefined || value === null || value === "") throw new Error(`Missing field: ${key}`);
  return value;
};
const pickOverrides = ({ endpoint, model, apiKey }) => ({ ...(endpoint ? { endpoint } : {}), ...(model ? { model } : {}), ...(apiKey ? { apiKey } : {}) });
const clampSteps = (n) => {
  const value = Number(n);
  return Math.min(MAX_STEPS_HARD, Math.max(1, Number.isFinite(value) && value > 0 ? value : 12));
};
const clampMs = (n) => {
  const value = Number(n);
  return Math.min(MAX_MS_HARD, Math.max(1000, Number.isFinite(value) && value > 0 ? value : 45000));
};

// ---- socket + local API adapters ----------------------------------------------
export function setupBrowserUseHandlers(socket) {
  void ensureSkillInstalled().catch((e) => logger.debug(`skill install skipped: ${e.message}`));
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
