// HostRegistry — the one door for every host CONNECTION, kubeconfig-style: one
// context per host, no privileged peer. Owns the buses, deferred intents, the
// liveness probe loop and the connect-intent persistence; host DATA stays in
// the fleet store, reached only through the injected hooks. Pure JS on purpose
// — the whole layer is testable without React.

import { ProtocolManager } from "./ProtocolManager";
import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";
import { tailOf } from "@/shared/utils/apiKey";
import { setTrust } from "./lib/deviceTrust";

const CONNECTED_KEY = "9remote_fleet_connected";
// A bus that never opens (dead tunnel, pending device approval) fires neither
// onConnect nor onDisconnect — without a deadline the row would read
// "connecting" forever. Past it the host shows offline from its cache.
const CONNECT_TIMEOUT_MS = 15000;
// How often host liveness is re-read for hosts with no bus (the D1 heartbeat
// beats every 2 min server-side; polling makes a dead row go grey without
// needing to expand it).
const PROBE_INTERVAL_MS = 60000;

function readDeviceId() {
  if (typeof window === "undefined") return null;
  try { return localStorage.getItem("9remote_deviceId"); } catch { return null; }
}

function readConnected() {
  if (typeof window === "undefined") return [];
  try { return JSON.parse(localStorage.getItem(CONNECTED_KEY) || "[]"); } catch { return []; }
}

function writeConnected(head, on) {
  if (typeof window === "undefined" || !head) return;
  try {
    const set = new Set(readConnected());
    if (on) set.add(head); else set.delete(head);
    localStorage.setItem(CONNECTED_KEY, JSON.stringify([...set]));
  } catch {}
}

// Heads whose bus the user asked to keep connected — read at sync() so an F5
// reconnects without re-pressing.
export function savedConnectedHeads() {
  return readConnected();
}

export class HostRegistry {
  // hooks (all injected by the fleet store — the seam that keeps this pure):
  //   hostOf(head)        -> the store's row (or undefined): key/full/status
  //   patch(head, partial)-> write host state (status/lastSeen/carrier/…)
  //   bindBus(bus, head)  -> register the store's event listeners, once per bus
  //   ready(bus, head)    -> clientReady announce + metadata refetch (each connect)
  //   probeTargets()      -> heads with no bus, for the liveness loop
  //   servedBy(head)      -> true when another owner already holds this host's wire
  //   servedBus(head)     -> that owner's live bus, so intents still land
  constructor({ hostOf, patch, bindBus, ready, probeTargets, servedBy = null, servedBus = null }) {
    this._hostOf = hostOf;
    this._patch = patch;
    this._bindBus = bindBus;
    this._ready = ready;
    this._probeTargets = probeTargets;
    this._servedBy = servedBy || (() => false);
    this._servedBus = servedBus || (() => null);
    // head -> ProtocolManager (transport objects, deliberately not store state)
    this.buses = new Map();
    // Deferred intents: pressed while a bus is still opening, fired on connect.
    // Cleared on disconnect — a command never replays against a later session.
    this.pending = new Map();
    this._probeTimer = null;
    this._probeVisible = null;
  }

  busOf(head) {
    if (!head) return null;
    return this.buses.get(head)?.busRef?.current || null;
  }

  pmOf(head) {
    return this.buses.get(head) || null;
  }

  has(head) {
    return this.buses.has(head);
  }

  // Run fn with the host's live bus now, or defer until the bus connects
  // (opening it if needed). The single door for mutations — defer, never drop a
  // user intent that landed in the lazy-connect window.
  //
  // One wire per host, but ONE door for every host: a host another owner serves
  // (the workspace connection) still takes intents — through that owner's bus.
  // Only while it is up: nothing here may open a second wire to it, and a
  // deferred intent cannot ride a bus this registry does not own.
  whenReady(head, fn) {
    const row = this._hostOf(head);
    if (!head || !row) return;
    if (this._servedBy(head)) {
      const bus = this._servedBus(head);
      if (bus) fn(bus);
      return;
    }
    const bus = this.busOf(head);
    if (bus && row.status === "online") { fn(bus); return; }
    if (!this._canOpen(row, head)) return;
    this.open(head, row);
    const q = this.pending.get(head) || [];
    q.push(fn);
    this.pending.set(head, q);
  }

  // Persist connect intent without touching any bus now — for a key just added
  // or a host a switch is leaving (it was live a second ago).
  persistIntent(head, on) {
    writeConnected(head, on);
  }

  _canOpen(row, head) {
    if (!row) return false;
    // One wire per host: a host another owner serves is not this registry's to
    // open, and a host with no key of its own has no wire at all.
    if (this._servedBy(head)) return false;
    return !!row.full;
  }

  // Lazy open — every path (expand, connect button, retry, deferred intent)
  // lands here. `row` is the store's host entry; it needs a key of its own.
  open(head, row) {
    if (this.has(head)) return;
    const deviceId = readDeviceId();
    if (!this._canOpen(row, head) || !deviceId) return;
    this.persistIntent(head, true);
    // The tail rides device trust (idempotent — a previous login usually set it).
    const tail = tailOf(row.full);
    if (tail) setTrust(head, { tail });

    const patch = (p) => this._patch(head, p);
    let bound = false;
    let connectTimer = null;

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
          patch({ status: "online", lastSeenAt: Date.now(), updating: false, approval: null });
          // Deferred intents fire in press order, then the fresh lists land.
          const q = this.pending.get(head);
          if (q) { this.pending.delete(head); for (const fn of q) { try { fn(bus); } catch {} } }
          // The bus outlives carrier switches, so listeners bind once per PM.
          if (!bound) {
            bound = true;
            this._bindBus(bus, head);
          }
          this._ready(bus, head);
        },
        onDisconnect: () => {
          this.pending.delete(head);
          patch({ status: "offline", lastSeenAt: Date.now() });
        }
      },
      {
        enableWebRTC: REMOTE_CONFIG.enableWebRTC, enableTurn: REMOTE_CONFIG.enableTurn, apiKey: head,
        onTransportChange: (type) => patch({ carrier: type || "ws" })
      }
    );
    this.buses.set(head, pm);
    patch({ status: "connecting" });
    connectTimer = setTimeout(() => this._onConnectTimeout(head), CONNECT_TIMEOUT_MS);
    pm.connect();
  }

  // Only the still-connecting verdict flips: a bus that answered by now has
  // already patched online, and a carrier reconnect re-patches anyway.
  _onConnectTimeout(head) {
    if (!this.buses.has(head) || this._hostOf(head)?.status !== "connecting") return;
    this._patch(head, { status: "offline" });
    // A host that never answered is not auto-connected next visit either —
    // unless it is holding for approval, where the wait is on the user.
    if (this._hostOf(head)?.approval !== "pending") this.persistIntent(head, false);
  }

  // Drop a bus WITHOUT a status verdict — callers own the patch semantics
  // (plain disconnect vs rejected verdict stay the store's decision).
  drop(head) {
    const pm = this.buses.get(head);
    if (pm) { pm.disconnect(); this.buses.delete(head); }
    this.pending.delete(head);
  }

  // Manual reconnect for an offline root: drop its (dead) bus and open a fresh
  // one. No lastSeen bump — the machine has not actually been seen.
  retry(head) {
    this.drop(head);
    this.open(head, this._hostOf(head));
  }

  closeAll() {
    for (const pm of this.buses.values()) pm.disconnect();
    this.buses.clear();
    this.pending.clear();
    this.disarmProbe();
  }

  armProbe() {
    if (typeof window === "undefined" || this._probeTimer) return;
    this._probeTimer = setInterval(() => {
      if (!document.hidden) this.probeOnce();
    }, PROBE_INTERVAL_MS);
    this._probeVisible = () => {
      if (document.visibilityState === "visible") this.probeOnce();
    };
    document.addEventListener("visibilitychange", this._probeVisible);
  }

  disarmProbe() {
    if (!this._probeTimer) return;
    clearInterval(this._probeTimer);
    this._probeTimer = null;
    document.removeEventListener("visibilitychange", this._probeVisible);
    this._probeVisible = null;
  }

  // One batched liveness read for hosts NO bus owns — "online" here means
  // "recently beat"; the live bus confirms the moment a host is actually
  // opened. Runs per sync() and then on the probe cadence.
  probeOnce() {
    const heads = this._probeTargets().filter((h) => !this.has(h));
    if (!heads.length) return;
    fetch("/api/host-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heads })
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        for (const head of heads) {
          // A bus that opened while the fetch was out is never stamped over.
          if (this.has(head)) continue;
          const info = data?.hosts?.[head];
          if (!info) continue;
          this._patch(head, { status: info.online ? "online" : "offline" });
        }
      })
      .catch(() => {}); // keep whatever the rows already say — the next tick retries
  }
}
