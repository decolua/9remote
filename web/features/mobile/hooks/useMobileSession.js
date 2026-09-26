"use client";

// Mirroring session lifecycle. Owns the stream meta the canvas and decoder are
// keyed on, and the one-tap path: picking a stopped AVD boots it, then streams.

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PRESET, streamOptionsFor } from "../constants/mobileConfig";
import { emitAck } from "./useMobileDevices";
import { useTerminalStore } from "@/shared/stores/terminalStore";

export function useMobileSession({ busRef, connected, devices, startAvd, stopAvd, stopping }) {
  // Serial and meta live in the store, not in this component: the desktop dock
  // remounts this tree when the user moves the mirror between float, pinned and
  // PiP, and a restarted stream there would cost a visible reconnect.
  const session = useTerminalStore((s) => s.mobileSession);
  const setSession = useTerminalStore((s) => s.setMobileSession);
  const serial = session?.serial ?? null;
  const meta = session?.meta ?? null;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);
  const startedRef = useRef(false);
  const cancelledRef = useRef(false);
  // Devices auto-open has already tried. A failed start leaves serial/meta
  // unset, so without this the effect re-fires on its own state change, forever.
  const autoTriedRef = useRef(new Set());

  // Adopt a session that outlived a remount, so stop() still knows to end it.
  useEffect(() => { if (meta) startedRef.current = true; }, [meta]);

  const stop = useCallback(() => {
    busRef?.current?.emit("mobile:stop");
    startedRef.current = false;
    setSession(null);
  }, [busRef, setSession]);

  // Cancel an in-flight open: stops whatever exists now (the agent supersedes
  // a pending mobile:start on mobile:stop), and open() shuts the device down
  // when its boot resolves after the cancel.
  const cancel = useCallback(() => {
    cancelledRef.current = true;
    stop();
  }, [stop]);

  const startStream = useCallback(async (targetSerial) => {
    // Size follows this viewport's real pixels, bitrate follows that size — a
    // fixed bitrate spread over a bigger frame is what made it look soft.
    const cssEdge = typeof window !== "undefined" ? Math.max(window.innerWidth, window.innerHeight) : 900;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
    const res = await emitAck(busRef?.current, "mobile:start", {
      serial: targetSerial,
      options: streamOptionsFor(DEFAULT_PRESET, cssEdge, dpr)
    });
    if (!res?.success) throw new Error(res?.error || "Failed to start");
    startedRef.current = true;
    setSession({ serial: targetSerial, meta: res.meta });
    return res.meta;
  }, [busRef, setSession]);

  /**
   * Open a device by row. A stopped AVD is booted first, so the user taps once
   * whether or not the emulator happens to be running.
   */
  const open = useCallback(async (device) => {
    if (!device) return;
    cancelledRef.current = false;
    setStarting(true);
    setError(null);
    autoTriedRef.current.add(device.id);
    try {
      const target = device.serial || (device.avdName ? await startAvd(device.avdName) : null);
      // Cancelled mid-boot: the emulator that just came up goes straight back
      // down, riding the picker's normal stopping state.
      if (cancelledRef.current) { if (target) stopAvd?.(target); return; }
      if (!target) throw new Error("Device did not start");
      await startStream(target);
      // Cancelled mid-start: the stream we just got is torn down with it.
      if (cancelledRef.current) { stop(); if (target) stopAvd?.(target); }
    } catch (e) {
      if (!cancelledRef.current) setError(e.message);
    } finally {
      setStarting(false);
    }
  }, [startAvd, startStream, stopAvd, stop]);

  // Auto-open when there is exactly one device AND it is already running —
  // booting an emulator is slow and costly, so that stays an explicit tap.
  useEffect(() => {
    if (meta || starting || serial) return;
    const live = devices.filter((d) => d.state === "running");
    if (live.length !== 1 || devices.length !== 1) return;
    const only = live[0];
    if (autoTriedRef.current.has(only.id)) return;
    // Stopping is not stopped: the row still reports "running" for seconds, and
    // re-opening it here would fight the shutdown the user just asked for.
    if (stopping?.has(only.serial)) return;
    // Deferred a tick so the effect never calls setState synchronously (React
    // cascading-render lint); cancelled if the deps change before it fires.
    const id = setTimeout(() => open(only), 0);
    return () => clearTimeout(id);
  }, [devices, meta, starting, serial, open, stopping]);

  // The agent restarts the encoder at a smaller size when the link cannot carry
  // the requested one. The canvas and decoder are keyed on meta, so adopting the
  // new meta is what re-sizes them.
  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !connected) return;
    const onResized = ({ meta: next }) => {
      if (!next) return;
      setSession((prev) => (prev ? { ...prev, meta: next } : prev));
    };
    bus.on("mobile:resized", onResized);
    return () => bus.off("mobile:resized", onResized);
  }, [busRef, connected, setSession]);

  // The agent tears the session down on disconnect; forget it here too so a
  // reconnect starts fresh instead of painting into a dead decoder.
  useEffect(() => {
    if (!connected && startedRef.current) {
      startedRef.current = false;
      setSession(null);
    }
  }, [connected, setSession]);

  // No stop-on-unmount: this tree is remounted whenever the desktop dock moves
  // the mirror, and the agent session is meant to survive that. It is ended by
  // the explicit close/stop paths instead.


  return { serial, meta, starting, error, setError, open, stop, cancel };
}
