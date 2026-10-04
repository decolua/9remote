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

function send(frame) {
  try { ws?.send(JSON.stringify(frame)); } catch { /* relay down — close handler reconnects */ }
}

async function detachQuiet(tid, idle = false) {
  attached.delete(tid);
  if (!idle) idleDetached.delete(tid);
  try { await chrome.debugger.detach({ targetId: tid }); } catch { /* already gone */ }
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
  "Target.getTargets": async () => {
    const targets = await chrome.debugger.getTargets();
    return { targetInfos: targets.map((t) => ({ targetId: String(t.id), type: t.type, title: t.title, url: t.url })) };
  },
  "Target.createTarget": async ({ url }) => {
    // Always background: agent tabs never steal the user's focus (focus
    // emulation on the page keeps them rendering anyway).
    const tab = await chrome.tabs.create({ url: url || "about:blank", active: false });
    agentTabs.add(String(tab.id));
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
    // One attached page at a time — mirrors engine usage, avoids stacked infobars.
    for (const prev of [...attached]) if (prev !== tid) detachQuiet(prev);
    await chrome.debugger.attach({ targetId: tid }, "1.3");
    attached.add(tid);
    // A popup our click spawned takes the focus Chrome gives it — hand it back
    // to the tab the user was actually reading. The agent drives in background.
    agentTabs.add(tid);
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

async function dispatch(method, params, targetId) {
  if (SHIM[method]) return SHIM[method](params || {});
  if (targetId == null) throw new Error(`${method} is not available via the extension`);
  if (method.startsWith("Input.")) inputAt = Date.now();
  const tid = String(targetId);
  // Not attached (idle soft-detach, or this worker restarted and lost its set):
  // try to (re)attach first. Only a missing tab masquerades as "No target";
  // other failures (e.g. DevTools open on the tab) must surface as themselves.
  if (!attached.has(tid)) {
    idleDetached.delete(tid);
    try {
      await chrome.debugger.attach({ targetId: tid }, "1.3");
      attached.add(tid);
    } catch (e) {
      throw /no target|not found|cannot access/i.test(e?.message || "")
        ? new Error(`No target with given id: ${targetId}`)
        : e;
    }
  }
  try {
    return await chrome.debugger.sendCommand({ targetId: tid }, method, params || {});
  } catch (e) {
    // A detached/closed target must look dead to the host's DEAD_SESSION heal.
    if (!attached.has(tid)) throw new Error(`No target with given id: ${targetId}`);
    throw e;
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  send({ t: "event", method, params, sessionId: String(source.targetId) });
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
  attached.delete(source.targetId);
  idleDetached.delete(String(source.targetId)); // user cancelled — stay detached
  send({ t: "event", method: "Target.detachedFromTarget", params: {
    sessionId: String(source.targetId), targetId: String(source.targetId)
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
  ws.onopen = () => send({ t: "hello", proto: 1 });
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
chrome.storage.local.get(["paused"]).then((saved) => {
  paused = Boolean(saved?.paused);
  if (!paused) connect();
}).catch(() => connect());
