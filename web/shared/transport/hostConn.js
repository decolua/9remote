"use client";

import { useMemo } from "react";

// HostConn — the one door every consumer reads a host through. Every host owns
// its own bus in the registry, so nothing here branches on which host it is
// looking at; host data (lists, statusMap, platform) lives in the fleet store
// for every host. What is left of the two-kinds split is only about *reading*:
// HostConn is a live view, useHostConn the reactive one.

import { useConnectionStore } from "@/shared/stores/connectionStore";
import { useFleetStore, fleetBusOf, fleetPmOf } from "@/shared/stores/fleetStore";
import { useFileBusStore, makeFileBus } from "@/shared/stores/fileBusStore";
import { scopeOf } from "@/features/hosts/lib/fleetTree";

class HostConn {
  constructor(head) {
    this.head = head || null; // null = whichever host the workspace is viewing
    this._busRef = { current: null };
    this._pmRef = { current: null };
  }

  get scope() {
    return scopeOf(this.head || useFleetStore.getState().currentKey || null);
  }

  // Live bus facade or null (a bus not open yet — callers wait, never fall back
  // to another host's bus). Read fresh on every access; no cached transport:
  // the viewed host's rides the connection store, every other host's the registry.
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

  // The transport itself, for features that drive it directly (remote desktop's
  // forceWsDisconnect, self-update retry widening). Live-read like `bus`.
  get pm() {
    if (!this.head) return useConnectionStore.getState().protocolRef?.current || null;
    return fleetPmOf(this.head);
  }

  get pmRef() {
    if (!this._pmRef) this._pmRef = { current: null };
    this._pmRef.current = this.pm;
    return this._pmRef;
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

  // serverInfo lands in the fleet entry for every host (write-through on main,
  // bus listener on fleet) — one lane, no main branch.
  get platform() {
    const st = useFleetStore.getState();
    return st.hosts[this.head || st.currentKey]?.platform || null;
  }

  get version() {
    const st = useFleetStore.getState();
    return st.hosts[this.head || st.currentKey]?.version || null;
  }
}

// One instance per host key — identity stability is what keeps busRef/fileBus
// stable for effect dependencies.
const conns = new Map();

export function connOf(head) {
  // The viewed host's OWN head maps to the live view (callers pass real heads,
  // not the "main" sentinel) — one instance per host key either way, but reading
  // it live is what lets a host switch leave stale buses behind.
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
// status/carrier change. Main's connection state still comes from the
// connection store (the singleton owns it); its data reads like any fleet host.
export function useHostConn(head) {
  const key = head && head === useFleetStore.getState().currentKey ? null : head;
  const mainConnected = useConnectionStore((s) => (key ? null : s.connected));
  const mainCarrier = useConnectionStore((s) => (key ? "ws" : s.carrier));
  const fleetHost = useFleetStore((s) => s.hosts[key || s.currentKey]);
  if (!key) {
    return { head: null, connected: !!mainConnected, status: mainConnected ? "full" : "offline", carrier: mainCarrier || "ws", platform: fleetHost?.platform || null, version: fleetHost?.version || null };
  }
  const status = fleetHost?.status || "offline";
  return { head: key, connected: status === "online", status, carrier: fleetHost?.carrier || "ws", platform: fleetHost?.platform || null, version: fleetHost?.version || null };
}

// A session's live state, whichever machine owns it — every host's status lives
// in its fleet entry's statusMap (main write-through, fleet bus listener).
// connForSession normalizes the main host's instance to head=null, so the read
// falls back to currentKey; an unknown id also reads main (pre-fleet behavior).
export function useSessionStatus(sessionId) {
  const head = sessionId ? connForSession(sessionId).head : null;
  const state = useFleetStore((s) => (sessionId ? s.hosts[head || s.currentKey]?.statusMap?.[sessionId]?.state : null));
  return state || "idle";
}

// Flat status map across every host, keyed by raw session id — the shape the
// bell, badge and sidebar lists read. Memoized on the hosts object (each patch
// makes a new one) so identity is stable between unrelated store changes.
export function useAllSessionStatus() {
  const hosts = useFleetStore((s) => s.hosts);
  return useMemo(() => {
    const out = {};
    for (const h of Object.values(hosts)) Object.assign(out, h.statusMap || {});
    return out;
  }, [hosts]);
}
