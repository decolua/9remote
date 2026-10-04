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
import { getExtClient } from "./extRelay.js";
import { MARKER_EXPRESSION, SNAPSHOT_EXPRESSION, evaluate } from "./snapshot.js";
import { MAX_ELEMENTS } from "./constants.js";
import {
  ATTACH_GUIDE_STEPS, ATTACH_GUIDE_URL, ATTACH_PROBE_TIMEOUT_MS, BLANK_OBSERVE_MS, EXT_PROFILE, LAUNCH_TIMEOUT_MS, NAV_WAIT_COMMIT_MS, OBSERVE_SETTLE_RETRIES, OBSERVE_SETTLE_RETRY_MS,
  OBSERVE_STALE_RETRIES, SCREENSHOT_FORMAT,
  SCREENSHOT_QUALITY, SETTLE_CAP_MS, SETTLE_MIN_CLICK_MS, SETTLE_MIN_FILL_MS, SETTLE_MIN_HYDRATE_MS, SETTLE_MIN_LINK_MS, SETTLE_MIN_SPA_MS, SETTLE_QUIET_MS,
  STEP_FRAME_QUALITY, STEP_FRAME_SCALE, VIEWPORT, WAIT_TEXT_POLL_MS, WAIT_TEXT_TIMEOUT_MS
} from "./constants.js";
import { runTask } from "./agentLoop.js";

const logger = createLogger("browserUse");

const CHROME_CANDIDATES = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
     "/Applications/Chromium.app/Contents/MacOS/Chromium",
     "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
     "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"]
  : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];

function profilesRoot() {
  return path.join(os.homedir(), ".9remote", "browser-profiles");
}

function safeProfileName(name) {
  return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(String(name || ""));
}

function listProfiles() {
  const root = profilesRoot();
  if (!fs.existsSync(root)) return [{ name: "default" }];
  const found = fs.readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && safeProfileName(d.name))
    .map((d) => ({ name: d.name }));
  return found.some((p) => p.name === "default") ? found : [{ name: "default" }, ...found];
}

function createProfile(name) {
  if (!safeProfileName(name)) throw new Error("Profile name must match [a-z0-9_-], max 32 chars");
  fs.mkdirSync(path.join(profilesRoot(), name), { recursive: true });
  return { name };
}

async function removeProfile(name) {
  if (!safeProfileName(name) || name === "default") throw new Error("Refusing to delete this profile");
  await closeProfile(name);
  fs.rmSync(path.join(profilesRoot(), name), { recursive: true, force: true });
  fs.rmSync(stepFramePath(name), { force: true }); // no orphan debug tail
  return { name, deleted: true };
}

// Per-profile debug tail: ONE overwritten frame of the latest step. Rename on
// the same filesystem is atomic — a concurrent reader never sees a torn jpeg.
function framesRoot() {
  return path.join(os.homedir(), ".9remote", "browserUse", "frames");
}

function stepFramePath(profile) {
  return path.join(framesRoot(), `${profile}.jpg`);
}

function writeAtomic(file, buffer) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, file);
}

// Latest step frame as base64 (null when absent) — the run report reuses this
// instead of capturing a second screenshot after the loop ends.
export function framePathFor({ profile, mode } = {}) {
  const key = mode === "attach" ? ATTACH_PROFILE : mode === "extension" ? EXT_PROFILE : (profile || "default");
  return safeProfileName(key) ? stepFramePath(key) : null;
}

export function readStepFrame(opts = {}) {
  const file = framePathFor(opts);
  if (!file) return null;
  try { return fs.readFileSync(file).toString("base64"); }
  catch { return null; }
}

async function renameProfile(from, to) {
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

// One surface for the socket/UI: profile CRUD.
export const profiles = { list: listProfiles, create: createProfile, remove: removeProfile, rename: renameProfile };

// ---- per-profile serialization ---------------------------------------------
const chains = new Map();
function serialize(profile, fn) {
  const prev = chains.get(profile) || Promise.resolve();
  const run = prev.then(fn, fn);
  chains.set(profile, run.catch(() => {}));
  return run;
}

// ---- Chrome discovery / launch ----------------------------------------------
function resolveChromeBinary() {
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
function findAttachedDevToolsInfo() {
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

// The DevToolsActivePort file outlives a toggle-off until Chrome restarts —
// probe the socket, never trust the file alone. The probe connection is REUSED:
// open/close cycles trip Chrome's debug-WS throttle and fake a "not attached".
let attachProbe = null;

async function attachAlive(info) {
  if (info.wsUrl) {
    if (attachProbe && !attachProbe.closed) return true;
    try {
      attachProbe = await CdpClient.connect(info.wsUrl, ATTACH_PROBE_TIMEOUT_MS);
      return true;
    } catch { attachProbe = null; return false; }
  }
  return new Promise((resolve) => {
    const s = net.connect(info.port, "127.0.0.1");
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
    setTimeout(() => done(false), ATTACH_PROBE_TIMEOUT_MS);
  });
}

export async function attachStatus() {
  const info = findAttachedDevToolsInfo();
  const available = Boolean(info) && await attachAlive(info);
  return { available, port: available ? info.port : null, guide: available ? null : ATTACH_GUIDE_STEPS };
}

// Guide step 1 done for the user: open Chrome straight at the opt-in page.
export function openAttachGuide() {
  const bin = resolveChromeBinary();
  if (!bin) throw new Error("No Chrome/Chromium binary found on this machine");
  // On macOS go through LaunchServices, not a raw spawn: a cold-started binary
  // hits the profile picker which eats the chrome:// URL before any tab opens.
  if (process.platform === "darwin") {
    const app = bin.match(/^(.*?\.app)\//)?.[1];
    const child = spawn("open", ["-a", app || "Google Chrome", ATTACH_GUIDE_URL], { detached: true, stdio: "ignore" });
    child.unref();
    return { opened: ATTACH_GUIDE_URL };
  }
  const child = spawn(bin, [ATTACH_GUIDE_URL], { detached: true, stdio: "ignore" });
  child.unref();
  return { opened: ATTACH_GUIDE_URL };
}

// ---- sessions -----------------------------------------------------------------
export const ATTACH_PROFILE = "__attach__";
export { EXT_PROFILE };
const sessions = new Map(); // profile -> session

export function urlsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try {
    const u1 = new URL(a);
    const u2 = new URL(b);
    const p1 = u1.pathname.replace(/\/+$/, "") || "/";
    const p2 = u2.pathname.replace(/\/+$/, "") || "/";
    return u1.origin === u2.origin && p1 === p2 && u1.search === u2.search;
  } catch {
    return a.trim().replace(/\/+$/, "") === b.trim().replace(/\/+$/, "");
  }
}

// Same site = same origin; a fresh tab Chrome shows before its first navigation.
function urlsSameOrigin(a, b) {
  if (!a || !b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function isBlankTabUrl(url) {
  return !url || url === "about:blank" || /^chrome:\/\/new-tab-page/.test(url);
}

function makeSession({ profile, mode, port, child, client, sessionId, targetId, headless = false, shared = false }) {
  const call = (method, params = {}) => client.call(method, params, session.sessionId);
  const enter = (type) => ({
    type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
  });

  const unsubs = []; // client.on unsubscribe fns — drained in close() (shared clients)

  const session = {
    profile, mode, port, targetId, sessionId, headless, client,
    lastState: null,
    docOrigin: null, docUrl: null,
    cancelRequested: false,
    ownsTargets: new Set(), // tabs the ENGINE created — close() cleans only these
    dialogLog: [],          // auto-dismissed js dialogs (bounded, agent-visible)
    pendingPromptText: null, // one-shot answer armed before a click that triggers window.prompt()
    downloads: new Map(),   // guid -> {filename, path, done, delivered}
    downloadWaiters: [],    // resolvers parked until a download completes
    navReq: null,           // last main-frame nav REQUEST {ts, disposition}
    navCommit: 0,           // ts of the last main-frame navigation commit
    iframes: new Map(),     // OOPIF targetId -> {sessionId, url} (auto-attached)

    async setup() {
      await call("Page.enable");
      await call("DOM.enable"); // uploadFile resolves nodes via DOM.requestNode
      // Cross-origin iframes are separate processes invisible to this session —
      // auto-attach gives each an addressable child session (orca OOPIF pattern).
      await call("Target.setAutoAttach",
        { autoAttach: true, flatten: true, waitForDebuggerOnStart: false });
      // Target discovery (browser level, no session) — feeds the popup adoption
      // below; the extension shim synthesizes the same events from tabs.onCreated.
      await client.call("Target.setDiscoverTargets", { discover: true }).catch(() => {});
      // Route downloads to a per-profile folder the agent can read back from.
      // chrome.debugger exposes no Browser domain — extension mode skips this;
      // its download waits simply time out instead of tracking a file.
      if (mode !== "extension") {
        await client.call("Browser.setDownloadBehavior",
          { behavior: "allow", downloadPath: dlRoot(profile), eventsEnabled: true });
      }
      await call("Emulation.setDeviceMetricsOverride",
        { width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false });
      // Keep background tabs rendering (rAF, menus) without stealing the user's tab.
      await call("Emulation.setFocusEmulationEnabled", { enabled: true });
    },

    async navigate(url) {
      await call("Page.navigate", { url });
      const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (await evaluate(client, session.sessionId, "document.readyState") === "complete") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // Two pages can render identically — never serve the old table after a navigate.
      session.lastState = null;
    },

    // Switch the session onto another tab (attach mode tab discipline).
    async adopt(targetId) {
      if (targetId === session.targetId) return;
      const attached = await client.call("Target.attachToTarget", { targetId, flatten: true });
      session.targetId = targetId;
      session.sessionId = attached.sessionId;
      await session.setup();
      session.lastState = null;
    },

    // Human tab discipline — one tab per site: exact URL refocuses its tab,
    // same-origin reuses that site's tab, a blank held tab gets used, a new
    // site opens a tracked tab. A user's tab on another origin is never hijacked.
    async openOrReuseTab(targetUrl) {
      if (!targetUrl) return;
      try {
        if (session.lastState?.url && urlsMatch(session.lastState.url, targetUrl)) return; // already there
        const { targetInfos = [] } = await client.call("Target.getTargets");
        const pages = targetInfos.filter((t) => t.type === "page");
        const exact = pages.find((t) => urlsMatch(t.url, targetUrl));
        if (exact) {
          await session.adopt(exact.targetId);
          return;
        }
        const sameOrigin = pages.find((t) => urlsSameOrigin(t.url, targetUrl));
        if (sameOrigin) {
          await session.adopt(sameOrigin.targetId);
          await session.navigate(targetUrl);
          return;
        }
        const held = pages.find((t) => t.targetId === session.targetId && isBlankTabUrl(t.url));
        if (held) {
          await session.navigate(targetUrl); // use the blank tab we already hold
          return;
        }
        const target = await client.call("Target.createTarget", { url: targetUrl, background: false });
        session.ownsTargets.add(target.targetId);
        await session.adopt(target.targetId);
        // A fresh target starts at about:blank whose readyState is already
        // "complete" — wait for the target origin to land before trusting it.
        if (!isBlankTabUrl(targetUrl)) {
          const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
          while (Date.now() < deadline) {
            const href = await evaluate(client, session.sessionId, "location.href").catch(() => null);
            if (href && urlsSameOrigin(href, targetUrl) &&
                await evaluate(client, session.sessionId, "document.readyState") === "complete") break;
            await new Promise((r) => setTimeout(r, 50));
          }
        }
      } catch {
        await session.navigate(targetUrl);
      }
    },

    async observe() {
      const blankDeadline = Date.now() + BLANK_OBSERVE_MS;
      let attempts = 0;
      for (;;) {
        let state = null;
        try { state = await evaluate(client, session.sessionId, SNAPSHOT_EXPRESSION); }
        catch (e) {
          if (DEAD_SESSION.test(e.message)) throw e; // dead session — let withSession heal
          state = null; /* document navigating */
        }
        if (state) {
          // A blank page (no text, no real elements) may still be hydrating —
          // retry within a bounded time window, then serve the table as-is: a
          // genuinely quiet-empty page is a valid observation. Scroll/wait
          // controls carry no node, so they do not count (fbu readiness pattern).
          const hasElements = state.actions.some((a) => typeof a.node === "number");
          if (((state.text && state.text.trim()) || hasElements) || Date.now() >= blankDeadline) {
            await mergeIframes(state);
            session.lastState = state;
            if (Array.isArray(state.marker)) {
              session.docOrigin = state.marker[0]; // settle compares against the last observed doc
              session.docUrl = state.marker[1];
            }
            return state;
          }
          await new Promise((r) => setTimeout(r, 60));
          continue; // blank waits are time-boxed, not attempt-boxed
        }
        if (++attempts >= OBSERVE_STALE_RETRIES) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error("Page did not settle for observation");
    },

    // Cached state when the page has not changed since the last snapshot —
    // a cheap marker check instead of a full snapshot on every command.
    async current() {
      if (session.lastState && await session.fresh(session.lastState)) return session.lastState;
      return session.steady();
    },

    // Bounded retry: a page still churning (challenges, late hydration) gets a
    // few quiet windows instead of an error the agent must sleep around.
    async steady() {
      let lastError;
      for (let attempt = 0; attempt < OBSERVE_SETTLE_RETRIES; attempt++) {
        try { return await session.observe(); }
        catch (e) {
          lastError = e;
          if (DEAD_SESSION.test(e.message)) throw e; // dead session — let withSession heal
          await new Promise((r) => setTimeout(r, OBSERVE_SETTLE_RETRY_MS));
        }
      }
      throw lastError;
    },

    async fresh(page) {
      try {
        // Arrays off the wire never compare equal by reference — stringify both.
        if (JSON.stringify(await evaluate(client, session.sessionId, MARKER_EXPRESSION)) !==
            JSON.stringify(page.marker)) return false;
        // Frame-aware freshness: a change INSIDE an iframe leaves the main marker
        // untouched — re-check each recorded frame on its own session.
        for (const frame of page.frames || []) {
          const now = await evaluate(client, frame.sessionId, MARKER_EXPRESSION).catch(() => null);
          if (now === null || JSON.stringify(now) !== JSON.stringify(frame.marker)) return false;
        }
        return true;
      } catch {
        return false;
      }
    },

    // Headed-mode visual feedback: outline the target and glide a virtual cursor
    // to the click point (browser-use style). No-op in headless — nobody watches.
    async decorate(action, point) {
      if (headless) return;
      try {
        await evaluate(client, session.sessionId, `(payload => {
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
      return evaluate(client, action.frame || session.sessionId, `(action => {
        const c = window.__9rFast; if (!c) return null;
        const e = c.nodes.get(action.node);
        if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
            !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
        if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return null;
        // Full-page tables carry below-fold elements — bring the target into the
        // viewport before point-hitting it (orca scrollIntoView pattern).
        const center = (r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
        let r = e.getBoundingClientRect();
        if (!r.width || !r.height) return null;
        let p = center(r);
        if (p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) {
          e.scrollIntoView({ block: 'center', inline: 'center' });
          r = e.getBoundingClientRect();
          p = center(r);
          if (!r.width || !r.height || p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) return null;
        }
        // Occlusion gate across shadow boundaries: elementFromPoint retargets a
        // shadow node to its host chain, and a click can land on slotted light
        // content — accept when e and hit share a composed ancestry either way.
        const hit = document.elementFromPoint(p.x, p.y);
        if (!hit) return null;
        const up = (el) => { const chain = []; let n = el;
          while (n) { chain.push(n); n = n.assignedSlot || n.parentElement || (n.getRootNode()?.host || null); }
          return chain; };
        const hitChain = up(hit);
        if (!e.contains(hit) && !up(e).some((a) => a === hit) && !hitChain.some((n) => n === e || e.contains(n))) return null;
        if (action.kind === 'select') {
          if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === action.value && !o.disabled)) return null;
          e.value = action.value;
          e.dispatchEvent(new Event('input', {bubbles:true}));
          e.dispatchEvent(new Event('change', {bubbles:true}));
        }
        return { x: p.x, y: p.y };
      })(${JSON.stringify({ node: action.node, kind: action.kind, value: action.value })})`);
    },

    // resolve() in the element's own frame, then lift iframe-local points into
    // parent-page coordinates (mouse input dispatches on the main session).
    async pointFor(action) {
      const p = await session.resolve(action);
      if (!p || !action.frame) return p;
      const off = await iframeOffset(action.frame);
      if (!off) throw stale("iframe position unknown — cannot click inside it");
      return { x: p.x + off.x, y: p.y + off.y };
    },

    // Last-resort click: run the click INSIDE the page, bypassing coordinate
    // dispatch and the occlusion gate — for targets an overlay keeps covering.
    // Not a trusted event; most handlers accept it, some will not.
    async jsClick(action) {
      if (typeof action.node !== "number") throw stale("Action does not reference an observed node");
      const ok = await evaluate(client, action.frame || session.sessionId, `(node => {
        const e = window.__9rFast?.nodes.get(node);
        if (!e?.isConnected || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
        e.scrollIntoView({ block: 'center' });
        e.click();
        return true;
      })(${action.node})`);
      if (!ok) throw stale("js-click: element gone or hidden");
      await session.settle(action);
      session.lastState = null;
      return { executed: action.id, via: "js" };
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
      const target = await session.pointFor(action);
      if (!target) throw stale("Target changed or is covered");
      // Fills need no visual feedback — the text itself is the signal. Skipping
      // the cursor glide keeps focus+type at one round trip.
      if (action.kind !== "fill") await session.decorate(action, target);
      if (action.kind !== "select" && action.kind !== "fill") {
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
      await evaluate(client, action.frame || session.sessionId, `(node => {
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
        landed = await evaluate(client, action.frame || session.sessionId, `(node => {
          const e = window.__9rFast?.nodes.get(node); if (!e) return true;
          const v = 'value' in e ? String(e.value) : (e.innerText || '');
          return v.includes(${JSON.stringify(text)});
        })(${action.node})`);
      } catch { /* navigating right after typing — assume it landed */ }
      if (!landed) {
        await evaluate(client, action.frame || session.sessionId, `(node => {
          const e = window.__9rFast?.nodes.get(node); if (e) e.focus();
          document.execCommand('insertText', false, ${JSON.stringify(text)});
        })(${action.node})`);
      }
    },

    async pressEnter() {
      await call("Input.dispatchKeyEvent", enter("keyDown"));
      await call("Input.dispatchKeyEvent", enter("keyUp"));
      // Enter usually submits — a settle here catches the navigation (or not)
      await session.settle();
      session.lastState = null;
    },

    // Park until a download completes (bounded); each completed file is
    // delivered once — a second call waits for the NEXT one.
    async waitDownload(timeoutMs = 15000) {
      const ready = [...session.downloads.values()].find((d) => d.done && !d.delivered);
      if (ready) { ready.delivered = true; return { filename: ready.filename, path: ready.path }; }
      const parked = new Promise((resolve) => session.downloadWaiters.push(resolve));
      const winner = await Promise.race([parked, new Promise((r) => setTimeout(() => r(null), timeoutMs))]);
      if (!winner) return null;
      const next = [...session.downloads.values()].find((d) => d.done && !d.delivered);
      if (!next) return null;
      next.delivered = true;
      return { filename: next.filename, path: next.path };
    },

    // HTML5 drag: press at the source, move in small steps so dragover fires
    // along the way, release over the target.
    async dragTo(fromAction, toAction) {
      const a = await session.pointFor(fromAction);
      const b = await session.pointFor(toAction);
      if (!a || !b) throw stale("Drag source or target changed or is covered");
      await call("Input.dispatchMouseEvent",
        { type: "mousePressed", x: a.x, y: a.y, button: "left", clickCount: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const x = Math.round(a.x + (b.x - a.x) * i / steps);
        const y = Math.round(a.y + (b.y - a.y) * i / steps);
        await call("Input.dispatchMouseEvent",
          { type: "mouseMoved", x, y, button: "left", buttons: 1 });
        await new Promise((r) => setTimeout(r, 16));
      }
      await call("Input.dispatchMouseEvent",
        { type: "mouseReleased", x: b.x, y: b.y, button: "left", clickCount: 1 });
      await session.settle();
      session.lastState = null;
      return { dragged: true };
    },

    // Set a file on an observed input[type=file] without touching the native
    // picker. getDocument first — the DOM agent refuses requestNode without it.
    // CDP fires the change event itself, so page JS reacts normally.
    async uploadFile(action, file) {
      if (typeof action.node !== "number") throw stale("Action does not reference an observed node");
      const fsid = action.frame || session.sessionId;
      const res = await client.call("Runtime.evaluate",
        { expression: `window.__9rFast?.nodes.get(${action.node})` }, fsid);
      const objectId = res?.result?.objectId;
      if (!objectId) throw stale("File input no longer observed");
      await client.call("DOM.getDocument", { depth: -1 }, fsid);
      const { nodeId } = await client.call("DOM.requestNode", { objectId }, fsid);
      if (!nodeId) throw stale("File input node could not be resolved");
      await client.call("DOM.setFileInputFiles", { files: [file], nodeId }, fsid);
      await session.settle();
      session.lastState = null;
      return { uploaded: file };
    },

    // Bounded adaptive settling — wait until the page goes QUIET (unchanged
    // marker for 150ms), with higher minimums after fills (autosuggest debounce)
    // and on freshly-hydrated documents. Capped, never spends a Jev call.
    async settle(action = null) {
      const fillMin = action?.kind === "fill" ? SETTLE_MIN_FILL_MS
        : (action?.kind === "click" || action?.kind === "select")
          ? (action?.role === "link" ? SETTLE_MIN_LINK_MS : SETTLE_MIN_CLICK_MS) : 0;
      const started = Date.now();
      let changedAt = started, prev = null, prevFrame = null, freshDoc = false, spaRoute = false;
      while (Date.now() - started < SETTLE_CAP_MS) {
        let marker = null;
        try { marker = await evaluate(client, session.sessionId, MARKER_EXPRESSION); }
        catch { changedAt = Date.now(); continue; /* navigating mid-wait */ }
        if (Array.isArray(marker)) {
          if (marker[0] !== session.docOrigin) {
            session.docOrigin = marker[0];
            freshDoc = true; // DOMContentLoaded can precede hydration of controls
          } else if (marker[1] !== session.docUrl) {
            spaRoute = true; // same document, new URL — SPA view still mounts
          }
          session.docUrl = marker[1];
          const key = marker.join("\u0001");
          if (prev === null || key !== prev) { prev = key; changedAt = Date.now(); }
        } else {
          changedAt = Date.now();
        }
        // A frame-targeted action can navigate ITS frame while the main marker
        // sits still — quiet requires the frame's marker stable too.
        if (action?.frame) {
          try {
            const fm = await evaluate(client, action.frame, MARKER_EXPRESSION);
            const fk = Array.isArray(fm) ? fm.join("\u0001") : null;
            if (fk === null || fk !== prevFrame) { prevFrame = fk; changedAt = Date.now(); }
          } catch { changedAt = Date.now(); /* frame mid-navigation */ }
        }
        const minMs = Math.max(fillMin, freshDoc ? SETTLE_MIN_HYDRATE_MS : 0,
          spaRoute ? SETTLE_MIN_SPA_MS : 0, SETTLE_QUIET_MS);
        if (Date.now() - changedAt >= SETTLE_QUIET_MS && Date.now() - started >= minMs) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      // Navigation-aware tail: frameRequestedNavigation fires at the CLICK,
      // long before a slow server commits — settle alone would serve the OLD
      // page's table. When a main-frame nav was requested during this settle,
      // wait for the commit and a quiet marker (bounded). newTab/download
      // dispositions never commit the main frame and are skipped.
      const req = session.navReq;
      if (req && !["newTab", "download"].includes(req.disposition) &&
          req.ts >= started - 200 && session.navCommit < req.ts) {
        const deadline = Date.now() + NAV_WAIT_COMMIT_MS;
        let prevKey = null, changedAt = Date.now();
        while (Date.now() < deadline) {
          if (session.navCommit >= req.ts) {
            let marker = null;
            try { marker = await evaluate(client, session.sessionId, MARKER_EXPRESSION); }
            catch { changedAt = Date.now(); await new Promise((r) => setTimeout(r, 50)); continue; }
            const key = Array.isArray(marker) ? marker.join("\u0001") : null;
            if (key === null || key !== prevKey) { prevKey = key; changedAt = Date.now(); }
            if (key !== null && Date.now() - changedAt >= SETTLE_QUIET_MS) break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }
    },

    async screenshot() {
      const result = await call("Page.captureScreenshot",
        { format: SCREENSHOT_FORMAT, quality: SCREENSHOT_QUALITY });
      return result.data; // base64 jpeg
    },

    // Coordinate click — escape hatch for custom widgets the snapshot cannot
    // see (div-role checkboxes, icon steppers). Same input path and settle
    // rules as element clicks.
    async clickPoint(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("clickxy needs numeric x and y");
      for (const type of ["mousePressed", "mouseReleased"]) {
        await call("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      await session.settle();
      session.lastState = null;
      return { clicked: { x, y } };
    },

    async scrollBy(px) {
      if (!Number.isFinite(px) || px === 0) throw new Error("scroll needs a nonzero pixel amount");
      await call("Input.dispatchMouseEvent",
        { type: "mouseWheel", x: 550, y: 650, deltaX: 0, deltaY: px });
      await session.settle();
      session.lastState = null;
      return { scrolled: px };
    },

    async scrollToEdge(edge) {
      if (!["top", "bottom"].includes(edge)) throw new Error(`scroll edge must be top or bottom, got "${edge}"`);
      const height = await evaluate(client, session.sessionId, "document.documentElement.scrollHeight");
      await evaluate(client, session.sessionId, `window.scrollTo(0, ${edge === "top" ? 0 : height})`);
      await session.settle();
      session.lastState = null;
      return { scrolledTo: edge };
    },

    async historyGo(delta) {
      if (![ -1, 1 ].includes(delta)) throw new Error("history only supports back (-1) and forward (1)");
      await evaluate(client, session.sessionId, `history.go(${delta})`);
      await session.settle();
      session.lastState = null;
      return { went: delta };
    },

    async reload() {
      await call("Page.reload");
      await session.settle();
      session.lastState = null;
      return { reloaded: true };
    },

    async sendKey(name) {
      const key = keyEventFor(String(name || ""));
      if (!key) throw new Error(`Unsupported key "${name}" — try ${Object.keys(KEY_EVENTS).join(", ")} or combos like ctrl+a`);
      await call("Input.dispatchKeyEvent", { type: "keyDown", ...key });
      await call("Input.dispatchKeyEvent", { type: "keyUp", ...key });
      await session.settle();
      session.lastState = null;
      return { key: name };
    },

    async hoverById(id) {
      let state = await session.current();
      let action = state.actions.find((a) => a.id === id);
      if (!action) { // the table shifted between the caller's observe and now — one fresh retry
        state = await session.observe();
        action = state.actions.find((a) => a.id === id);
      }
      if (!action) throw new Error(`Element ${id} not observed on the current page`);
      if (typeof action.node !== "number") throw stale("Action does not reference an observed node");
      const point = await session.pointFor(action);
      if (!point) throw stale("Target changed or is covered");
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      await session.settle();
      return { hovered: id };
    },

    // Bounded wait until the text shows up in page text or element labels —
    // the cure for dropdown/suggestion render races after typing.
    async waitText(text, timeoutMs = WAIT_TEXT_TIMEOUT_MS) {
      const needle = String(text || "").toLowerCase();
      if (!needle) throw new Error("wait needs text to look for");
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const state = await session.steady();
        const hay = `${state.text || ""}\n${(state.actions || []).map((a) => a.label).join("\n")}`.toLowerCase();
        if (hay.includes(needle)) return { found: true, state };
        if (Date.now() >= deadline) return { found: false, state };
        await new Promise((r) => setTimeout(r, WAIT_TEXT_POLL_MS));
      }
    },

    // Debug tail for the whole browser this session drives: one small frame of
    // the latest step, overwritten in place. clip+scale does the resize inside
    // Chrome, so no image library is involved.
    async stepFrame() {
      const result = await call("Page.captureScreenshot", {
        format: SCREENSHOT_FORMAT,
        quality: STEP_FRAME_QUALITY,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: STEP_FRAME_SCALE }
      });
      fs.mkdirSync(framesRoot(), { recursive: true });
      writeAtomic(stepFramePath(session.profile), Buffer.from(result.data, "base64"));
    },

    async close() {
      sessions.delete(profile);
      // Shared connections (attach probe, extension relay) outlive the session —
      // its event handlers must not pile up on them across rebuilds.
      for (const off of unsubs) off();
      // Close only what the engine opened — a borrowed (attach) tab is the user's.
      for (const targetId of session.ownsTargets) {
        try { await client.call("Target.closeTarget", { targetId }); } catch { /* already gone */ }
      }
      if (!shared) client.close(); // the shared attach connection outlives one session
      try { child?.kill(); } catch { /* already exited */ }
      // Chrome flushes files while dying — deleting the profile before the real
      // exit races it and dies with ENOTEMPTY on macOS.
      if (child && child.exitCode === null) {
        await new Promise((r) => { child.once("exit", r); setTimeout(r, 3000).unref(); });
      }
    }
  };

  // Snapshot every auto-attached OOPIF and splice its table into the main
  // state: ids continue the parent sequence, each action carries its frame
  // session, and markers append so fresh() sees frame-only changes too.
  async function mergeIframes(state) {
    const inDom = await evaluate(client, session.sessionId,
      "document.querySelectorAll('iframe').length").catch(() => 0);
    if (!inDom) return;
    const deadline = Date.now() + 600; // targets attach async — give them a beat
    while (session.iframes.size < inDom && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 60));
    }
    if (!session.iframes.size) return;
    let seq = state.actions.length;
    for (const info of session.iframes.values()) {
      let child = null;
      try { child = await evaluate(client, info.sessionId, SNAPSHOT_EXPRESSION); }
      catch { continue; /* frame navigating */ }
      if (!child) continue;
      if (child.url) info.url = child.url; // targetInfo.url is "" right after attach
      let host = "iframe";
      try { host = `iframe: ${new URL(info.url).hostname}`; } catch { /* keep */ }
      for (const a of child.actions) {
        if (a.kind === "wait" || a.kind === "scroll") continue; // parent owns controls
        if (state.actions.length >= MAX_ELEMENTS) { state.omitted_actions++; continue; } // choice cap budget
        a.id = `e${++seq}`;
        a.frame = info.sessionId;
        a.path = Array.isArray(a.path) ? [host, ...a.path] : [host];
        if (!a.ctx) a.ctx = host;
        state.actions.push(a);
      }
      state.omitted_actions = (state.omitted_actions || 0) + (child.omitted_actions || 0);
      state.frames = [...(state.frames || []),
        { sessionId: info.sessionId, url: info.url, marker: child.marker }];
      state.contentMarker = [...(state.contentMarker || []), child.contentMarker];
    }
  }

  // Parent-space origin of an iframe session: match its target URL against the
  // <iframe> elements' src (exact first, origin fallback — orca pattern).
  async function iframeOffset(frameSessionId) {
    const [tid, info] = [...session.iframes.entries()].find(([, f]) => f.sessionId === frameSessionId) || [];
    if (!info) return null;
    if (!info.url) {
      try { info.url = (await client.call("Target.getTargetInfo", { targetId: tid })).targetInfo?.url || ""; }
      catch { /* keep empty */ }
    }
    const raw = await evaluate(client, session.sessionId, `JSON.stringify(
      [...document.querySelectorAll('iframe')].map(f => {
        const r = f.getBoundingClientRect();
        return { x: r.x, y: r.y, src: f.src || "" };
      }))`).catch(() => null);
    if (!raw) return null;
    let rects = [];
    try { rects = JSON.parse(raw); } catch { return null; }
    let target = null;
    try { target = new URL(info.url); } catch { return null; }
    const hit = rects.find((r) => { try { return r.src === info.url; } catch { return false; } }) ||
      rects.find((r) => { try { return r.src && new URL(r.src).origin === target.origin; } catch { return false; } });
    return hit ? { x: hit.x, y: hit.y } : null;
  }

  // Popup adoption (orca pattern): a page OUR tab spawned (full-screen chat,
  // window.open, target=_blank) moves the session there, the way a user's
  // focus follows the click — without it the table never changes and the
  // agent re-clicks the opener, spawning duplicate tabs.
  unsubs.push(client.on("Target.targetCreated", (p) => {
    const t = p.targetInfo || {};
    if (t.type !== "page" || t.openerId !== session.targetId) return;
    void session.adopt(t.targetId).catch(() => {});
  }));

  // OOPIF registry: cross-origin iframes get their own CDP session; snapshots
  // and actions route to it, coordinates get offset into parent space.
  unsubs.push(client.on("Target.attachedToTarget", (p, sid) => {
    if (sid !== session.sessionId || p.targetInfo?.type !== "iframe" || !p.sessionId) return;
    session.iframes.set(p.targetInfo.targetId, { sessionId: p.sessionId, url: p.targetInfo.url || "" });
    client.call("Runtime.enable", {}, p.sessionId).catch(() => {});
  }));
  unsubs.push(client.on("Target.detachedFromTarget", (p) => {
    for (const [tid, info] of session.iframes) if (info.sessionId === p.sessionId) session.iframes.delete(tid);
  }));

  // Main-frame navigation bookkeeping: a nav REQUEST fires at click time, the
  // COMMIT only when the server answers — settle() uses both to decide whether
  // to hold past its usual cap instead of serving the old page.
  unsubs.push(client.on("Page.frameRequestedNavigation", (p, sid) => {
    if (sid !== session.sessionId || p.frame?.parentId) return;
    session.navReq = { ts: Date.now(), disposition: p.disposition };
  }));
  unsubs.push(client.on("Page.frameNavigated", (p, sid) => {
    for (const info of session.iframes.values()) {
      if (info.sessionId === sid && p.frame?.url) info.url = p.frame.url; // attach precedes the real src
    }
    if (sid !== session.sessionId || p.frame?.parentId) return;
    session.navCommit = Date.now();
  }));

  // An open js dialog (alert/confirm/prompt) blocks EVERY later CDP command —
  // the loop would wedge with no error. Dismiss on arrival (accept the default
  // button; beforeunload declines so a stray unload cannot navigate away).
  unsubs.push(client.on("Page.javascriptDialogOpening", (dialog, sid) => {
    if (sid !== session.sessionId) return;
    session.dialogLog.push({ type: dialog.type, message: dialog.message ?? "", ts: Date.now() });
    if (session.dialogLog.length > 5) session.dialogLog.shift();
    // A pre-armed answer rides only the FIRST prompt — one-shot, then auto again.
    const promptText = dialog.type === "prompt" ? session.pendingPromptText : null;
    session.pendingPromptText = null;
    client.call("Page.handleJavaScriptDialog", {
      accept: dialog.type !== "beforeunload",
      ...(promptText != null ? { promptText } : {})
    }, sid).catch(() => {});
  }));

  // Download tracking: guid -> completed file path; waitDownload parks callers
  // until one lands. Chrome dedupes clashing names on disk, so the joined path
  // is the first-write name — delivered entries are never re-announced.
  unsubs.push(client.on("Page.downloadWillBegin", (p, sid) => {
    if (sid !== session.sessionId) return;
    session.downloads.set(p.guid, {
      filename: p.suggestedFilename || "download",
      path: path.join(dlRoot(session.profile), p.suggestedFilename || "download"),
      done: false, delivered: false
    });
  }));
  unsubs.push(client.on("Page.downloadProgress", (p, sid) => {
    if (sid !== session.sessionId) return;
    const entry = session.downloads.get(p.guid);
    if (!entry || (p.state !== "completed" && p.state !== "canceled")) return;
    entry.done = p.state === "completed";
    if (entry.done) for (const resolve of session.downloadWaiters.splice(0)) resolve();
  }));

  return session;
}

// Per-profile download folder — user-findable, one level under Downloads.
function dlRoot(profile) {
  const safe = String(profile).replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(os.homedir(), "Downloads", "9remote", safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stale(message) {
  const err = new Error(message);
  err.code = "STALE";
  return err;
}

// Dead-session signatures: the browser WS dropped (Chrome restarted/quit) or the
// target died while the WS lives (user closed the tab in attach mode).
const DEAD_SESSION = /Session with given id|No target with given id|CDP connection closed|Target closed/i;

// The attach session's last tab, persisted so a host restart resumes the SAME
// tab instead of grabbing whatever sits first in the tab strip.
function attachTargetFile() {
  return path.join(os.homedir(), ".9remote", "browserUse", "attach-target");
}

function readRememberedAttachTarget() {
  try { return fs.readFileSync(attachTargetFile(), "utf8").trim() || null; } catch { return null; }
}

function rememberAttachTarget(targetId) {
  try {
    fs.mkdirSync(path.dirname(attachTargetFile()), { recursive: true });
    fs.writeFileSync(attachTargetFile(), targetId);
  } catch { /* advisory only */ }
}

// Named keys the engine can send (extend on demand — CDP key codes).
const KEY_EVENTS = {
  enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
  escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 }
};

// CDP modifier bit flags; "cmd" aliases meta for macOS muscle memory.
const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

// Resolve a key spec: a named key ("enter"), a single char ("a"), or a combo
// ("ctrl+a", "meta+c", "shift+arrowright"). Modifier flags ride the same event.
export function keyEventFor(spec) {
  const parts = String(spec).toLowerCase().split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const keyName = parts[parts.length - 1];
  const named = KEY_EVENTS[keyName];
  const single = !named && keyName.length === 1 ? {
    key: keyName, code: `Key${keyName.toUpperCase()}`,
    windowsVirtualKeyCode: keyName.toUpperCase().charCodeAt(0),
    nativeVirtualKeyCode: keyName.toUpperCase().charCodeAt(0)
  } : null;
  const base = named || single;
  if (!base) return null;
  const modifiers = parts.slice(0, -1).reduce((bits, mod) => bits | (MODIFIER_BITS[mod] ?? 0), 0);
  return modifiers ? { ...base, modifiers } : base;
}

async function dropSession(session) {
  try { await session.close(); } catch { /* already dead */ }
}

// Open (or reuse) a session for a profile. Serialized per profile. Self-healing:
// a session whose browser/tab died is dropped and relaunched ONCE, so a Chrome
// restart or a closed tab never wedges every later command until host restart.
export async function withSession(options = {}, fn) {
  const mode = options.mode === "attach" || options.mode === "extension" ? options.mode : "own";
  const profile = mode === "attach" ? ATTACH_PROFILE : mode === "extension" ? EXT_PROFILE : (options.profile || "default");
  return serialize(profile, async () => {
    let existing = sessions.get(profile);
    // Dead WS or a settings mode switch: the old browser no longer matches.
    if (existing?.client?.closed || (existing && options.mode && existing.mode !== options.mode)) {
      await dropSession(existing);
      existing = null;
    }
    let session = existing || await launchSession({ ...options, profile });
    const runWith = async (s) => {
      // One tab per site in BOTH modes (see openOrReuseTab); an identical URL
      // is a no-op, so re-opening never resets a live observation.
      if (options.url) await s.openOrReuseTab(options.url);
      return fn(s);
    };
    try {
      return await runWith(session);
    } catch (e) {
      if (!existing || !DEAD_SESSION.test(e.message)) throw e;
      await dropSession(session);
      session = await launchSession({ ...options, profile });
      return runWith(session);
    }
  });
}

async function launchSession({ profile = "default", url, mode = "own", attachPort = null, headless = false }) {
  let port;
  let child = null;
  let bin = null;
  const stderrTail = [];
  let attachWsUrl = null;
  if (mode === "extension") {
    if (!getExtClient()) throw new Error("Browser extension not connected — install it from Settings → Browser");
  } else if (mode === "attach") {
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
      `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
      "about:blank" // startup tab we can see immediately — an NTP can race past the cleanup
    ];
    if (headless) args.push("--headless=new");
    child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    child.on("error", () => {}); // surfaced by waitForDevTools instead
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", (d) => { stderrTail.push(d); if (stderrTail.length > 30) stderrTail.shift(); });
  }
  let client;
  try {
    if (mode === "extension") {
      client = getExtClient(); // checked above — still connected
    } else if (attachWsUrl) {
      // Attached browsers skip the /json HTTP API (newer Chrome doesn't serve it) —
      // connect straight to the WS path from DevToolsActivePort. Chrome serves ONE
      // browser-level debug WS: reuse the probe connection, never open a second.
      if (!attachProbe || attachProbe.closed) attachProbe = await CdpClient.connect(attachWsUrl, ATTACH_PROBE_TIMEOUT_MS);
      client = attachProbe;
    } else {
      const info = await waitForDevTools(port, LAUNCH_TIMEOUT_MS);
      client = await CdpClient.connect(info.webSocketDebuggerUrl);
    }
  } catch (e) {
    child?.kill();
    const stderr = (stderrTail.join("") || "").slice(-400).replace(/\n/g, " | ");
    throw new Error(`${e.message} (chrome exitCode=${child?.exitCode ?? "n/a"} bin=${bin} stderr=${stderr || "none"})`);
  }
  try {
    let targetId;
    let created = false;
    if (mode !== "own") { // real-browser modes share the same tab discipline
      const { targetInfos = [] } = await client.call("Target.getTargets").catch(() => ({ targetInfos: [] }));
      const pageTargets = targetInfos.filter((t) => t.type === "page");
      const matched = url ? pageTargets.find((t) => urlsMatch(t.url, url)) : null;
      if (matched) {
        targetId = matched.targetId;
      } else if (!url) {
        // A reborn attach session (host restart) returns to the tab it drove
        // last time — falling back to the first tab drives the wrong page.
        const remembered = readRememberedAttachTarget();
        const alive = remembered && pageTargets.find((t) => t.targetId === remembered);
        targetId = (alive || pageTargets[0] || {}).targetId;
        if (!targetId) {
          const target = await client.call("Target.createTarget", { url: "about:blank", background: false });
          targetId = target.targetId;
          created = true;
        }
      } else {
        const target = await client.call("Target.createTarget", { url: url || "about:blank", background: false });
        targetId = target.targetId;
        created = true;
      }
    } else {
      const target = await client.call("Target.createTarget", { url: "about:blank", background: true });
      targetId = target.targetId;
      created = true;
      // Chrome's own startup tab rides along on a fresh profile — own mode
      // starts clean with exactly one tab; every tab here is engine territory.
      const { targetInfos = [] } = await client.call("Target.getTargets").catch(() => ({ targetInfos: [] }));
      for (const t of targetInfos) {
        if (t.type === "page" && t.targetId !== targetId) {
          try { await client.call("Target.closeTarget", { targetId: t.targetId }); } catch { /* already gone */ }
        }
      }
    }
    const attached = await client.call("Target.attachToTarget", { targetId, flatten: true });
    const session = makeSession({
      profile, mode, port, child, client, sessionId: attached.sessionId, targetId, headless,
      shared: mode !== "own" // a borrowed browser outlives every session
    });
    if (created) session.ownsTargets.add(targetId);
    await session.setup();
    if (mode !== "own") {
      rememberAttachTarget(targetId);
      try { await client.call("Page.bringToFront", {}, attached.sessionId); } catch { /* ignore */ }
    }
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

export async function clickById(target, id, { promptText } = {}) {
  const session = toSession(target);
  const run = () => {
    // Armed BEFORE the click: a window.prompt() this click triggers is a native
    // dialog (no DOM, not in the table) — this is the only way to answer it.
    session.pendingPromptText = typeof promptText === "string" ? promptText : null;
    return clickAction(session, id);
  };
  return typeof target === "string" ? serialize(target, run) : run();
}

export async function typeById(target, id, text, { enter = false } = {}) {
  const session = toSession(target);
  const run = async () => {
    let state = await session.current();
    let action = state.actions.find((a) => a.id === id && a.kind === "fill");
    if (!action) { // the table shifted between the caller's observe and now — one retry
      state = await session.observe();
      action = state.actions.find((a) => a.id === id && a.kind === "fill");
    }
    if (!action) throw new Error(`Field ${id} not observed (or not editable)`);
    await session.act(action, text);
    if (enter) await session.pressEnter(); // same serialized hop — one round trip
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

export async function listTabs(options = {}) {
  return withSession(options, async (session) => {
    try {
      const { targetInfos = [] } = await session.client.call("Target.getTargets");
      return targetInfos
        .filter((t) => t.type === "page")
        .map((t) => ({ id: t.targetId, title: t.title, url: t.url, active: t.targetId === session.targetId }));
    } catch {
      return [];
    }
  });
}

async function pageTargets(session) {
  const { targetInfos = [] } = await session.client.call("Target.getTargets");
  return targetInfos.filter((t) => t.type === "page");
}

// Switch the session onto tab #n (1-based, the order `tabs` prints).
export async function switchTab(options, index) {
  return withSession(options, async (session) => {
    const pages = await pageTargets(session);
    const target = pages[index - 1];
    if (!target) throw new Error(`No tab #${index} — ${pages.length} open`);
    await session.adopt(target.targetId);
    try { await session.client.call("Page.bringToFront", {}, session.sessionId); } catch { /* ignore */ }
    return { ok: true, url: target.url, title: target.title };
  });
}

// Close one tab: the active one, or #n when asked. Another tab is only
// closable when the engine opened it — the user's tabs stay theirs.
export async function closeTab(options, index = null) {
  return withSession(options, async (session) => {
    const pages = await pageTargets(session);
    const target = index ? pages[index - 1] : pages.find((t) => t.targetId === session.targetId);
    if (!target) throw new Error(`No tab #${index || ""}`);
    const isActive = target.targetId === session.targetId;
    if (!isActive && !session.ownsTargets.has(target.targetId)) {
      throw new Error(`Refusing to close tab #${index} — engine-opened or active tabs only`);
    }
    await session.client.call("Target.closeTarget", { targetId: target.targetId });
    session.ownsTargets.delete(target.targetId);
    if (isActive) {
      const rest = pages.filter((p) => p.targetId !== target.targetId);
      if (rest.length) await session.adopt(rest[0].targetId); // keep the session alive on a neighbour
      else sessions.delete(session.profile); // nothing left — next command relaunches
    }
    return { ok: true, closed: target.url };
  });
}

export function sessionStatus() {
  return [...sessions.values()].map((s) => ({ profile: s.profile, mode: s.mode, port: s.port }));
}

export { runTask };
