// 9remote browser bridge — a dumb pipe. All business logic (snapshot,
// click gates, tab discipline, settle waits) lives in the host engine; this
// worker drives pages with a static content-script runner + synthetic DOM
// events, so Chrome never shows a debugging banner. It should almost never
// change. Deliberately NOT an ES module (no import): the host bakes the relay
// URL into this placeholder at install time, so no "type": "module" /
// SW-cache class of bugs.
const RELAY_URL = "__RELAY_URL__";

let ws = null;
let paused = false; // user's kill switch (popup) — survives Chrome restarts
const agentTabs = new Set(); // tabs the bridge opened or drives — never "the user's focus"
let activeTabId = null; // tab Chrome currently shows
let prevActiveTabId = null; // tab shown before the current one — the focus restore target
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

// Setup verbs the runner path accepts and ignores — no debugger session exists.
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
    return `page CSP blocks script injection — this site cannot be driven via the extension`;
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
  if (!params.op) throw new Error("the runner needs op-tagged expressions (update the host)");
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

// Browser-level verbs the engine speaks over the wire, routed to chrome.tabs.
const SHIM = {
  "Target.getTargets": async () => {
    const tabs = await chrome.tabs.query({});
    return { targetInfos: tabs.map((t) => ({ targetId: String(t.id), type: "page", title: t.title, url: t.url })) };
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
    // No debugger session exists — the session id IS the tab id.
    const tid = String(targetId);
    agentTabs.add(tid);
    // A popup our click spawned takes the focus Chrome gives it — hand it back
    // to the tab the user was actually reading. The agent drives in background.
    snapBackFocus(tid);
    return { sessionId: tid };
  },
  "Target.detachFromTarget": async () => ({}),
  "Target.getTargetInfo": async ({ targetId }) => {
    const t = await chrome.tabs.get(Number(targetId));
    return { targetInfo: { targetId: String(t.id), type: "page", title: t.title, url: t.url } };
  },
  // OOPIF child sessions are not reachable — accept and ignore so the
  // engine's setup() does not fail (frames just stay unobserved).
  "Target.setAutoAttach": async () => ({}),
  // Browser-level discovery is synthesized from tabs.onCreated below.
  "Target.setDiscoverTargets": async () => ({}),
  // The engine uses it to surface its tab; for the user's real browser that
  // IS the focus steal we are suppressing.
  "Page.bringToFront": async () => ({})
};

let inputAt = 0; // last Input.* dispatch — gates popup adoption below

async function dispatch(method, params, targetId) {
  if (LIGHT_NOOP.has(method)) return {};
  if (method === "Runtime.evaluate") {
    if (targetId == null) throw new Error("Runtime.evaluate needs a target");
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
  if (method === "Page.navigate") {
    await chrome.tabs.update(Number(targetId), { url: params.url || "about:blank" });
    return { frameId: 0 };
  }
  if (method === "Page.reload") {
    await chrome.tabs.reload(Number(targetId));
    return {};
  }
  if (method === "Browser.getWindowForTarget") {
    return { windowId: (await chrome.tabs.get(Number(targetId))).windowId };
  }
  if (SHIM[method]) return SHIM[method](params, targetId);
  if (LIGHT_UNSUPPORTED.has(method)) {
    throw new Error(`${method} is not available via the extension`);
  }
  throw new Error(`${method} is not available via the extension`);
}

function send(frame) {
  try { ws?.send(JSON.stringify(frame)); } catch { /* relay down — close handler reconnects */ }
}

// Synthesize Target.targetCreated the engine's popup adoption listens for —
// chrome.tabs never surfaces browser-level target events.
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
// Synthesize the main-frame navigation events settle() keys its nav tail on
// (a debugger session would get them from CDP for free).
chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  send({ t: "event", method: "Page.frameRequestedNavigation",
    params: { frame: {}, disposition: "currentTab" }, sessionId: String(d.tabId) });
});
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  send({ t: "event", method: "Page.frameNavigated",
    params: { frame: { id: "0", url: d.url } }, sessionId: String(d.tabId) });
});
// Pure tracking: which tab Chrome shows, and which one came before it. The
// user clicking ANY tab (agent tabs included, to watch it work) just updates
// the trackers — focus is only ever restored at the adoption moment above.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  if (activeTabId !== tabId) { prevActiveTabId = activeTabId; activeTabId = tabId; }
});
// A closed tab is gone for good — never adopt onto its id again.
chrome.tabs.onRemoved.addListener((tabId) => {
  runnerTabs.delete(tabId);
});

// The user's kill switch: pause = drop the relay, hard. Nothing rides
// through; the host simply sees the extension go offline.
async function setPaused(next) {
  paused = next;
  try { await chrome.storage.local.set({ paused: next }); } catch { /* non-fatal */ }
  if (next) {
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
      version: chrome.runtime.getManifest().version, paused
    });
    return false;
  }
  if (msg?.t === "setPaused") {
    setPaused(Boolean(msg.paused)).then(() => sendResponse({ ok: true }));
    return true;
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
    try { send({ t: "result", id: m.id, result: await dispatch(m.method, m.params, m.targetId) }); }
    catch (e) { send({ t: "result", id: m.id, error: e?.message || String(e) }); }
  };
  const retry = () => { ws = null; if (!paused) setTimeout(connect, 2000); }; // host down: retry quietly
  ws.onclose = retry;
  ws.onerror = () => { try { ws?.close(); } catch { /* retry via onclose */ } };
}
// Boot: honor a persisted pause before the first connection attempt.
chrome.storage.local.get(["paused"]).then((saved) => {
  paused = Boolean(saved?.paused);
  if (!paused) connect();
}).catch(() => connect());
