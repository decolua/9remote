// Chrome lifecycle + executor. Own-profile mode spawns a Chrome with a private
// user-data-dir (Chrome 136 blocks debug flags on the default dir by design);
// attach mode reads the user's DevToolsActivePort after they opt in.
// Profile-scoped work is serialized on a promise chain — one decision gate, no
// interleaved CDP writes (same philosophy as the terminal daemonRouter).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../../lib/logger.js";
import { CdpClient, waitForDevTools } from "./cdp.js";
import { MARKER_EXPRESSION, SNAPSHOT_EXPRESSION, evaluate } from "./snapshot.js";
import {
  ATTACH_GUIDE_STEPS, LAUNCH_TIMEOUT_MS, OBSERVE_STALE_RETRIES, SCREENSHOT_FORMAT,
  SCREENSHOT_QUALITY, VIEWPORT, WAIT_COMBOBOX_MS, WAIT_FRAMES, WAIT_OTHER_MS
} from "./constants.js";
import { runTask } from "./agentLoop.js";

const logger = createLogger("browserUse");

const CHROME_CANDIDATES = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
     "/Applications/Chromium.app/Contents/MacOS/Chromium",
     "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
     "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"]
  : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];

export function profilesRoot() {
  return path.join(os.homedir(), ".9remote", "browser-profiles");
}

export function safeProfileName(name) {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(String(name || ""));
}

export function listProfiles() {
  const root = profilesRoot();
  if (!fs.existsSync(root)) return [{ name: "default" }];
  const found = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && safeProfileName(d.name))
    .map((d) => ({ name: d.name }));
  return found.some((p) => p.name === "default") ? found : [{ name: "default" }, ...found];
}

export function createProfile(name) {
  if (!safeProfileName(name)) throw new Error("Profile name must match [a-z0-9_-], max 32 chars");
  fs.mkdirSync(path.join(profilesRoot(), name), { recursive: true });
  return { name };
}

export async function deleteProfile(name) {
  if (!safeProfileName(name) || name === "default") throw new Error("Refusing to delete this profile");
  await closeProfile(name);
  fs.rmSync(path.join(profilesRoot(), name), { recursive: true, force: true });
  return { name, deleted: true };
}

export async function renameProfile(from, to) {
  if (!safeProfileName(from) || !safeProfileName(to)) throw new Error("Invalid profile name");
  if (to === "default") throw new Error("Refusing to rename onto 'default'");
  await closeProfile(from);
  const src = path.join(profilesRoot(), from);
  const dst = path.join(profilesRoot(), to);
  if (!fs.existsSync(src)) throw new Error(`Profile not found: ${from}`);
  if (fs.existsSync(dst)) throw new Error(`Profile already exists: ${to}`);
  fs.renameSync(src, dst);
  return { from, to };
}

// ---- per-profile serialization ---------------------------------------------
const chains = new Map();
function serialize(profile, fn) {
  const prev = chains.get(profile) || Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(profile, run.catch(() => {}));
  return run;
}

// ---- Chrome discovery / launch ----------------------------------------------
export function resolveChromeBinary() {
  for (const candidate of CHROME_CANDIDATES) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      try { return execFileSync("which", [candidate], { timeout: 2000 }).toString().trim(); } catch { /* next */ }
    }
  }
  return null;
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// Attach mode: the user opted into chrome://inspect/#remote-debugging. We never
// relaunch their browser — only read the port (and WS path) Chrome published.
// Newer Chrome serves no /json HTTP API on this port; the browser WS path from
// the file's second line is the working entry point.
export function findAttachedDevToolsInfo() {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Library", "Application Support", "Google", "Chrome"),
    path.join(home, ".config", "google-chrome"),
    path.join(home, "AppData", "Local", "Google", "Chrome", "User Data")
  ];
  for (const dir of candidates) {
    try {
      const [port, wsPath] = fs.readFileSync(path.join(dir, "DevToolsActivePort"), "utf8").trim().split("\n");
      if (!/^\d+$/.test(port)) continue;
      const info = { port: Number(port) };
      if (wsPath?.startsWith("/")) info.wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
      return info;
    } catch { /* not enabled here */ }
  }
  return null;
}

export function attachStatus() {
  const info = findAttachedDevToolsInfo();
  return { available: Boolean(info), port: info?.port ?? null, guide: info ? null : ATTACH_GUIDE_STEPS };
}

// ---- sessions -----------------------------------------------------------------
const sessions = new Map(); // profile -> session

function makeSession({ profile, mode, port, child, client, sessionId, targetId, headless = false }) {
  const call = (method, params = {}) => client.call(method, params, sessionId);
  const enter = (type) => ({
    type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
  });

  const session = {
    profile, mode, port, targetId, headless,
    lastState: null,
    cancelRequested: false,

    async setup() {
      await call("Emulation.setDeviceMetricsOverride",
        { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
      // Keep background tabs rendering (rAF, menus) without stealing the user's tab.
      await call("Emulation.setFocusEmulationEnabled", { enabled: true });
    },

    async navigate(url) {
      await call("Page.enable");
      await call("Page.navigate", { url });
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await evaluate(client, sessionId, "document.readyState") === "complete") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // Two pages can render identically — never serve the old table after a navigate.
      session.lastState = null;
    },

    async observe() {
      for (let attempt = 0; attempt < OBSERVE_STALE_RETRIES; attempt++) {
        try {
          const state = await evaluate(client, sessionId, SNAPSHOT_EXPRESSION);
          if (state) { session.lastState = state; return state; }
        } catch { /* document navigating — retry */ }
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("Page did not settle for observation");
    },

    // Cached state when the page has not changed since the last snapshot —
    // a cheap marker check instead of a full snapshot on every command.
    async current() {
      if (session.lastState && await session.fresh(session.lastState)) return session.lastState;
      return session.observe();
    },

    async fresh(page) {
      try {
        return await evaluate(client, sessionId, MARKER_EXPRESSION) === page.marker;
      } catch {
        return false;
      }
    },

    // Headed-mode visual feedback: outline the target and glide a virtual cursor
    // to the click point (browser-use style). No-op in headless — nobody watches.
    async decorate(action, point) {
      if (headless) return;
      try {
        await evaluate(client, sessionId, `(payload => {
          const c = window.__9rFast; if (!c) return;
          const e = c.nodes.get(payload.node);
          const r = e?.getBoundingClientRect();
          if (!r || !r.width) return;
          document.getElementById('__9rFx')?.remove();
          const box = document.createElement('div');
          box.id = '__9rFx';
          box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;'+
            'left:'+(r.x-3)+'px;top:'+(r.y-3)+'px;width:'+(r.width+6)+'px;height:'+(r.height+6)+
            'px;border:2px solid #ff3b30;border-radius:4px;transition:opacity .3s';
          const dot = document.createElement('div');
          dot.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;'+
            'width:16px;height:16px;border-radius:50%;background:#ff3b30;opacity:.85;'+
            'left:'+(payload.x-68)+'px;top:'+(payload.y-68)+'px;'+
            'transition:left .12s ease-out,top .12s ease-out,opacity .3s';
          box.appendChild(dot); // child of the box so removing the box clears both
          (document.body||document.documentElement).append(box);
          requestAnimationFrame(() => {
            dot.style.left = (payload.x-8)+'px';
            dot.style.top = (payload.y-8)+'px';
          });
          setTimeout(() => {
            box.style.opacity = '0'; dot.style.opacity = '0';
            setTimeout(() => { box.remove(); dot.remove(); }, 320);
          }, 240);
        })(${JSON.stringify({ node: action.node, x: point.x, y: point.y })})`);
        // Let the cursor glide land before the real click does.
        await new Promise((r) => setTimeout(r, 130));
      } catch { /* decoration must never block the action */ }
    },

    // Resolve an observed action to live coordinates; refuse anything covered,
    // hidden or gone. Model-chosen ids never bypass this gate.
    async resolve(action) {
      return evaluate(client, sessionId, `(action => {
        const c = window.__9rFast; if (!c) return null;
        const e = c.nodes.get(action.node);
        if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
            !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
        if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return null;
        const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
        if (!e.contains(document.elementFromPoint(x, y))) return null;
        if (action.kind === 'select') {
          if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === action.value && !o.disabled)) return null;
          e.value = action.value;
          e.dispatchEvent(new Event('input', {bubbles:true}));
          e.dispatchEvent(new Event('change', {bubbles:true}));
        }
        return { x, y };
      })(${JSON.stringify({ node: action.node, kind: action.kind, value: action.value })})`);
    },

    async act(action, text = null) {
      if (action.kind === "wait") {
        await new Promise((r) => setTimeout(r, 100));
        return { executed: action.id };
      }
      if (action.kind === "scroll") {
        await call("Input.dispatchMouseEvent",
          { type: "mouseWheel", x: 550, y: 650, deltaX: 0, deltaY: action.delta });
        await session.settle();
        return { executed: action.id };
      }
      if (typeof action.node !== "number") {
        throw stale("Action does not reference an observed node");
      }
      const target = await session.resolve(action);
      if (!target) throw stale("Target changed or is covered");
      await session.decorate(action, target);
      if (action.kind !== "select") {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await call("Input.dispatchMouseEvent", { type, x: target.x, y: target.y, button: "left", clickCount: 1 });
        }
      }
      if (action.kind === "fill") await session.type(action, text);
      await session.settle(action);
      return { executed: action.id };
    },

    async type(action, text) {
      if (typeof text !== "string" || !text.trim()) throw new Error("Refusing to type empty text");
      await evaluate(client, sessionId, `(node => {
        const e = window.__9rFast?.nodes.get(node); if (e) e.focus();
      })(${action.node})`);
      const meta = process.platform === "darwin" ? 4 : 2;
      await call("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: meta, commands: ["selectAll"] });
      await call("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: meta });
      await call("Input.insertText", { text });
      // Rich-text editors (e.g. E2EE compose) can drop CDP insertText in background
      // tabs — verify the text landed and retry via execCommand inside the page.
      let landed = true;
      try {
        landed = await evaluate(client, sessionId, `(node => {
          const e = window.__9rFast?.nodes.get(node); if (!e) return true;
          const v = 'value' in e ? String(e.value) : (e.innerText || '');
          return v.includes(${JSON.stringify(text)});
        })(${action.node})`);
      } catch { /* navigating right after typing — assume it landed */ }
      if (!landed) {
        await evaluate(client, sessionId, `(node => {
          const e = window.__9rFast?.nodes.get(node); if (e) e.focus();
          document.execCommand('insertText', false, ${JSON.stringify(text)});
        })(${action.node})`);
      }
    },

    async pressEnter() {
      await call("Input.dispatchKeyEvent", enter("keyDown"));
      await call("Input.dispatchKeyEvent", enter("keyUp"));
    },

    // Bounded, deterministic post-action wait — never spends a Jev call.
    async settle(action = null) {
      const cap = action?.kind === "fill" ? WAIT_COMBOBOX_MS : WAIT_OTHER_MS;
      const expression = `(cap => new Promise(resolve => {
        let frames = 0, stopped = false;
        const finish = () => { if (!stopped) { stopped = true; resolve(null); } };
        setTimeout(finish, cap);
        const tick = () => { if (stopped) return; if (++frames >= ${WAIT_FRAMES}) finish(); else requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      }))(${cap})`;
      try { await evaluate(client, sessionId, expression, { awaitPromise: true }); }
      catch { /* page navigating mid-wait is fine */ }
    },

    async screenshot() {
      const result = await call("Page.captureScreenshot",
        { format: SCREENSHOT_FORMAT, quality: SCREENSHOT_QUALITY });
      return result.data; // base64 jpeg
    },

    async close() {
      sessions.delete(profile);
      try { await client.call("Target.closeTarget", { targetId }); } catch { /* already gone */ }
      client.close();
      try { child?.kill(); } catch { /* already exited */ }
    }
  };
  return session;
}

function stale(message) {
  const err = new Error(message);
  err.code = "STALE";
  return err;
}

// Open (or reuse) a session for a profile. Serialized per profile.
export async function withSession(options, fn) {
  const profile = options.profile || "default";
  return serialize(profile, async () => {
    const existing = sessions.get(profile);
    const session = existing || await launchSession(options);
    // Reloading an identical URL wastes seconds and resets page state. Compare
    // against where the page ACTUALLY is (lastState.url), not the last requested
    // URL — otherwise navigating away then re-opening the original sticks.
    if (options.url && session.lastState?.url !== options.url) {
      await session.navigate(options.url);
    }
    return fn(session);
  });
}

async function launchSession({ profile = "default", url, mode = "own", attachPort = null, headless = false }) {
  let port;
  let child = null;
  let bin = null;
  const stderrTail = [];
  let attachWsUrl = null;
  if (mode === "attach") {
    const info = attachPort ? { port: attachPort } : findAttachedDevToolsInfo();
    if (!info) throw new Error("Real browser not attached — enable chrome://inspect/#remote-debugging first");
    port = info.port;
    attachWsUrl = info.wsUrl || null;
  } else {
    bin = resolveChromeBinary();
    if (!bin) throw new Error("No Chrome/Chromium binary found on this machine");
    if (!safeProfileName(profile)) throw new Error(`Invalid profile name: "${profile}"`);
    port = await reservePort();
    const dir = path.join(profilesRoot(), profile);
    fs.mkdirSync(dir, { recursive: true });
    const args = [
      `--user-data-dir=${dir}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run", "--no-default-browser-check",
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`
    ];
    if (headless) args.push("--headless=new");
    child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    child.on("error", () => {}); // surfaced by waitForDevTools instead
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (d) => { stderrTail.push(d); if (stderrTail.length > 30) stderrTail.shift(); });
  }
  let info;
  try {
    // Attached browsers skip the /json HTTP API (newer Chrome doesn't serve it) —
    // connect straight to the WS path from DevToolsActivePort.
    info = attachWsUrl ? { webSocketDebuggerUrl: attachWsUrl } : await waitForDevTools(port, LAUNCH_TIMEOUT_MS);
  } catch (e) {
    child?.kill();
    const stderr = (stderrTail.join("") || "").slice(-400).replace(/\n/g, " | ");
    throw new Error(`${e.message} (chrome exitCode=${child?.exitCode ?? "n/a"} bin=${bin} stderr=${stderr || "none"})`);
  }
  const client = await CdpClient.connect(info.webSocketDebuggerUrl);
  try {
    const target = await client.call("Target.createTarget", { url: "about:blank", background: true });
    const attached = await client.call("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const session = makeSession({
      profile, mode, port, child, client, sessionId: attached.sessionId, targetId: target.targetId, headless
    });
    await session.setup();
    sessions.set(profile, session);
    logger.info(`session open: profile=${profile} mode=${mode} port=${port}`);
    return session;
  } catch (e) {
    // A half-open session must not orphan the Chrome we just spawned.
    client.close();
    child?.kill();
    throw e;
  }
}

export async function closeProfile(profile) {
  return serialize(profile, async () => {
    const session = sessions.get(profile);
    if (session) await session.close();
    return { profile, closed: true };
  });
}

// ---- single-step helpers (CLI / tests) ---------------------------------------
// Accept a session object (already inside the chain — calls run direct) or a
// profile name (calls join the chain). Never both paths serialize the same call.

export async function observe(target) {
  const session = toSession(target);
  return session.observe();
}

export async function clickById(target, id) {
  const session = toSession(target);
  const run = () => clickAction(session, id);
  return typeof target === "string" ? serialize(target, run) : run();
}

export async function typeById(target, id, text) {
  const session = toSession(target);
  const run = async () => {
    const state = await session.current();
    const action = state.actions.find((a) => a.id === id && a.kind === "fill");
    if (!action) throw new Error(`Field ${id} not observed (or not editable)`);
    await session.act(action, text);
    return { typed: text };
  };
  return typeof target === "string" ? serialize(target, run) : run();
}

export async function pressEnter(target) {
  const session = toSession(target);
  const run = async () => { await session.pressEnter(); return { ok: true }; };
  return typeof target === "string" ? serialize(target, run) : run();
}

export async function shoot(target) {
  const session = toSession(target);
  const run = async () => ({ image: await session.screenshot() });
  return typeof target === "string" ? serialize(target, run) : run();
}

async function clickAction(session, id) {
  const state = await session.current();
  const action = state.actions.find((a) => a.id === id);
  if (!action) throw new Error(`Element ${id} not observed on the current page`);
  return session.act(action);
}

function toSession(target) {
  if (target && typeof target === "object") return target;
  const session = sessions.get(target);
  if (!session) throw new Error(`No open session for profile "${target}"`);
  return session;
}

// Cancellation is a plain flag write — deliberately NOT serialized: a queued
// cancel would only run after the loop it is supposed to stop.
export function requestCancel(profile) {
  const session = sessions.get(profile);
  if (!session) throw new Error(`No open session for profile "${profile}"`);
  session.cancelRequested = true;
  return { profile, cancelRequested: true };
}

export function sessionStatus() {
  return [...sessions.values()].map((s) => ({ profile: s.profile, mode: s.mode, port: s.port }));
}

export { runTask };
