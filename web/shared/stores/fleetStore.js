"use client";

import { create } from "zustand";
import { ProtocolManager } from "@/shared/transport/ProtocolManager";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { headOf, tailOf } from "@/shared/utils/apiKey";
import { setTrust } from "@/shared/transport/lib/deviceTrust";

// Fleet: one full host (the workspace's own connection) plus one background bus
// per other saved key. A background bus is a regular ProtocolManager connection
// that only ever asks for metadata (session/workspace lists + status events) —
// it joins no session channel, so its steady-state traffic is keepalive pings.
// It never touches useConnectionStore: that singleton belongs to the full host.

const DEVICE_ID_KEY = "9remote_deviceId";
const CACHE_KEY = "9remote_fleet_cache";
const FOCUS_KEY = "9remote_fleet_focus";
// Safari's per-origin WebSocket ceiling is the tightest budget the page lives under.
export const MAX_FLEET_HOSTS = 8;
const PERSIST_DEBOUNCE_MS = 1000;

// apiKey HEAD -> ProtocolManager (module-level: transport objects, not render state)
const buses = new Map();
let persistTimer = null;

function readDeviceId() {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem(DEVICE_ID_KEY); } catch { return null; }
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
  key, full: null, label: "", status: "offline",
  sessions: [], workspaces: [], statusMap: {},
  platform: null, version: null, lastSeenAt: null
});

export const useFleetStore = create((set, get) => ({
  hosts: {},
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
      return { hosts };
    });
    for (const head of wantedHeads) get()._openHost(head);
  },

  _openHost(head) {
    if (buses.has(head)) return;
    const entry = get().hosts[head];
    const deviceId = readDeviceId();
    if (!entry || !deviceId) return;
    // The tail rides device trust (idempotent — a previous login usually set it).
    const tail = tailOf(entry.full);
    if (tail) setTrust(head, { tail });

    const patch = (p) => get()._patchHost(head, p);
    let bound = false;

    // Metadata only: lists + status. The bus outlives carrier switches, so the
    // listeners bind once; later connects just refetch.
    const refetch = (bus) => {
      bus?.emit("getSessions", (list) => { if (Array.isArray(list)) patch({ sessions: list }); });
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
          patch({ status: "online", lastSeenAt: Date.now() });
          if (bound) { refetch(bus); return; }
          bound = true;
          // Carrier switch = a new socket server-side: re-announce, then refetch.
          bus.on("connect", () => { bus.emit("device:clientReady"); refetch(bus); });
          bus.on("serverInfo", (info) => patch({ platform: info?.platform || null, version: info?.version || null }));
          bus.on("statusState", (state) => patch({ statusMap: state || {} }));
          bus.on("statusChange", ({ sessionId, state, tool, since } = {}) => {
            if (!sessionId) return;
            const cur = get().hosts[head]?.statusMap || {};
            patch({ statusMap: { ...cur, [sessionId]: { state, tool, since } } });
          });
          bus.on("statusCleared", (sessionId) => {
            const cur = get().hosts[head]?.statusMap;
            if (!cur?.[sessionId]) return;
            patch({ statusMap: { ...cur, [sessionId]: { ...cur[sessionId], state: "idle" } } });
          });
          bus.on("sessionsChanged", () => refetch(bus));
          bus.on("workspacesChanged", () => refetch(bus));
          bus.on("session-renamed", () => refetch(bus));
          bus.on("sessionClosed", () => refetch(bus));
          bus.on("device:rejected", () => get()._closeHost(head));
          // ponytail: tailRejected with sealUnreadable just drops the host here;
          // upgrade path = mirror useAgentBus's drop-pin-and-retry when it bites.
          bus.on("device:tailRejected", () => get()._closeHost(head));
          bus.emit("device:clientReady");
          refetch(bus);
        },
        onDisconnect: () => get()._patchHost(head, { status: "offline", lastSeenAt: Date.now() })
      },
      { enableWebRTC: REMOTE_CONFIG.enableWebRTC, enableTurn: REMOTE_CONFIG.enableTurn, apiKey: head }
    );
    buses.set(head, pm);
    patch({ status: "connecting" });
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

  _closeHost(key) {
    const pm = buses.get(key);
    if (pm) { pm.disconnect(); buses.delete(key); }
    get()._patchHost(key, { status: "offline", lastSeenAt: Date.now() });
  },

  setFocus(key) {
    try { localStorage.setItem(FOCUS_KEY, key); } catch {}
    set({ focus: key });
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
    set({ overlayOpen: false });
  },

  openOverlay() { set({ overlayOpen: true }); },
  closeOverlay() { set({ overlayOpen: false }); }
}));
