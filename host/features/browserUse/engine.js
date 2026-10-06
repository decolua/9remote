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
import { MARKER_EXPRESSION, SNAPSHOT_EXPRESSION, evaluate, readExpression, snapshotExpression, stableDomExpression } from "./snapshot.js";
import { MAX_ELEMENTS } from "./constants.js";
import {
  ATTACH_GUIDE_STEPS, ATTACH_GUIDE_URL, ATTACH_PROBE_TIMEOUT_MS, BLANK_OBSERVE_MS, CONSOLE_BUFFER_MAX, CONSOLE_TEXT_CAP, EXT_PROFILE, LAUNCH_TIMEOUT_MS, NAV_WAIT_COMMIT_MS, OBSERVE_SETTLE_RETRIES, OBSERVE_SETTLE_RETRY_MS,
  OBSERVE_STALE_RETRIES, SCREENSHOT_FORMAT, SETTLE_POLL_MS,
  FILL_BONUS_MAX_CHARS, FILL_MS_PER_CHAR, IFRAME_ATTACH_CAP_MS, IFRAME_FRAME_CAP_MS, OBSERVE_IFRAME_CAP_MS,
  OBSERVE_IFRAME_MIN_MS,
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

function makeSession({ profile, sessionKey = null, mode, port, child, client, sessionId, targetId, headless = false, shared = false }) {
  const call = (method, params = {}) => client.call(method, params, session.sessionId);
  const enter = (type) => ({
    type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
  });

  const unsubs = []; // client.on unsubscribe fns — drained in close() (shared clients)

  const session = {
    profile, sessionKey, mode, port, targetId, sessionId, headless, client,
    lastState: null,
    docOrigin: null, docUrl: null,
    cancelRequested: false,
    ownsTargets: new Set(), // tabs the ENGINE created — close() cleans only these
    tabOrder: [],           // stable targetId order across getTargets calls
    dialogLog: [],          // auto-dismissed js dialogs (bounded, agent-visible)
    pendingPromptText: null, // one-shot answer armed before a click that triggers window.prompt()
    downloads: new Map(),   // guid -> {filename, path, done, delivered}
    downloadWaiters: [],    // resolvers parked until a download completes
    navReq: null,           // last main-frame nav REQUEST {ts, disposition}
    navCommit: 0,           // ts of the last main-frame navigation commit
    iframes: new Map(),     // OOPIF targetId -> {sessionId, url} (auto-attached)
    consoleLog: [],         // console ring — the "why did nothing happen" signal

    async setup() {
      await call("Page.enable");
      await call("DOM.enable"); // uploadFile resolves nodes via DOM.requestNode
      await call("Runtime.enable"); // console + exception events for the ring
      await call("Log.enable").catch(() => {}); // network/script errors; absent in some modes
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

    // Markdown-lite content read for the `read` op — scoped to a named tree
    // section when parent is given (same vocabulary as run's --parent). from/len
    // window past the default cap on long pages.
    async readSection(parent = null, from = 0, len = null) {
      const result = await evaluate(client, session.sessionId, readExpression(parent, from, len));
      if (result?.error) {
        throw new Error(`No section matches "${parent}". Available: ${(result.sections || []).join(", ")}`);
      }
      return result;
    },

    // Switch the session onto another tab (attach mode tab discipline).
    async adopt(targetId) {
      if (targetId === session.targetId) return;
      const attached = await client.call("Target.attachToTarget", { targetId, flatten: true });
      session.targetId = targetId;
      session.sessionId = attached.sessionId;
      // The old tab's OOPIF targets are not ours anymore — leaving them pooled
      // lets mergeIframes stitch the PREVIOUS page's rows into this tab's table.
      session.iframes.clear();
      await session.setup();
      session.lastState = null;
      await session.stampTitle().catch(() => {});
    },

    async switchTab(selector) {
      const pages = await pageTargets(session);
      const target = resolveTab(pages, selector);
      const idx = pages.findIndex((p) => p.targetId === target.targetId) + 1;
      await session.adopt(target.targetId);
      try { await client.call("Page.bringToFront", {}, session.sessionId); } catch { /* ignore */ }
      await session.stampTitle().catch(() => {});
      const nowState = await session.current();
      return { ok: true, index: idx, id: target.targetId, url: nowState.url || target.url, title: formatStampedTitle(idx, target.title) };
    },

    async stampTitle() {
      // Own mode keeps the REAL page title — tests and agents read it as page
      // state. Only a browser the user is watching (extension/attach) gets the
      // 🚀 [N] marker; `tabs` renders the prefix display-only there.
      if (session.mode === "own") return;
      try {
        const pages = await pageTargets(session);
        const idx = pages.findIndex((p) => p.targetId === session.targetId);
        if (idx >= 0) {
          const tabNum = idx + 1;
          await evaluate(client, session.sessionId, `(() => {
            const raw = document.title || '';
            const clean = raw.replace(/^🚀\\s*\\[\\d+\\]\\s*/, '').trim();
            document.title = clean ? ('🚀 [' + ${tabNum} + '] ' + clean) : ('🚀 [' + ${tabNum} + ']');
          })()`);
        }
      } catch { /* ignore */ }
    },

    // Working tab management: reuse existing tab if targetUrl matches, navigate
    // current tab if open, or spawn a fresh tab if none or newTab requested.
    async openOrReuseTab(targetUrl, { newTab = false } = {}) {
      if (!targetUrl) return;
      try {
        // An identical re-open is a no-op — never reset a live observation.
        if (!newTab && session.lastState?.url && urlsMatch(session.lastState.url, targetUrl)) {
          await session.stampTitle().catch(() => {});
          return;
        }
        const pages = await pageTargets(session);
        if (!newTab) {
          // Only a session WITHOUT a working tab may adopt a same-url tab —
          // stateful pages (wizards, tests) must never swap onto a stale twin.
          const mine = pages.filter((t) => session.ownsTargets.has(t.targetId));
          if (!mine.length) {
            const other = pages.find((t) => t.targetId !== session.targetId && urlsMatch(t.url, targetUrl));
            if (other) {
              await session.adopt(other.targetId);
              await session.stampTitle().catch(() => {});
              return;
            }
          }
          const work = mine.find((t) => t.targetId === session.targetId) || mine[0];
          if (work) {
            if (work.targetId !== session.targetId) await session.adopt(work.targetId);
            await session.navigate(targetUrl);
            await session.stampTitle().catch(() => {});
            return;
          }
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
        await session.stampTitle().catch(() => {});
      } catch {
        await session.navigate(targetUrl);
        await session.stampTitle().catch(() => {});
      }
    },

    // Windowed one-shot table read (the `ls` op): bakes from/len into the
    // snapshot expression. observe() keeps the historical default window.
    async listState(win = {}) {
      const state = await evaluate(client, session.sessionId, snapshotExpression(win));
      await mergeIframes(state);
      return state;
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
        const frameEl = e.ownerDocument !== document ? e.ownerDocument.defaultView?.frameElement : null;
        const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        let r = e.getBoundingClientRect();
        if (frameEl) {
          const fr = frameEl.getBoundingClientRect();
          r = { x: fr.x + r.x, y: fr.y + r.y, width: r.width, height: r.height };
        }
        if (!r.width || !r.height) return null;
        let p = center(r);
        if (p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) {
          e.scrollIntoView({ block: 'center', inline: 'center' });
          r = e.getBoundingClientRect();
          if (frameEl) {
            const fr = frameEl.getBoundingClientRect();
            r = { x: fr.x + r.x, y: fr.y + r.y, width: r.width, height: r.height };
          }
          p = center(r);
          if (!r.width || !r.height || p.x < 0 || p.y < 0 || p.x >= innerWidth || p.y >= innerHeight) return null;
        }
        // Occlusion gate across shadow boundaries: elementFromPoint retargets a
        // shadow node to its host chain, and a click can land on slotted light
        // content — accept when e and hit share a composed ancestry either way.
        // Fills focus directly (no mouse click), so bypass occlusion gate.
        if (action.kind !== 'fill') {
          const hit = document.elementFromPoint(p.x, p.y);
          if (!hit) return null;
          const up = (el) => { const chain = []; let n = el;
            while (n) { chain.push(n); n = n.assignedSlot || n.parentElement || (n.getRootNode()?.host || null); }
            return chain; };
          const hitChain = up(hit);
          const isHit = e.contains(hit) || up(e).some((a) => a === hit) || hitChain.some((n) => n === e || e.contains(n)) ||
            (frameEl && (hit === frameEl || frameEl.contains(hit) || hit.contains(frameEl)));
          if (!isHit) return null;
        }
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
    // One fast scroll hop for the burst loop: scroll instantly, then a tiny
    // evaluate checks the needles against VIEWPORT-VISIBLE text only (full
    // innerText would match content far below the fold) — ~30ms vs ~1s per hop.
    async scrollBurstStep(delta, needles) {
      const r = await evaluate(client, session.sessionId, `(n => {
        window.scrollBy({ top: ${Number(delta) || 0}, left: 0, behavior: 'instant' });
        const vis = [];
        const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = w.nextNode()) && vis.length < 400) {
          const range = document.createRange();
          range.selectNodeContents(node);
          const b = range.getBoundingClientRect();
          if (b.bottom >= 0 && b.top <= window.innerHeight && b.width > 0) vis.push(node.textContent);
        }
        const t = vis.join("\\n");
        return { y: Math.round(window.scrollY), hit: n.length > 0 && n.every((s) => t.includes(s)) };
      })(${JSON.stringify(needles.map(String))})`);
      session.lastState = null;
      return r ?? { y: 0, hit: false };
    },

    // Scroll so document-absolute Y lands mid-viewport (same centering as
    // scrollIntoView) — the coordinate primitive behind every scroll form.
    async scrollToY(y) {
      const target = Math.max(0, Math.floor(Number(y) || 0));
      await evaluate(client, session.sessionId,
        `window.scrollTo({ top: Math.max(0, ${target} - Math.round(window.innerHeight / 2)), left: 0, behavior: 'instant' })`);
      await session.settle();
      session.lastState = null;
      return { scrolledTo: target };
    },

    // Center a snapshot element in view — scrollIntoView walks nested scroll
    // containers (modal bodies, chat lists), not just the document.
    async scrollToAction(action) {
      if (typeof action.node !== "number") throw stale("Action does not reference an observed node");
      const ok = await evaluate(client, action.frame || session.sessionId, `(node => {
        const e = window.__9rFast?.nodes.get(node);
        if (!e?.isConnected) return false;
        e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        return true;
      })(${action.node})`);
      if (!ok) throw stale("scroll-to: element gone");
      await session.settle();
      session.lastState = null;
      return { scrolledTo: action.id };
    },

    // Scroll to an in-DOM text node (even inside nested scroll containers) via scrollIntoView.
    async scrollToText(needle) {
      const ok = await evaluate(client, session.sessionId, `(needle => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        const lower = needle.toLowerCase();
        while ((node = walker.nextNode())) {
          if (node.textContent.toLowerCase().includes(lower)) {
            const el = node.parentElement;
            if (el && el.isConnected) {
              el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
              return true;
            }
          }
        }
        return false;
      })(${JSON.stringify(needle)})`);
      if (ok) {
        await session.settle();
        session.lastState = null;
        return { found: true };
      }
      return { found: false };
    },

    // Whole burst in ONE evaluate: an in-page loop hops until the needle shows
    // in viewport text or the page bottoms out (3s page-side cap). Returns
    // where it landed so the caller can decide found vs end-of-page.
    async scrollBurstTo(needles) {
      const r = await evaluate(client, session.sessionId, `(n => new Promise(resolve => {
        const step = Math.max(400, Math.round(window.innerHeight * 0.85));
        const t0 = performance.now();
        const visibleText = () => {
          const vis = [];
          const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = w.nextNode()) && vis.length < 400) {
            const range = document.createRange();
            range.selectNodeContents(node);
            const b = range.getBoundingClientRect();
            if (b.bottom >= 0 && b.top <= window.innerHeight && b.width > 0) vis.push(node.textContent);
          }
          return vis.join("\\n");
        };
        let hops = 0;
        const hop = () => {
          if (hops >= 60 || performance.now() - t0 > 3000) return resolve({ found: false, hops, y: Math.round(window.scrollY) });
          const before = Math.round(window.scrollY);
          window.scrollBy({ top: step, left: 0, behavior: 'instant' });
          hops++;
          if (Math.round(window.scrollY) === before && hops > 1) return resolve({ found: false, hops, y: before, bottom: true });
          const t = visibleText();
          if (n.length && n.every((s) => t.includes(s))) return resolve({ found: true, hops, y: Math.round(window.scrollY) });
          setTimeout(hop, 0);
        };
        hop();
      }))(${JSON.stringify((Array.isArray(needles) ? needles : [needles]).map(String))})`, { awaitPromise: true, timeoutMs: 8000 });
      session.lastState = null;
      return r ?? { found: false, hops: 0, y: 0 };
    },

    async jsClick(action, { nowait = false } = {}) {
      if (typeof action.node !== "number") throw stale("Action does not reference an observed node");
      const ok = await evaluate(client, action.frame || session.sessionId, `(node => {
        const e = window.__9rFast?.nodes.get(node);
        if (!e?.isConnected || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;
        e.scrollIntoView({ block: 'center' });
        e.click();
        return true;
      })(${action.node})`);
      if (!ok) throw stale("js-click: element gone or hidden");
      if (!nowait) await session.settle(action);
      session.lastState = null;
      return { executed: action.id, via: "js" };
    },

    async act(action, text = null, { nowait = false } = {}) {
      const seenDialogs = session.dialogLog.length;
      if (action.kind === "wait") {
        await new Promise((r) => setTimeout(r, 100));
        return { executed: action.id };
      }
      if (action.kind === "scroll") {
        await evaluate(client, session.sessionId, `window.scrollBy({ top: ${action.delta || 0}, left: 0, behavior: 'instant' })`);
        if (nowait) { session.lastState = null; return { executed: action.id }; }
        await session.settle();
        return { executed: action.id };
      }
      // Chrome swallows default actions (anchor navigation!) on background tabs —
      // surface the tab first so the click lands where the user can see it.
      if (mode !== "own") await call("Page.bringToFront", {}, session.sessionId).catch(() => {});
      // Anchor clicks navigate via the default action, which a physical CDP
      // click unreliably triggers (background tabs, overlays). A JS .click()
      // fires navigation deterministically — same result, no missed clicks.
      if (action.kind === "click" && (action.role === "link" || action.tag === "a")) {
        return await session.jsClick(action, { nowait });
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
      if (nowait) { session.lastState = null; return { executed: action.id }; }
      await session.settle(action, text);
      // A js dialog this action opened (auto-dismissed) rides the result —
      // a native prompt is invisible in the DOM table, this is the agent's
      // only signal it should re-click with an armed answer.
      const dialogs = session.dialogLog.slice(seenDialogs);
      return { executed: action.id, ...(dialogs.length ? { dialog: dialogs[dialogs.length - 1] } : {}) };
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

    // Bounded adaptive settling — wait until the page goes QUIET. The quiet
    // window is an in-page MutationObserver (chrome-devtools-mcp pattern): the
    // page signals quiescence itself, so settling costs zero marker polls that
    // steal the page's main thread. Floors keep their domain meaning (autosuggest
    // debounce after fills, hydration grace, late SPA mounts).
    async settle(action = null, text = null) {
      const fillMin = action?.kind === "fill"
        ? SETTLE_MIN_FILL_MS + FILL_MS_PER_CHAR * Math.min((text ?? "").length, FILL_BONUS_MAX_CHARS)
        : (action?.kind === "click" || action?.kind === "select")
          ? (action?.role === "link" ? SETTLE_MIN_LINK_MS : SETTLE_MIN_CLICK_MS) : 0;
      const started = Date.now();
      // One marker read classifies the document (fresh doc vs SPA route) — the
      // quiet wait itself no longer polls the marker.
      let freshDoc = false, spaRoute = false;
      try {
        const marker = await evaluate(client, session.sessionId, MARKER_EXPRESSION);
        if (Array.isArray(marker)) {
          if (marker[0] !== session.docOrigin) {
            session.docOrigin = marker[0];
            freshDoc = true; // DOMContentLoaded can precede hydration of controls
          } else if (marker[1] !== session.docUrl) {
            spaRoute = true; // same document, new URL — SPA view still mounts
          }
          session.docUrl = marker[1];
        }
      } catch { /* navigating right after the action — the retry loop below holds */ }
      const minMs = Math.max(fillMin, freshDoc ? SETTLE_MIN_HYDRATE_MS : 0,
        spaRoute ? SETTLE_MIN_SPA_MS : 0, SETTLE_QUIET_MS);
      while (Date.now() - started < SETTLE_CAP_MS) {
        const capLeft = Math.max(50, started + SETTLE_CAP_MS - Date.now());
        try {
          await evaluate(client, session.sessionId, stableDomExpression(SETTLE_QUIET_MS, minMs, capLeft),
            { awaitPromise: true, timeoutMs: capLeft + 500 });
          break;
        } catch { /* context destroyed mid-wait (navigation) — retry until the cap */ }
      }
      // A frame-targeted action can navigate ITS frame while the main document
      // sits still — quiet requires the frame quiet too.
      if (action?.frame) {
        try {
          const capLeft = Math.max(50, started + SETTLE_CAP_MS - Date.now());
          await evaluate(client, action.frame, stableDomExpression(SETTLE_QUIET_MS, 0, capLeft),
            { awaitPromise: true, timeoutMs: capLeft + 500 });
        } catch { /* frame mid-navigation — the nav tail bounds the wait */ }
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
            catch { changedAt = Date.now(); await new Promise((r) => setTimeout(r, SETTLE_POLL_MS)); continue; }
            const key = Array.isArray(marker) ? marker.join("\u0001") : null;
            if (key === null || key !== prevKey) { prevKey = key; changedAt = Date.now(); }
            if (key !== null && Date.now() - changedAt >= SETTLE_QUIET_MS) break;
          }
          await new Promise((r) => setTimeout(r, SETTLE_POLL_MS));
        }
      }
    },

    async screenshot() {
      const result = await call("Page.captureScreenshot",
        { format: SCREENSHOT_FORMAT, quality: SCREENSHOT_QUALITY, optimizeForSpeed: true });
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

    async scrollBy(directionOrPx) {
      if (typeof directionOrPx === "string") {
        const sign = directionOrPx === "up" ? -1 : 1;
        await evaluate(client, session.sessionId, `window.scrollBy({ top: Math.round(window.innerHeight * 0.85 * ${sign}), left: 0, behavior: 'instant' })`);
      } else {
        const px = Number(directionOrPx);
        if (!Number.isFinite(px) || px === 0) throw new Error("scroll needs a nonzero pixel amount or direction");
        await evaluate(client, session.sessionId, `window.scrollBy({ top: ${px}, left: 0, behavior: 'instant' })`);
      }
      await session.settle();
      session.lastState = null;
      return { scrolled: directionOrPx };
    },

    async scrollToEdge(edge) {
      if (!["top", "bottom"].includes(edge)) throw new Error(`scroll edge must be top or bottom, got "${edge}"`);
      const height = await evaluate(client, session.sessionId, "document.documentElement.scrollHeight");
      await evaluate(client, session.sessionId, `window.scrollTo({ top: ${edge === "top" ? 0 : height}, left: 0, behavior: 'instant' })`);
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
      let action = state.actions.find((a) => matchActionId(a, id));
      if (!action) { // the table shifted between the caller's observe and now — one fresh retry
        state = await session.observe();
        action = state.actions.find((a) => matchActionId(a, id));
      }
      if (!action) throw new Error(`Element ${id} not observed on the current page`);
      await session.hoverAction(action);
      return { hovered: id };
    },

    // Shared by single hover and the chain hover step — resolve already done.
    async hoverAction(action) {
      if (typeof action.node !== "number") throw stale("Action does not reference an observed node");
      const point = await session.pointFor(action);
      if (!point) throw stale("Target changed or is covered");
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
      await session.settle();
      return { hovered: action.id };
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
      // Debug tail only on the engine's own Chrome — captureScreenshot forces
      // a compositor frame and visibly flashes a real (extension/attach) browser.
      if (mode !== "own") return;
      const result = await call("Page.captureScreenshot", {
        format: SCREENSHOT_FORMAT,
        quality: STEP_FRAME_QUALITY,
        optimizeForSpeed: true,
        clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height, scale: STEP_FRAME_SCALE }
      });
      fs.mkdirSync(framesRoot(), { recursive: true });
      writeAtomic(stepFramePath(session.profile), Buffer.from(result.data, "base64"));
    },

    async close() {
      sessions.delete(sessionKey || profile);
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
  // state: ids are frame-scoped (stable across main-list shifts), each action
  // carries its frame session, and markers append so fresh() sees frame-only
  // changes too.
  // Correctness over speed on iframe pages: GIS-style frames are INSERTED
  // seconds after the parent settled and paint their buttons AFTER load —
  // so re-quiet the parent, give targets time to attach, and settle each
  // frame's own DOM before snapshotting it.
  async function mergeIframes(state) {
    // Re-quiet BEFORE counting frames, with a grace floor: a GIS-style iframe
    // is INSERTED up to seconds after the parent settled — quiet alone resolves
    // in 150ms on a still page and would miss the frame entirely. Correctness
    // over speed: every observe on this page pays the floor once.
    try {
      await evaluate(client, session.sessionId,
        stableDomExpression(SETTLE_QUIET_MS, OBSERVE_IFRAME_MIN_MS, OBSERVE_IFRAME_CAP_MS),
        { awaitPromise: true, timeoutMs: OBSERVE_IFRAME_CAP_MS + 500 });
    } catch { /* navigating — snapshot what is there */ }
    const inDom = await evaluate(client, session.sessionId,
      "document.querySelectorAll('iframe').length").catch(() => 0);
    if (!inDom) return;
    const deadline = Date.now() + IFRAME_ATTACH_CAP_MS; // targets attach async
    while (session.iframes.size < inDom && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 60));
    }
    if (!session.iframes.size) return;
    let frameNo = 0;
    for (const info of session.iframes.values()) {
      frameNo++;
      // Frame-scoped counter: ids stay stable when the MAIN list shifts (the
      // old `${mainLength + n}` scheme renumbered on every insert above).
      let childSeq = 0;
      try {
        await evaluate(client, info.sessionId,
          stableDomExpression(SETTLE_QUIET_MS, 0, IFRAME_FRAME_CAP_MS),
          { awaitPromise: true, timeoutMs: IFRAME_FRAME_CAP_MS + 500 });
      } catch { /* frame navigating — snapshot whatever is there */ }
      let child = null;
      try { child = await evaluate(client, info.sessionId, SNAPSHOT_EXPRESSION); }
      catch { continue; /* frame navigating */ }
      if (!child) continue;
      if (child.url) info.url = child.url; // targetInfo.url is "" right after attach
      let host = "iframe";
      try { host = `iframe: ${new URL(info.url).hostname}`; } catch { /* keep */ }
      const off = await iframeOffset(info.sessionId);
      for (const a of child.actions) {
        if (a.kind === "wait" || a.kind === "scroll") continue; // parent owns controls
        if (state.actions.length >= MAX_ELEMENTS) { state.omitted_actions++; continue; } // choice cap budget
        a.id = `${a.pfx || 'ifr'}f${frameNo}_${++childSeq}`;
        a.frame = info.sessionId;
        if (off && a.rect) {
          a.rect = { x: Math.round(a.rect.x + off.x), y: Math.round(a.rect.y + off.y), w: a.rect.w, h: a.rect.h };
        }
        a.path = Array.isArray(a.path) ? [host, ...a.path] : [host];
        if (!a.ctx) a.ctx = host;
        state.actions.push(a);
      }
      state.omitted_actions = (state.omitted_actions || 0) + (child.omitted_actions || 0);
      state.frames = [...(state.frames || []),
        { sessionId: info.sessionId, url: info.url, marker: child.marker }];
      state.contentMarker = [...(state.contentMarker || []), child.contentMarker];
    }
    // Rows appended AFTER the page-side window: recount so element_from/
    // total_elements describe the table actually served (main + iframe).
    state.total_elements = state.actions.filter((a) => typeof a.node === "number").length
      + (state.omitted_actions || 0);
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
  // agent re-clicks the opener, spawning duplicate tabs. Strict one-tab: the
  // popup BECOMES the working tab and the previous engine tab is closed.
  unsubs.push(client.on("Target.targetCreated", (p) => {
    const t = p.targetInfo || {};
    if (t.type !== "page" || t.openerId !== session.targetId) return;
    const prevTab = session.targetId;
    void session.adopt(t.targetId).then(async () => {
      session.ownsTargets.add(t.targetId);
      if (prevTab && prevTab !== t.targetId && session.ownsTargets.has(prevTab)) {
        try { await client.call("Target.closeTarget", { targetId: prevTab }); } catch { /* already gone */ }
        session.ownsTargets.delete(prevTab);
      }
    }).catch(() => {});
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

  // Console ring (browsermcp getConsoleLogs pattern): JS logs/errors and
  // uncaught exceptions are the only signal when an action changes nothing.
  // Cap-only — entries stay across navigations, the agent judges recency.
  const pushConsole = (level, text) => {
    const line = String(text || "").replace(/\s+/g, " ").trim().slice(0, CONSOLE_TEXT_CAP);
    if (!line) return;
    session.consoleLog.push({ level, text: line });
    if (session.consoleLog.length > CONSOLE_BUFFER_MAX) session.consoleLog.shift();
  };
  const sessionOf = (sid) => sid === session.sessionId ||
    [...session.iframes.values()].some((i) => i.sessionId === sid);
  unsubs.push(client.on("Runtime.consoleAPICalled", (e, sid) => {
    if (!sessionOf(sid)) return;
    pushConsole(e.type, (e.args || []).map((a) => a.value ?? a.description ?? "").join(" "));
  }));
  unsubs.push(client.on("Runtime.exceptionThrown", (e, sid) => {
    if (!sessionOf(sid)) return;
    pushConsole("error", e.exceptionDetails?.exception?.description || e.exceptionDetails?.text);
  }));
  unsubs.push(client.on("Log.entryAdded", (e, sid) => {
    if (!sessionOf(sid) || e.entry?.level !== "error") return; // info-level log entries are noise
    pushConsole("error", e.entry.text);
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
const DEAD_SESSION = /Session with given id|No target with given id|CDP connection closed|Target closed|Tab was closed|detached/i;

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
// Map-key resolution shared by withSession and the read-only peek below.
function resolveSessionKey(options = {}) {
  const mode = options.mode === "attach" || options.mode === "extension" ? options.mode : "own";
  // The profile may carry "#tabKey" (per-agent isolation) — the MAP key is the
  // whole string, the BASE (before #) names the own-mode profile dir.
  const keyed = typeof options.profile === "string" && options.profile.includes("#");
  const rawProfile = mode === "attach" ? (keyed ? options.profile : ATTACH_PROFILE)
    : mode === "extension" ? (keyed ? options.profile : EXT_PROFILE)
    : (options.profile || "default");
  return {
    mode,
    sessionKey: rawProfile,
    base: rawProfile.includes("#") ? rawProfile.slice(0, rawProfile.indexOf("#")) : rawProfile
  };
}

export async function withSession(options = {}, fn) {
  const mode = options.mode === "attach" || options.mode === "extension" ? options.mode : "own";
  const { sessionKey, base } = resolveSessionKey(options);
  return serialize(sessionKey, async () => {
    let existing = sessions.get(sessionKey);
    // Dead WS or a settings mode switch: the old browser no longer matches.
    if (existing?.client?.closed || (existing && options.mode && existing.mode !== options.mode)) {
      await dropSession(existing);
      existing = null;
    }
    let session = existing || await launchSession({ ...options, profile: base, sessionKey });
    const runWith = async (s) => {
      // One tab per site in BOTH modes (see openOrReuseTab); an identical URL
      // is a no-op, so re-opening never resets a live observation.
      if (options.url) await s.openOrReuseTab(options.url, { newTab: Boolean(options.newTab) });
      return fn(s);
    };
    try {
      return await runWith(session);
    } catch (e) {
      if (!existing || !DEAD_SESSION.test(e.message)) throw e;
      await dropSession(session);
      session = await launchSession({ ...options, profile: base, sessionKey });
      return runWith(session);
    }
  });
}

async function launchSession({ profile = "default", sessionKey = null, url, mode = "own", attachPort = null, headless = false }) {
  const mapKey = sessionKey || profile;
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
    // A keyed session gets its own profile dir — two Chrome instances cannot
    // share one user-data-dir (SingletonLock aborts the second).
    const dirName = sessionKey ? sessionKey.replace(/#/g, "-") : profile;
    if (!safeProfileName(dirName)) throw new Error(`Invalid profile name: "${dirName}"`);
    port = await reservePort();
    const dir = path.join(profilesRoot(), dirName);
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
    if (mode !== "own") {
      // Real-browser modes resume the remembered tab (only ever an engine
      // tab) or create a fresh one carrying the URL — a user's tab is never
      // adopted, no matter how well its URL matches.
      const { targetInfos = [] } = await client.call("Target.getTargets").catch(() => ({ targetInfos: [] }));
      const pageTargets = targetInfos.filter((t) => t.type === "page");
      // Keyed sessions (per-agent tabs) are short-lived — only the shared
      // engine remembers its tab across host restarts.
      const remembered = sessionKey ? null : readRememberedAttachTarget();
      const alive = remembered && pageTargets.find((t) => t.targetId === remembered);
      if (alive) {
        targetId = alive.targetId;
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
    let attached;
    try {
      attached = await client.call("Target.attachToTarget", { targetId, flatten: true });
    } catch (e) {
      throw e;
    }
    const session = makeSession({
      profile, sessionKey, mode, port, child, client, sessionId: attached.sessionId, targetId, headless,
      shared: mode !== "own" // a borrowed browser outlives every session
    });
    if (created) session.ownsTargets.add(targetId);
    await session.setup();
    if (mode !== "own") {
      // Remember and focus ONLY engine-created tabs — a resumed user tab must
      // not be re-driven on the next host restart, nor brought to the front.
      if (session.ownsTargets.has(targetId) && !sessionKey) {
        rememberAttachTarget(targetId);
        try { await client.call("Page.bringToFront", {}, attached.sessionId); } catch { /* ignore */ }
      }
    }
    sessions.set(mapKey, session);
    logger.info(`session open: profile=${mapKey} mode=${mode} port=${port}`);
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

export async function clickById(target, id, { promptText, nowait = false } = {}) {
  const session = toSession(target);
  const run = () => {
    // Armed BEFORE the click: a window.prompt() this click triggers is a native
    // dialog (no DOM, not in the table) — this is the only way to answer it.
    session.pendingPromptText = typeof promptText === "string" ? promptText : null;
    return clickAction(session, id, { nowait });
  };
  return typeof target === "string" ? serialize(target, run) : run();
}

export async function typeById(target, id, text, { enter = false, nowait = false } = {}) {
  const session = toSession(target);
  const run = async () => {
    let state = await session.current();
    let action = state.actions.find((a) => matchActionId(a, id) && a.kind === "fill");
    if (!action) { // the table shifted between the caller's observe and now — one retry
      state = await session.observe();
      action = state.actions.find((a) => matchActionId(a, id) && a.kind === "fill");
    }
    if (!action) throw new Error(`Field ${id} not observed (or not editable)`);
    await session.act(action, text, { nowait });
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

export function matchActionId(action, target) {
  if (!target || !action) return false;
  const t = String(target).toLowerCase();
  const aid = String(action.id || "").toLowerCase();
  if (aid === t) return true;
  // Backward compatibility: e4 or bare 4 matches btn4, inp4, a4
  if (/^e\d+(-\d+)?$/i.test(t)) {
    const targetSuffix = t.slice(1);
    const actionSuffix = aid.replace(/^[a-z]+/i, "");
    if (actionSuffix === targetSuffix) return true;
    if (String(action.node) === targetSuffix) return true;
  }
  if (/^\d+(-\d+)?$/.test(t)) {
    const actionSuffix = aid.replace(/^[a-z]+/i, "");
    if (actionSuffix === t) return true;
    if (String(action.node) === t) return true;
  }
  return false;
}

async function clickAction(session, id, { nowait = false } = {}) {
  const state = await session.current();
  const action = state.actions.find((a) => matchActionId(a, id));
  if (!action) throw new Error(`Element ${id} not observed on the current page`);
  return session.act(action, null, { nowait });
}

function toSession(target) {
  if (target && typeof target === "object") return target;
  const session = sessions.get(target);
  if (!session) throw new Error(`No open session for profile "${target}" — the host restarted or the tab was closed; run \`9remote browser open <url>\` first`);
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

const STAMP_RE = /^🚀\s*\[\d+\]\s*/;

export function cleanStampedTitle(title) {
  return String(title || "").replace(STAMP_RE, "").trim();
}

export function formatStampedTitle(index, rawTitle) {
  const clean = cleanStampedTitle(rawTitle);
  return clean ? `🚀 [${index}] ${clean}` : `🚀 [${index}]`;
}

export function syncTabOrder(session, rawTargets) {
  if (!session.tabOrder) session.tabOrder = [];
  const currentIds = new Set(rawTargets.map((t) => t.targetId));
  session.tabOrder = session.tabOrder.filter((id) => currentIds.has(id));
  for (const t of rawTargets) {
    if (!session.tabOrder.includes(t.targetId)) {
      session.tabOrder.push(t.targetId);
    }
  }
  const byId = new Map(rawTargets.map((t) => [t.targetId, t]));
  return session.tabOrder.map((id) => byId.get(id)).filter(Boolean);
}

export function resolveTab(pages, selector) {
  if (!pages?.length) throw new Error("No open tabs");
  if (selector == null) throw new Error("Missing tab selector");
  const s = String(selector).trim();
  const m = s.match(/^#?(\d+)$/);
  if (m) {
    const idx = Number(m[1]);
    if (idx < 1 || idx > pages.length) {
      throw new Error(`No tab #${idx} — ${pages.length} open`);
    }
    return pages[idx - 1];
  }
  const lower = s.toLowerCase();
  const idHit = pages.find((t) => t.targetId?.toLowerCase() === lower) ||
    pages.find((t) => t.targetId?.toLowerCase().startsWith(lower));
  if (idHit) return idHit;

  const norm = (str) => cleanStampedTitle(str).toLowerCase();
  const match = pages.find((t) => norm(t.title).includes(lower) || t.url?.toLowerCase().includes(lower));
  if (match) return match;

  throw new Error(`No tab matching "${selector}" (${pages.length} open)`);
}

async function pageTargets(session) {
  const { targetInfos = [] } = await session.client.call("Target.getTargets");
  const raw = targetInfos.filter((t) => t.type === "page");
  return syncTabOrder(session, raw);
}

export async function listTabs(options = {}) {
  return withSession(options, async (session) => {
    try {
      const pages = await pageTargets(session);
      return pages.map((t, i) => ({
        index: i + 1,
        id: t.targetId,
        title: formatStampedTitle(i + 1, t.title),
        url: t.url,
        active: t.targetId === session.targetId
      }));
    } catch {
      return [];
    }
  });
}

// Switch the session onto tab by index, id, url or title.
export async function switchTab(options, selector) {
  return withSession(options, (session) => session.switchTab(selector));
}

// Close one tab: active, or by index / target selector.
export async function closeTab(options, selector = null) {
  return withSession(options, async (session) => {
    const pages = await pageTargets(session);
    const target = selector != null ? resolveTab(pages, selector) : pages.find((t) => t.targetId === session.targetId);
    if (!target) throw new Error(`No tab matching "${selector || "active"}"`);
    const isActive = target.targetId === session.targetId;
    if (!isActive && !session.ownsTargets.has(target.targetId)) {
      throw new Error(`Refusing to close tab ${selector} — engine-opened or active tabs only`);
    }
    await session.client.call("Target.closeTarget", { targetId: target.targetId });
    session.ownsTargets.delete(target.targetId);
    if (session.tabOrder) session.tabOrder = session.tabOrder.filter((id) => id !== target.targetId);
    if (isActive) {
      const rest = pages.filter((p) => p.targetId !== target.targetId);
      if (rest.length) {
        await session.adopt(rest[0].targetId);
        await session.stampTitle().catch(() => {});
      } else {
        // Last tab: tearing the map entry alone leaks the Chrome child holding
        // the user-data-dir — close the session first.
        await session.close().catch(() => {});
        sessions.delete(session.sessionKey || session.profile);
      }
    }
    return { ok: true, closed: target.url };
  });
}

export function sessionStatus() {
  return [...sessions.values()].map((s) => ({ profile: s.profile, mode: s.mode, port: s.port }));
}

export { runTask };
