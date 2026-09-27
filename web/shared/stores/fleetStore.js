"use client";

import { create } from "zustand";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { HostRegistry, savedConnectedHeads } from "@/shared/transport/hostRegistry";
import { headOf } from "@/shared/utils/apiKey";
import { isNewer } from "@/shared/utils/versionCompare";
import { sameEntry, sameMap } from "@/shared/utils/shallowEqual";
import { termLog } from "@/shared/utils/termLog";

// Fleet: every saved host is one registry context (hostRegistry owns the
// wires); this store owns the DATA — rows, statuses, verdicts — and the actions
// that decide what a transition means. The active host rides the workspace
// connection and lands here write-through, exactly like any fleet bus.

const CACHE_KEY = "9remote_fleet_cache";
// Safari's per-origin WebSocket ceiling is the tightest budget the page lives under.
export const MAX_FLEET_HOSTS = 8;
const PERSIST_DEBOUNCE_MS = 1000;
// A self-update (download + install + restart) must clear its inline spinner
// even when the host never comes back — about the same ceiling the old
// full-screen update flow allowed.
const HOST_UPDATE_TIMEOUT_MS = 120000;
let persistTimer = null;

function readCache() {
  if (typeof window === "undefined") return {};
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch { return {}; }
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
  platform: null, version: null, lastSeenAt: null,
  updateAvailable: null, canSelfUpdate: false, updating: false,
  approval: null,
  remoteAvailable: false, mobileAvailable: false,
  isCodespaces: false, mobileDeviceCount: 0
});

// ── Registry wiring ──────────────────────────────────────────────────────────
// The seam: pure transport below, store decisions above. `registry` is assigned
// right after the store exists (actions only ever run later).

const patchRow = (head, p) => useFleetStore.getState()._patchHost(head, p);

// Metadata only: lists + status. The bus outlives carrier switches, so the
// listeners bind once; later connects just refetch.
const refetch = (bus, head) => {
  bus?.emit("getSessions", (list) => {
    if (Array.isArray(list)) patchRow(head, { sessions: list });
  });
  bus?.emit("getWorkspaces", (list) => { if (Array.isArray(list)) patchRow(head, { workspaces: list }); });
  bus?.emit("getStatusState");
};

const bindBus = (bus, head) => {
  // Carrier switch = a new socket server-side: re-announce, then refetch.
  bus.on("connect", () => { bus.emit("device:clientReady"); refetch(bus, head); });
  bus.on("serverInfo", (info) => {
    // Mid-update the DYING process can still speak (its socket outlives the
    // install a moment) — its notice is stale by construction: the user already
    // acted on it, and the restart is what will tell the truth. Swallow it.
    const acted = !!useFleetStore.getState().hosts[head]?.updating;
    patchRow(head, {
    platform: info?.platform || null,
    isCodespaces: !!info?.isCodespaces,
    version: info?.version || null,
    // Honest notice: a host that ALREADY runs the offered version is not
    // offering an update (a stale flag on a not-yet-restarted process does).
    updateAvailable: !acted && isNewer(info?.updateAvailable?.version, info?.version) ? info.updateAvailable : null,
    canSelfUpdate: !!info?.canSelfUpdate,
    remoteAvailable: !!info?.remoteAvailable,
    mobileAvailable: !!info?.mobileAvailable
    });
  });
  bus.on("statusState", (state) => useFleetStore.getState().applyStatusState(head, state));
  bus.on("statusChange", (p) => useFleetStore.getState().applyStatusChange(head, p));
  bus.on("statusCleared", (id) => useFleetStore.getState().applyStatusCleared(head, id));
  bus.on("sessionsChanged", () => refetch(bus, head));
  bus.on("workspacesChanged", () => refetch(bus, head));
  bus.on("session-renamed", () => refetch(bus, head));
  // Same cleanup the main host's useAgentBus runs: a session closed on
  // that machine must drop its pane/tab/draft state here too.
  bus.on("sessionClosed", (sessionId) => {
    if (sessionId) useTerminalStore.getState().closeSession(sessionId);
    refetch(bus, head);
  });
  // Device admission: pending keeps the row alive waiting for the host's
  // answer; rejected drops the bus but LEAVES the verdict for the row's
  // retry/remove notice (retry may succeed once the machine un-denies).
  bus.on("device:pendingApproval", () => patchRow(head, { approval: "pending" }));
  bus.on("device:approved", () => patchRow(head, { approval: null }));
  bus.on("device:rejected", () => useFleetStore.getState()._closeHost(head, { approval: "rejected" }));
  // ponytail: tailRejected with sealUnreadable just drops the host here;
  // upgrade path = mirror useAgentBus's drop-pin-and-retry when it bites.
  bus.on("device:tailRejected", () => useFleetStore.getState()._closeHost(head));
};

let registry = null;

// ── Store ────────────────────────────────────────────────────────────────────

export const useFleetStore = create((set, get) => ({
  hosts: {},
  // The head the live workspace connection serves — the registry never opens a
  // second bus to it.
  currentKey: null,

  // Reconcile registry buses with the saved-key list. `currentKey` (a HEAD)
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

    for (const key of [...registry.buses.keys()]) {
      if (!wantedSet.has(key)) registry.drop(key);
    }

    const cached = readCache();
    const connectedSet = new Set(savedConnectedHeads());
    // A deliberate disconnect of the viewed host sticks across reloads: the row
    // boots offline (its connect button is the way back), not "full".
    let manualOff = false;
    try { manualOff = sessionStorage.getItem("9remote_manual_disconnect") === "1"; } catch {}
    set((prev) => {
      const hosts = {};
      for (const [head, info] of infoByHead) {
        const prior = prev.hosts[head] || { ...emptyHost(head), ...(cached[head] || {}) };
        hosts[head] = {
          ...prior,
          key: head,
          full: info.full,
          label: info.label || prior.label,
          status: head === current ? (manualOff ? "offline" : "full")
            : wantedSet.has(head) && (prior.status === "online" || prior.status === "connecting") ? prior.status
            : "offline"
        };
      }
      return { hosts, currentKey: current };
    });

    // Auto-connect hosts the user asked to keep connected
    for (const head of wantedHeads) {
      if (connectedSet.has(head)) registry.open(head, get().hosts[head]);
    }

    // Liveness for hosts without a bus is periodic (registry's probe loop) — a
    // one-shot read here would freeze each row at whatever the heartbeat said
    // at load, dead or alive.
    registry.probeOnce();
    registry.armProbe();
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

  // Drops the host's bus. The verdict patch defaults to "no verdict" (a plain
  // disconnect/cancel must not keep a stale approval notice alive); callers
  // override it with the standing answer they want the row to show.
  _closeHost(key, extraPatch = {}) {
    registry.drop(key);
    get()._patchHost(key, { status: "offline", lastSeenAt: Date.now(), approval: null, ...extraPatch });
  },

  // Lazy open: expanding a host's tree is what opens its bus — saved keys no
  // longer all connect on load (sync reads liveness in one batched request).
  ensureHost(key) {
    if (key === get().currentKey || registry.has(key)) return;
    registry.open(key, get().hosts[key]);
  },

  // Connect a host: retry drops any dead bus and opens a fresh one — the open
  // itself persists the auto-connect intent.
  connectHost(key) {
    get().retryHost(key);
  },

  // Web-triggered self-update/restart on ANY host — the row's inline progress
  // rides `updating`. The active host's bus is the workspace connection, every
  // other host its background bus; same door, no main/fleet branch for callers.
  requestHostUpdate(head, mode = "update") {
    const h = get().hosts[head];
    if (!h || h.updating) return;
    // The notice is acted on: drop it now so the pill cannot linger (or take a
    // second tap) while the host restarts. Whatever the machine reports on the
    // far side of the restart is the truth — the reconnect fills it back in.
    const clearNotice = { updating: true, updateAvailable: null };
    if (h.status === "full") {
      const cs = useConnectionStore.getState();
      const sock = cs.busRef?.current;
      if (!sock?.connected) { termLog("update", `request ${mode} on ACTIVE ${head} dropped: bus not connected`); return; }
      get()._patchHost(head, clearNotice);
      cs.protocolRef?.current?.setUpdating?.(true);
      sock.emit(mode === "restart" ? "requestRestart" : "requestUpdate");
    } else {
      get()._patchHost(head, clearNotice);
      // The PM may not exist yet (lazy bus) — widen inside the deferred fn too,
      // where it is guaranteed to be the bus about to carry the update.
      registry.pmOf(head)?.setUpdating?.(true);
      registry.whenReady(head, (bus) => {
        registry.pmOf(head)?.setUpdating?.(true);
        termLog("update", `request ${mode} sent on fleet bus ${head}`);
        bus.emit(mode === "restart" ? "requestRestart" : "requestUpdate");
      });
    }
    setTimeout(() => {
      if (get().hosts[head]?.updating) get()._patchHost(head, { updating: false });
    }, HOST_UPDATE_TIMEOUT_MS);
  },

  // Persist auto-connect without touching any bus now — for a key just added
  // (sync() opens it as part of the same settle) or the host a switchHost is
  // leaving (it was live a second ago; it must not land offline after reload).
  setAutoConnect(key, on) {
    registry.persistIntent(key, on);
  },

  // Manual reconnect for an offline root: drop its (dead) bus and open a fresh
  // one. No lastSeen bump — the machine has not actually been seen.
  retryHost(key) {
    registry.retry(key);
  },

  // The row's "Disconnect": drop the background bus (the host stays saved and
  // shows offline). Seeing it just now makes the lastSeen bump correct here.
  disconnectHost(key) {
    registry.persistIntent(key, false);
    get()._closeHost(key);
  },

  closeAll() {
    registry.closeAll();
  }
}));

registry = new HostRegistry({
  hostOf: (head) => useFleetStore.getState().hosts[head],
  patch: patchRow,
  bindBus,
  ready: (bus, head) => { bus.emit("device:clientReady"); refetch(bus, head); },
  // Only hosts the user still WANTS connected: a liveness read answers "is the
  // machine up", which must never resurrect a host the user deliberately
  // disconnected (persistIntent(false) is the off switch — respect it here).
  probeTargets: () => {
    const st = useFleetStore.getState();
    const wanted = new Set(savedConnectedHeads());
    return Object.values(st.hosts)
      .filter((h) => h.key !== st.currentKey && wanted.has(h.key))
      .map((h) => h.key);
  },
  // The workspace connection owns exactly one host's wire — whichever it is
  // viewing. Not a rank: the same host stops being served the moment the
  // workspace switches away, and the registry may open it like any other.
  servedBy: (head) => !!head && head === useFleetStore.getState().currentKey,
  // That owner's live bus, so an intent aimed at the host being viewed lands on
  // the wire that already exists instead of a second one.
  servedBus: () => {
    const cs = useConnectionStore.getState();
    return cs.connected ? (cs.busRef?.current || cs.bus) : null;
  }
});

// A host's client-bus facade, for callers that hold the HEAD (trees, actions).
export function fleetBusOf(head) {
  return registry?.busOf(head) || null;
}

// The host's ProtocolManager itself — features that drive the transport
// (remote desktop's forceWsDisconnect, self-update retry widening).
export function fleetPmOf(head) {
  return registry?.pmOf(head) || null;
}

// Run fn with the host's live bus facade now, or defer it until the bus connects
// (opening the bus if needed). The single door for fleet mutations — defer, never
// drop a user intent that landed in the lazy-connect window.
export function emitWhenReady(head, fn) {
  registry?.whenReady(head, fn);
}
