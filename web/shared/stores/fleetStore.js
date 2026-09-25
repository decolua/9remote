"use client";

import { create } from "zustand";
import { ProtocolManager } from "@/shared/transport/ProtocolManager";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { headOf, tailOf } from "@/shared/utils/apiKey";
import { setTrust } from "@/shared/transport/lib/deviceTrust";
import { sameEntry, sameMap } from "@/shared/utils/shallowEqual";

// Fleet: one full host (the workspace's own connection) plus one background bus
// per other saved key. A background bus is a regular ProtocolManager connection
// that only ever asks for metadata (session/workspace lists + status events) —
// it joins no session channel, so its steady-state traffic is keepalive pings.
// It never touches useConnectionStore: that singleton belongs to the full host.

const DEVICE_ID_KEY = "9remote_deviceId";
const CACHE_KEY = "9remote_fleet_cache";
const FOCUS_KEY = "9remote_fleet_focus";
const CONNECTED_KEY = "9remote_fleet_connected";
// Safari's per-origin WebSocket ceiling is the tightest budget the page lives under.
export const MAX_FLEET_HOSTS = 8;
const PERSIST_DEBOUNCE_MS = 1000;
// A bus that never opens (dead tunnel, pending device approval) fires neither
// onConnect nor onDisconnect — without a deadline the row would read "connecting"
// forever. Past it the host shows offline from its cache.
const CONNECT_TIMEOUT_MS = 15000;
// How often host liveness is re-read for hosts with no bus. The D1 heartbeat
// beats every 2 min with a server-side grace window, so a hard kill lags —
// polling is what makes a dead host's row go grey (and a revived one go green)
// without the user expanding it.
const PROBE_INTERVAL_MS = 60000;
let probeTimer = null;
let probeVisibleHandler = null;

function armProbeLoop() {
  if (typeof window === "undefined" || probeTimer) return;
  probeTimer = setInterval(() => {
    if (!document.hidden) useFleetStore.getState()._probeUnconnected();
  }, PROBE_INTERVAL_MS);
  probeVisibleHandler = () => {
    if (document.visibilityState === "visible") useFleetStore.getState()._probeUnconnected();
  };
  document.addEventListener("visibilitychange", probeVisibleHandler);
}

function disarmProbeLoop() {
  if (!probeTimer) return;
  clearInterval(probeTimer);
  probeTimer = null;
  document.removeEventListener("visibilitychange", probeVisibleHandler);
  probeVisibleHandler = null;
}

// apiKey HEAD -> ProtocolManager (module-level: transport objects, not render state)
const buses = new Map();
// Deferred mutations: pressed while the bus is still opening, fired on connect.
// Cleared on disconnect — a command never replays against a later session.
const pendingByHost = new Map();
let persistTimer = null;

function readDeviceId() {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(DEVICE_ID_KEY); } catch { return null; }
}

// Which host's bus a session belongs to lives in hostConn (connForSession) — one
// resolver for panes, panels and trees. This module owns the buses themselves.

// A host's client-bus facade, for callers that hold the HEAD (trees, actions).
export function fleetBusOf(head) {
  if (!head) return null;
  return buses.get(head)?.busRef?.current || null;
}

// Run fn with the host's live bus facade now, or defer it until the bus connects
// (opening the bus if needed). The single door for fleet mutations — defer, never
// drop a user intent that landed in the lazy-connect window.
export function emitWhenReady(head, fn) {
  if (!head) return;
  const st = useFleetStore.getState();
  if (!st.hosts[head]) return; // unknown host — nothing to defer to
  const bus = buses.get(head)?.busRef?.current;
  if (bus && st.hosts[head].status === "online") { fn(bus); return; }
  st.ensureHost(head);
  const q = pendingByHost.get(head) || [];
  q.push(fn);
  pendingByHost.set(head, q);
}

function readCache() {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch { return {}; }
}

function readFocus() {
  if (typeof window === "undefined") return null;
  try {
    const v = localStorage.getItem(FOCUS_KEY);
    // "" (explicit fleet view) must survive — only absence reads as null.
    return v === null ? null : v;
  } catch { return null; }
}

function readConnected() {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(CONNECTED_KEY) || "[]"); } catch { return []; }
}

function setHostConnected(head, connected) {
  if (typeof window === "undefined" || !head) return;
  try {
    const list = readConnected();
    const set = new Set(list);
    if (connected) set.add(head);
    else set.delete(head);
    localStorage.setItem(CONNECTED_KEY, JSON.stringify([...set]));
  } catch {}
}

// Last-known snapshots so an offline host still renders (Tailscale-style last seen).
function schedulePersist(get) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (typeof window === "undefined") return;
    const out = {};
    for (const [key, h] of Object.entries(get().hosts)) {
      out[key] = {
        label: h.label, platform: h.platform, version: h.version,
        sessions: h.sessions, workspaces: h.workspaces, statusMap: h.statusMap, lastSeenAt: h.lastSeenAt
      };
    }
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(out)); } catch {}
  }, PERSIST_DEBOUNCE_MS);
}

const emptyHost = (key) => ({
  key, full: null, label: "", status: "offline", carrier: "ws",
  sessions: [], workspaces: [], statusMap: {},
  platform: null, version: null, lastSeenAt: null
});

export const useFleetStore = create((set, get) => ({
  hosts: {},
  // The head the live workspace connection serves — ensureHost never opens a
  // second bus to it.
  currentKey: null,
  // Which host the mobile home is "inside" (its SessionList); null = fleet overview.
  focus: readFocus(),
  // Fleet overlay (slide-menu "Hosts" entry) — the desktop's only door in.
  overlayOpen: false,

  // Reconcile background buses with the saved-key list. `currentKey` (a HEAD)
  // gets no bus — its data comes from the live workspace connection.
  sync(savedKeys, currentKey) {
    const current = currentKey || "";
    const infoByHead = new Map();
    for (const item of savedKeys) {
      const head = headOf(item.key);
      if (head && !infoByHead.has(head)) infoByHead.set(head, { full: item.key, label: item.label || "" });
    }
    // The current host shows in the fleet even when its key was never saved here.
    if (current && !infoByHead.has(current)) infoByHead.set(current, { full: null, label: "" });

    const wantedHeads = [...infoByHead.keys()].filter((h) => h !== current).slice(0, MAX_FLEET_HOSTS);
    const wantedSet = new Set(wantedHeads);

    for (const [key, pm] of buses) {
      if (!wantedSet.has(key)) { pm.disconnect(); buses.delete(key); }
    }

    const cached = readCache();
    const connectedSet = new Set(readConnected());
    set((prev) => {
      const hosts = {};
      for (const [head, info] of infoByHead) {
        const prior = prev.hosts[head] || { ...emptyHost(head), ...(cached[head] || {}) };
        hosts[head] = {
          ...prior,
          key: head,
          full: info.full,
          label: info.label || prior.label,
          status: head === current ? "full"
            : wantedSet.has(head) && (prior.status === "online" || prior.status === "connecting") ? prior.status
            : "offline"
        };
      }
      return { hosts, currentKey: current };
    });

    // Auto-connect hosts that were previously connected by the user
    for (const head of wantedHeads) {
      if (connectedSet.has(head)) {
        get()._openHost(head);
      }
    }

    // Liveness for hosts without a bus is periodic (see _probeUnconnected) — a
    // one-shot read here would freeze each row at whatever the heartbeat said
    // at load, dead or alive.
    get()._probeUnconnected();
    armProbeLoop();
  },

  // One batched liveness read for hosts NO bus owns — the main host rides the
  // live connection, hosts with a bus read onConnect/onDisconnect. For busless
  // hosts the heartbeat verdict is authoritative in BOTH directions; a bus that
  // opened while the fetch was out (ensureHost) is skipped so it is never
  // stamped over. Runs once per sync() and then every PROBE_INTERVAL_MS.
  _probeUnconnected() {
    const st = get();
    const heads = Object.values(st.hosts)
      .filter((h) => h.key !== st.currentKey && !buses.has(h.key))
      .map((h) => h.key);
    if (!heads.length) return;
    fetch("/api/host-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heads })
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const now = get();
        for (const head of heads) {
          const info = data?.hosts?.[head];
          if (!info) continue;
          const h = now.hosts[head];
          if (!h || head === now.currentKey || buses.has(head)) continue;
          const next = info.online ? "online" : "offline";
          if (h.status !== next) get()._patchHost(head, { status: next });
        }
      })
      .catch(() => {}); // Keep whatever the row already says — the next tick retries
  },

  _openHost(head) {
    if (buses.has(head)) return;
    const entry = get().hosts[head];
    const deviceId = readDeviceId();
    if (!entry || !deviceId) return;
    // Every open path (connect button, tree expand, retry, deferred action)
    // persists the intent — F5 reconnects without the user re-pressing, even
    // when the host was unreachable. Disconnect is the off switch.
    setHostConnected(head, true);
    // The tail rides device trust (idempotent — a previous login usually set it).
    const tail = tailOf(entry.full);
    if (tail) setTrust(head, { tail });

    const patch = (p) => get()._patchHost(head, p);
    let bound = false;
    let connectTimer = null;

    // Metadata only: lists + status. The bus outlives carrier switches, so the
    // listeners bind once; later connects just refetch.
    const refetch = (bus) => {
      bus?.emit("getSessions", (list) => {
        if (Array.isArray(list)) patch({ sessions: list });
      });
      bus?.emit("getWorkspaces", (list) => { if (Array.isArray(list)) patch({ workspaces: list }); });
      bus?.emit("getStatusState");
    };

    const pm = new ProtocolManager(
      {
        tunnelUrl: null,
        localIp: null,
        namespace: "",
        socketOptions: { auth: { apiKey: head, tempKey: null, deviceId } },
        apiKey: head,
        deviceId,
        tempKey: null,
        onConnect: (bus) => {
          clearTimeout(connectTimer);
          patch({ status: "online", lastSeenAt: Date.now() });
          // Deferred mutations fire in press order, then the fresh lists land.
          const q = pendingByHost.get(head);
          if (q) { pendingByHost.delete(head); for (const fn of q) { try { fn(bus); } catch {} } }
          if (bound) { refetch(bus); return; }
          bound = true;
          // Carrier switch = a new socket server-side: re-announce, then refetch.
          bus.on("connect", () => { bus.emit("device:clientReady"); refetch(bus); });
          bus.on("serverInfo", (info) => patch({ platform: info?.platform || null, version: info?.version || null }));
          bus.on("statusState", (state) => get().applyStatusState(head, state));
          bus.on("statusChange", (p) => get().applyStatusChange(head, p));
          bus.on("statusCleared", (id) => get().applyStatusCleared(head, id));
          bus.on("sessionsChanged", () => refetch(bus));
          bus.on("workspacesChanged", () => refetch(bus));
          bus.on("session-renamed", () => refetch(bus));
          // Same cleanup the main host's useAgentBus runs: a session closed on
          // that machine must drop its pane/tab/draft state here too.
          bus.on("sessionClosed", (sessionId) => {
            if (sessionId) useTerminalStore.getState().closeSession(sessionId);
            refetch(bus);
          });
          bus.on("device:rejected", () => get()._closeHost(head));
          // ponytail: tailRejected with sealUnreadable just drops the host here;
          // upgrade path = mirror useAgentBus's drop-pin-and-retry when it bites.
          bus.on("device:tailRejected", () => get()._closeHost(head));
          bus.emit("device:clientReady");
          refetch(bus);
        },
        onDisconnect: () => { pendingByHost.delete(head); get()._patchHost(head, { status: "offline", lastSeenAt: Date.now() }); }
      },
      {
        enableWebRTC: REMOTE_CONFIG.enableWebRTC, enableTurn: REMOTE_CONFIG.enableTurn, apiKey: head,
        // The status bar describes the focused pane's host — track its carrier too.
        onTransportChange: (type) => get()._patchHost(head, { carrier: type || "ws" })
      }
    );
    buses.set(head, pm);
    patch({ status: "connecting" });
    connectTimer = setTimeout(() => {
      if (get().hosts[head]?.status === "connecting") get()._patchHost(head, { status: "offline" });
    }, CONNECT_TIMEOUT_MS);
    pm.connect();
  },

  _patchHost(key, p) {
    set((prev) => {
      const h = prev.hosts[key];
      if (!h) return prev;
      return { hosts: { ...prev.hosts, [key]: { ...h, ...p } } };
    });
    schedulePersist(get);
  },

  // Status events, one implementation for every host bus (main singleton + fleet).
  applyStatusState(key, state) {
    const incoming = state || {};
    set((prev) => {
      const h = prev.hosts[key];
      if (!h || sameMap(h.statusMap, incoming)) return prev;
      return { hosts: { ...prev.hosts, [key]: { ...h, statusMap: incoming } } };
    });
    schedulePersist(get);
  },

  applyStatusChange(key, { sessionId, state, tool, since, conversationId } = {}) {
    if (!sessionId) return;
    set((prev) => {
      const h = prev.hosts[key];
      if (!h) return prev;
      const cur = h.statusMap[sessionId];
      const next = {
        state,
        tool: tool !== undefined ? tool : cur?.tool,
        since,
        ...(conversationId || cur?.conversationId ? { conversationId: conversationId || cur?.conversationId } : {})
      };
      if (sameEntry(cur, next)) return prev;
      return { hosts: { ...prev.hosts, [key]: { ...h, statusMap: { ...h.statusMap, [sessionId]: next } } } };
    });
    schedulePersist(get);
  },

  applyStatusCleared(key, sessionId) {
    if (!sessionId) return;
    set((prev) => {
      const h = prev.hosts[key];
      const cur = h?.statusMap?.[sessionId];
      if (!cur) return prev;
      return { hosts: { ...prev.hosts, [key]: { ...h, statusMap: { ...h.statusMap, [sessionId]: { ...cur, state: "idle" } } } } };
    });
    schedulePersist(get);
  },

  _closeHost(key) {
    const pm = buses.get(key);
    if (pm) { pm.disconnect(); buses.delete(key); }
    pendingByHost.delete(key);
    get()._patchHost(key, { status: "offline", lastSeenAt: Date.now() });
  },

  setFocus(key) {
    try { localStorage.setItem(FOCUS_KEY, key); } catch {}
    set({ focus: key });
  },

  // Lazy open: expanding a host's tree is what opens its bus — saved keys no
  // longer all connect on load (sync reads liveness in one batched request).
  ensureHost(key) {
    if (key === get().currentKey || buses.has(key)) return;
    get()._openHost(key);
  },

  // Connect a host: retry drops any dead bus and opens a fresh one — the open
  // itself persists the auto-connect intent (see _openHost).
  connectHost(key) {
    get().retryHost(key);
  },

  // Persist auto-connect without touching any bus now — for a key just added
  // (sync() opens it as part of the same settle) or the host a switchHost is
  // leaving (it was live a second ago; it must not land offline after reload).
  setAutoConnect(key, on) {
    setHostConnected(key, on);
  },

  // Manual reconnect for an offline root: drop its (dead) bus and open a fresh
  // one. No lastSeen bump — the machine has not actually been seen.
  retryHost(key) {
    const pm = buses.get(key);
    if (pm) { pm.disconnect(); buses.delete(key); }
    get()._openHost(key);
  },

  // The row's "Disconnect": drop the background bus (the host stays saved and
  // shows offline). Seeing it just now makes the lastSeen bump correct here.
  disconnectHost(key) {
    setHostConnected(key, false);
    get()._closeHost(key);
  },

  clearFocus() {
    // Writes "" instead of removing: the fleet view stays sticky across reloads
    // for single-key users too (null would drop them back into their host).
    try { localStorage.setItem(FOCUS_KEY, ""); } catch {}
    set({ focus: "" });
  },

  closeAll() {
    for (const pm of buses.values()) pm.disconnect();
    buses.clear();
    pendingByHost.clear();
    disarmProbeLoop();
    set({ overlayOpen: false });
  },

  openOverlay() { set({ overlayOpen: true }); },
  closeOverlay() { set({ overlayOpen: false }); }
}));
