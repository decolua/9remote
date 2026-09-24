"use client";

// HostConn — the one door every consumer reads a host through. Hosts differ ONLY
// in how they connect: the main host rides the workspace connection
// (useConnectionStore, login flow in useBus); a fleet host rides its lazy
// background bus (fleetStore). Everything downstream of connect — bus, file API,
// carrier, metadata, cache scope — is identical and comes from here, so no
// consumer ever branches on which kind of host it is looking at.

import { useConnectionStore } from "@/shared/stores/connectionStore";
import { useFleetStore, fleetBusOf } from "@/shared/stores/fleetStore";
import { useFileBusStore, makeFileBus } from "@/shared/stores/fileBusStore";
import { scopeOf } from "@/features/hosts/lib/fleetTree";

class HostConn {
  constructor(head) {
    this.head = head || null; // null = the main host
    this.scope = scopeOf(this.head);
    this._busRef = { current: null };
  }

  // Live bus facade or null (a fleet bus not open yet — callers wait, never fall
  // back to another host's bus). Read fresh on every access; no cached transport.
  get bus() {
    if (!this.head) {
      const st = useConnectionStore.getState();
      return st.connected ? (st.busRef?.current || st.bus) : null;
    }
    return fleetBusOf(this.head);
  }

  // Stable identity, always-fresh current: pollers subscribe once and read the
  // live bus on every tick, so a bus opening or a carrier switch never needs a
  // re-subscribe (and can never race one).
  get busRef() {
    this._busRef.current = this.bus;
    return this._busRef;
  }

  // Full file API over this host's bus — one implementation (makeFileBus), the
  // main singleton and every fleet facade are the same object shape.
  get fileBus() {
    if (!this._fileBus) {
      this._fileBus = this.head
        ? makeFileBus(() => fleetBusOf(this.head))
        : useFileBusStore.getState();
    }
    return this._fileBus;
  }

  get carrier() {
    if (!this.head) return useConnectionStore.getState().carrier || "ws";
    return useFleetStore.getState().hosts[this.head]?.carrier || "ws";
  }

  get platform() {
    return this.head ? (useFleetStore.getState().hosts[this.head]?.platform || null) : null;
  }

  get version() {
    return this.head ? (useFleetStore.getState().hosts[this.head]?.version || null) : null;
  }
}

// One instance per host key — identity stability is what keeps busRef/fileBus
// stable for effect dependencies.
const conns = new Map();

export function connOf(head) {
  // The current host's OWN head names the main connection (callers pass real
  // heads, not the "main" sentinel) — normalize it so every consumer gets the
  // workspace singleton, not a fleet facade over a bus that never exists.
  if (head && head === useFleetStore.getState().currentKey) return connOf(null);
  const key = head || "";
  let c = conns.get(key);
  if (!c) { c = new HostConn(head); conns.set(key, c); }
  return c;
}

// A session's host: the fleet head that owns the id, else the main host. Pure
// read — never opens a bus (side effects belong to action paths).
export function connForSession(sessionId) {
  if (sessionId) {
    const { hosts } = useFleetStore.getState();
    for (const h of Object.values(hosts)) {
      if (h.sessions?.some((s) => s.id === sessionId)) return connOf(h.key);
    }
  }
  return connOf(null);
}

// Reactive snapshot for components: one subscription per store, re-renders on
// status/carrier change. Main's platform/version stay null — the caller's props
// own those (they come from useAgentBus's serverInfo).
export function useHostConn(head) {
  if (head && head === useFleetStore.getState().currentKey) head = null;
  const mainConnected = useConnectionStore((s) => (head ? null : s.connected));
  const mainCarrier = useConnectionStore((s) => (head ? "ws" : s.carrier));
  const fleetHost = useFleetStore((s) => (head ? s.hosts[head] : null));
  if (!head) {
    return { head: null, connected: !!mainConnected, status: mainConnected ? "full" : "offline", carrier: mainCarrier || "ws", platform: null, version: null };
  }
  const status = fleetHost?.status || "offline";
  return { head, connected: status === "online", status, carrier: fleetHost?.carrier || "ws", platform: fleetHost?.platform || null, version: fleetHost?.version || null };
}
