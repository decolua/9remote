// 9remote browser bridge — a dumb CDP pipe. All business logic (snapshot,
// click gates, tab discipline, settle waits) lives in the host engine; this
// worker only forwards CDP verbs to chrome.debugger and shims the browser-level
// tab verbs the engine speaks over the wire. It should almost never change.
// Deliberately NOT an ES module (no import): the host bakes the relay URL into
// this placeholder at install time, so no "type": "module" / SW-cache class of bugs.
const RELAY_URL = "__RELAY_URL__";

let ws = null;
let paused = false; // user's kill switch (popup) — survives Chrome restarts
const attached = new Set(); // target ids (strings — chrome.debugger's form) with a live attach
const agentTabs = new Set(); // tabs the bridge opened or drives — never "the user's focus"
let activeTabId = null; // tab Chrome currently shows
let prevActiveTabId = null; // tab shown before the current one — the focus restore target
// Idle soft-detach: Chrome closes the "started debugging" banner ~5s after the
// debugger detaches, so an idle agent gets out of the user's face. The next
// command re-attaches transparently — the engine never notices.
const idleDetached = new Set(); // tabs WE detached while idle
let lastCallAt = 0;
const IDLE_DETACH_MS = 10000;
const IDLE_SWEEP_MS = 3000;
const GROUP_TITLE = "9remote"; // agent tabs share one named tab group
const GROUP_COLOR = "orange"; // matches the 9remote brand

// Serializes grouping so two quick creates cannot each mint their own group.
let groupQueue = Promise.resolve();
// Cosmetic only: a grouping failure must never break the agent's command.
function groupAgentTab(tab) {
  groupQueue = groupQueue.then(async () => {
    const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId });
    const groupId = await chrome.tabs.group(group ? { tabIds: tab.id, groupId: group.id } : { tabIds: tab.id });
    if (!group) await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
  }).catch(() => {});
}

// ---- light mode (no debugger banner) -----------------------------------------
// Drives pages with a static content-script runner + synthetic DOM events
// instead of chrome.debugger (AutoAgent pattern), so Chrome never shows the
// "started debugging" banner. Costs: synthetic events are not trusted
// (isTrusted=false) — some sites reject them; screenshots, file upload and
// js-dialog dismissal are gone; pages whose CSP forbids eval (e.g. GitHub)
// refuse expressions — flip Drive mode to Debugger in the popup for those.
let lightMode = true;
const lightActive = () => lightMode;

// Setup verbs the light path accepts and ignores — no debugger session exists.
const LIGHT_NOOP = new Set(["Page.enable", "DOM.enable", "Runtime.enable", "Log.enable",
  "Target.setAutoAttach", "Target.setDiscoverTargets",
  "Emulation.setDeviceMetricsOverride", "Emulation.setFocusEmulationEnabled"]);
const LIGHT_UNSUPPORTED = new Set(["Page.captureScreenshot", "DOM.getDocument",
  "DOM.requestNode", "DOM.setFileInputFiles"]);

// Normalize chrome API errors into the CDP shapes the engine's DEAD_SESSION
// regex keys on, so a closed tab heals the session instead of wedging it.
function normErr(tid, e) {
  const msg = e?.message || String(e);
  if (/no tab|tab not found|cannot access|chrome:\/\/|chrome web store/i.test(msg)) return `No target with given id: ${tid}`;
  if (/refused to evaluate|content security policy/i.test(msg)) {
    return `page CSP blocks script injection — flip Drive mode to Debugger in the popup for this site`;
  }
  return msg; // anything else reads as "document navigating" to the engine
}

// The runner is injected once per tab (idempotent — see runner.js); navigation
// destroys it, and the first sendMessage after that re-injects (AutoAgent
// background pattern).
const runnerTabs = new Set();
async function ensureRunner(tabId) {
  if (runnerTabs.has(tabId)) return;
  await chrome.scripting.executeScript({ target: { tabId }, files: ["runner.js"] });
  runnerTabs.add(tabId);
}

// Runtime.evaluate → a named op on the static runner (see runner.js — MV3 CSP
// forbids eval, so the host tags every expression with an op name instead).
// Promise-returning ops are awaited inside the runner before the reply.
// A committing navigation wipes the runner and the injection can race it —
// retry the inject+ask pair a bounded number of times before giving up.
const TRANSIENT_INJECT = /receiving end does not exist|could not establish|message channel|cannot access contents/i;
async function evalInTab(tid, params) {
  if (!params.op) throw new Error("light mode needs op-tagged expressions (update the host)");
  const tabId = Number(tid);
  let lastErr = null;
  for (let i = 0; i < 8; i++) {
    try {
      await ensureRunner(tabId);
      const r = await chrome.tabs.sendMessage(tabId, { t: "op", op: params.op, args: params.args || [] });
      if (!r) throw new Error(`No target with given id: ${tid}`);
      if (!r.ok) throw normErr(tid, { message: r.err });
      return r.v ?? null;
    } catch (e) {
      lastErr = e;
      if (!TRANSIENT_INJECT.test(e?.message || "")) throw normErr(tid, e);
      runnerTabs.delete(tabId); // document changed under us — inject fresh
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw normErr(tid, lastErr);
}

// Tab-level verbs the light path translates itself; the base SHIM below
// (Target.*, closeTarget…) applies to both paths unchanged.
const LIGHT_SHIM = {
  "Page.navigate": async ({ url }, tid) => { await chrome.tabs.update(Number(tid), { url: url || "about:blank" }); return { frameId: 0 }; },
  "Page.reload": async (_p, tid) => { await chrome.tabs.reload(Number(tid)); return {}; },
  "Page.bringToFront": async () => ({}), // same reason as the base SHIM
  "Browser.getWindowForTarget": async ({ targetId }) => ({ windowId: (await chrome.tabs.get(Number(targetId))).windowId }),
  "Target.getTargetInfo": async ({ targetId }) => {
    const t = await chrome.tabs.get(Number(targetId));
    return { targetInfo: { targetId: String(t.id), type: "page", title: t.title, url: t.url } };
  }
};

async function dispatchLight(method, params, targetId) {
  if (LIGHT_NOOP.has(method)) return {};
  if (method === "Runtime.evaluate") {
    if (targetId == null) throw new Error("Runtime.evaluate needs a target in light mode");
    // CDP envelope shape: the host's evaluate() unwraps result.result.value.
    const value = await evalInTab(String(targetId), params);
    return { result: { value: value ?? null } };
  }
  if (method === "Input.dispatchMouseEvent") {
    inputAt = Date.now();
    return evalInTab(String(targetId), { op: "mouse", args: [params.type, params.x, params.y] });
  }
  if (method === "Input.dispatchKeyEvent") {
    inputAt = Date.now();
    return evalInTab(String(targetId), { op: "key", args: [{ type: params.type, key: params.key, code: params.code,
      modifiers: params.modifiers || 0, vk: params.windowsVirtualKeyCode, commands: params.commands }] });
  }
  if (method === "Input.insertText") {
    inputAt = Date.now();
    return evalInTab(String(targetId), { op: "insertText", args: [params.text] });
  }
  if (LIGHT_SHIM[method]) return LIGHT_SHIM[method](params, targetId);
  if (SHIM[method]) return SHIM[method](params, targetId); // Target.* tab verbs work in both modes
  if (LIGHT_UNSUPPORTED.has(method)) {
    throw new Error(`${method} is not available in light mode — flip Drive mode to Debugger in the popup`);
  }
  throw new Error(`${method} is not available via the extension (light mode)`);
}

function send(frame) {
  try { ws?.send(JSON.stringify(frame)); } catch { /* relay down — close handler reconnects */ }
}

async function detachQuiet(tid, idle = false) {
  attached.delete(tid);
  if (!idle) idleDetached.delete(tid);
  try { await chrome.debugger.detach({ tabId: Number(tid) }); } catch { /* already gone */ }
}

// Restore what the user was watching when a popup stole the focus. Only called
// at the adoption moment — a user DELIBERATELY clicking an agent tab to watch
// must stick, so activation itself never triggers a snapback.
// Chrome rejects tab edits mid-drag (and once spuriously per session) — the
// rejection MUST be caught or it surfaces as an uncaught error; a short retry
// covers the transient case.
function snapBackFocus(tid) {
  if (String(activeTabId) !== tid) return; // nothing was stolen — leave the user alone
  if (prevActiveTabId == null || String(prevActiveTabId) === tid) return;
  const focusBack = () => chrome.tabs.update(prevActiveTabId, { active: true }).catch(() => {});
  focusBack();
  setTimeout(focusBack, 250);
}

// Browser-level verbs the engine needs but chrome.debugger does not expose —
// routed to chrome.tabs / chrome.debugger equivalents. Everything else rides
// sendCommand untouched, so engine changes never require an extension update.
const SHIM = {
  // Drop chrome.debugger for a tab on demand (engine `undbg` op): Google GIS
  // hides its sign-in button while a debugger is attached — detaching lets the
  // page render clean; the next engine call re-attaches automatically.
  "SHIM.Debugger.detach": async ({ targetId }) => {
    const tid = String(targetId);
    if (lightActive()) return { detached: true }; // nothing attached in light mode
    await detachQuiet(tid);
    return { detached: true };
  },
  "Target.getTargets": async () => {
    const targets = await chrome.debugger.getTargets();
    return { targetInfos: targets.map((t) => ({ targetId: String(t.tabId ?? t.id), type: t.type, title: t.title, url: t.url })) };
  },
  "Target.createTarget": async ({ url }) => {
    // Always background: agent tabs never steal the user's focus (focus
    // emulation on the page keeps them rendering anyway).
    const tab = await chrome.tabs.create({ url: url || "about:blank", active: false });
    agentTabs.add(String(tab.id));
    groupAgentTab(tab);
    return { targetId: String(tab.id) };
  },
  "Target.closeTarget": async ({ targetId }) => {
    await chrome.tabs.remove(Number(targetId));
    return {};
  },
  "Target.attachToTarget": async ({ targetId }) => {
    // chrome.debugger debuggee ids are STRINGS; chrome.tabs takes numbers —
    // translate at each boundary and keep strings everywhere inside.
    const tid = String(targetId);
    if (attached.has(tid)) return { sessionId: tid }; // session heal re-attaches its own target
    agentTabs.add(tid);
    // Light mode never attaches a debugger — the session id IS the tab id.
    if (lightActive()) return { sessionId: tid };
    // One attached page at a time — mirrors engine usage, avoids stacked infobars.
    for (const prev of [...attached]) if (prev !== tid) detachQuiet(prev);
    await attachDebugger(tid);
    attached.add(tid);
    // A popup our click spawned takes the focus Chrome gives it — hand it back
    // to the tab the user was actually reading. The agent drives in background.
    snapBackFocus(tid);
    return { sessionId: tid };
  },
  "Target.detachFromTarget": async ({ sessionId }) => {
    await detachQuiet(String(sessionId));
    return {};
  },
  // OOPIF child sessions are not reachable via chrome.debugger — accept and
  // ignore so the engine's setup() does not fail (frames just stay unobserved).
  "Target.setAutoAttach": async () => ({}),
  // Browser-level discovery is synthesized from tabs.onCreated below.
  "Target.setDiscoverTargets": async () => ({}),
  // The engine uses it to surface its tab; for the user's real browser that
  // IS the focus steal we are suppressing.
  "Page.bringToFront": async () => ({})
};

let inputAt = 0; // last Input.* dispatch — gates popup adoption below


// The debugger target registers a beat after tabs.create — a cold attach can
// fail with "No target with given id" even though the tab exists. Retry while
// the tab is alive per chrome.tabs (source of truth), and surface the full
// picture when Chrome still refuses.
async function attachDebugger(tid) {
  for (let i = 0; i < 10; i++) {
    try {
      await chrome.debugger.attach({ tabId: Number(tid) }, "1.3");
      return;
    } catch (e) {
      const tabs = await chrome.tabs.query({}).catch(() => []);
      const alive = tabs.some((t) => String(t.id) === tid);
      if (!alive) {
        throw new Error(`attach tid=${tid}: tab not in chrome.tabs (closed?) — ${e.message}`);
      }
      if (i === 9) {
        throw new Error(`attach tid=${tid}: tab alive but Chrome refuses — ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function dispatch(method, params, targetId) {
  if (lightActive()) return dispatchLight(method, params || {}, targetId);
  return dispatchDebug(method, params || {}, targetId);
}

async function dispatchDebug(method, params, targetId) {
  if (SHIM[method]) return SHIM[method](params);
  if (targetId == null) throw new Error(`${method} is not available via the extension`);
  if (method.startsWith("Input.")) inputAt = Date.now();
  const tid = String(targetId);
  // Not attached (idle soft-detach, or this worker restarted and lost its set):
  // try to (re)attach first. Only a missing tab masquerades as "No target";
  // other failures (e.g. DevTools open on the tab) must surface as themselves.
  if (!attached.has(tid)) {
    idleDetached.delete(tid);
    await attachDebugger(tid);
    attached.add(tid);
  }
  try {
    return await chrome.debugger.sendCommand({ tabId: Number(tid) }, method, params || {});
  } catch (e) {
    if (/no target|closed|detached|not found/i.test(e?.message || "")) {
      // The idle soft-detach timer can fire between our attach check and the
      // send — re-attach ONCE and retry before declaring the target dead.
      try {
        await attachDebugger(tid);
        attached.add(tid);
        return await chrome.debugger.sendCommand({ tabId: Number(tid) }, method, params || {});
      } catch {
        detachQuiet(tid);
        throw new Error(`No target with given id: ${targetId}`);
      }
    }
    throw e;
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  send({ t: "event", method, params, sessionId: String(source.tabId ?? source.targetId) });
});
// Synthesize Target.targetCreated the engine's popup adoption listens for —
// chrome.debugger never surfaces browser-level target events.
const POPUP_WINDOW_MS = 1500; // born within this after our Input dispatch = the agent's click
chrome.tabs.onCreated.addListener((tab) => {
  // Only a tab born right after an agent click counts as the agent's popup —
  // a tab the USER opens from an agent-driven tab (cmd/middle-click) is theirs;
  // tagging it would drag the session onto the user's tab.
  const agentPopup = tab.openerTabId != null && agentTabs.has(String(tab.openerTabId)) &&
    Date.now() - inputAt < POPUP_WINDOW_MS;
  if (agentPopup) agentTabs.add(String(tab.id));
  send({ t: "event", method: "Target.targetCreated", params: { targetInfo: {
    targetId: String(tab.id), type: "page",
    url: tab.url || tab.pendingUrl || "",
    ...((tab.openerTabId != null && agentPopup) ? { openerId: String(tab.openerTabId) } : {})
  } } });
});
// Light mode: synthesize the main-frame navigation events settle() keys its
// nav tail on (the debugger path gets them from CDP for free).
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (!lightActive() || d.frameId !== 0) return;
  send({ t: "event", method: "Page.frameRequestedNavigation",
    params: { frame: {}, disposition: "currentTab" }, sessionId: String(d.tabId) });
});
chrome.webNavigation.onCommitted.addListener((d) => {
  if (!lightActive() || d.frameId !== 0) return;
  send({ t: "event", method: "Page.frameNavigated",
    params: { frame: { id: "0", url: d.url } }, sessionId: String(d.tabId) });
});
// Pure tracking: which tab Chrome shows, and which one came before it. The
// user clicking ANY tab (agent tabs included, to watch it work) just updates
// the trackers — focus is only ever restored at the adoption moment above.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (activeTabId !== tabId) { prevActiveTabId = activeTabId; activeTabId = tabId; }
});
// A closed tab is gone for good — never re-attach onto its id.
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(String(tabId));
  idleDetached.delete(String(tabId));
  runnerTabs.delete(tabId);
});
// The idle sweep behind the soft-detach (see idleDetached above).
setInterval(() => {
  if (!attached.size || Date.now() - lastCallAt < IDLE_DETACH_MS) return;
  for (const tid of [...attached]) {
    idleDetached.add(tid);
    detachQuiet(tid, true);
  }
}, IDLE_SWEEP_MS);
// "Cancel" on the debug infobar, DevTools open, or tab close — surface it the
// way CDP would so the engine drops and rebuilds the session instead of wedging.
chrome.debugger.onDetach.addListener((source) => {
  attached.delete(String(source.tabId ?? source.targetId));
  idleDetached.delete(String(source.tabId ?? source.targetId)); // user cancelled — stay detached
  send({ t: "event", method: "Target.detachedFromTarget", params: {
    sessionId: String(source.tabId ?? source.targetId), targetId: String(source.tabId ?? source.targetId)
  } });
});

// The user's kill switch: pause = drop debugger + relay, hard. Nothing rides
// through; the host simply sees the extension go offline.
async function setPaused(next) {
  paused = next;
  try { await chrome.storage.local.set({ paused: next }); } catch { /* non-fatal */ }
  if (next) {
    for (const tid of [...attached]) detachQuiet(tid);
    try { ws?.close(); } catch { /* already closed */ }
    ws = null;
  } else if (!ws) {
    connect();
  }
}

// Popup surface — status + the pause toggle.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.t === "status") {
    let host = "";
    try { host = new URL(RELAY_URL).host; } catch { /* keep empty */ }
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN, host,
      version: chrome.runtime.getManifest().version, paused,
      light: lightMode, lightActive: lightActive()
    });
    return false;
  }
  if (msg?.t === "setPaused") {
    setPaused(Boolean(msg.paused)).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.t === "setLight") {
    lightMode = Boolean(msg.light);
    try { chrome.storage.local.set({ light: lightMode }); } catch { /* non-fatal */ }
    // Leaving debugger mode: drop every attach so the banner clears in seconds.
    if (lightMode) for (const tid of [...attached]) detachQuiet(tid);
    sendResponse({ ok: true, light: lightMode, active: lightActive() });
    return false;
  }
});

function connect() {
  if (paused) return; // never dial out while the kill switch is on
  ws = new WebSocket(RELAY_URL);
  ws.onopen = () => send({ t: "hello", proto: 2 });
  ws.onmessage = async (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === "ping") return send({ t: "pong" });
    if (m.t !== "call") return;
    lastCallAt = Date.now();
    try { send({ t: "result", id: m.id, result: await dispatch(m.method, m.params, m.targetId) }); }
    catch (e) { send({ t: "result", id: m.id, error: e?.message || String(e) }); }
  };
  const retry = () => { ws = null; if (!paused) setTimeout(connect, 2000); }; // host down: retry quietly
  ws.onclose = retry;
  ws.onerror = () => { try { ws?.close(); } catch { /* retry via onclose */ } };
}
// Boot: honor a persisted pause before the first connection attempt.
chrome.storage.local.get(["paused", "light"]).then((saved) => {
  paused = Boolean(saved?.paused);
  lightMode = saved?.light !== false; // light is the default — no banner
  if (!paused) connect();
}).catch(() => connect());
