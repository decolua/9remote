"use client";

// Logcat tail. Filtering happens host-side; this holds a bounded ring so a
// long session can't grow the tab's memory without bound.

import { useCallback, useEffect, useRef, useState } from "react";
import { LOG_BUFFER_LINES, DEFAULT_LOG_LEVEL } from "../constants/mobileConfig";
import { emitAck } from "./useMobileDevices";

// "MM-DD HH:MM:SS.mmm  PID  TID L TAG: message"
const LINE_RE = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]*):\s?(.*)$/;

function parse(line, seq) {
  const m = LINE_RE.exec(line);
  if (!m) return { seq, time: "", level: "V", tag: "", message: line };
  return { seq, time: m[1].slice(6), level: m[2], tag: m[3].trim(), message: m[4] };
}

export function useMobileLogcat({ busRef, serial, active, foregroundPackage }) {
  const [lines, setLines] = useState([]);
  // Info and above by default: V and D are two thirds of a stock device's
  // output and are rarely what someone opened this panel to read.
  const [minLevel, setMinLevel] = useState(DEFAULT_LOG_LEVEL);
  const [search, setSearch] = useState("");
  // Default to whatever app is in the foreground: an unfiltered logcat is
  // mostly framework chatter, and it is the app being worked on that the panel
  // is opened for. "All apps" stays one click away.
  const [packageName, setPackageName] = useState(null);
  // Only until the user picks for themselves — after that their choice sticks,
  // including "all apps", which must not be overridden by an app switch.
  const pickedRef = useRef(false);
  useEffect(() => {
    if (pickedRef.current || !foregroundPackage) return;
    setPackageName(foregroundPackage);
  }, [foregroundPackage]);

  const choosePackage = useCallback((pkg) => {
    pickedRef.current = true;
    setPackageName(pkg);
  }, []);
  const [paused, setPaused] = useState(false);
  // Vendor per-frame spam is hidden by default; a device driver bug should not
  // bury the app output the panel exists to show.
  const [includeNoise, setIncludeNoise] = useState(false);
  const seqRef = useRef(0);
  // The bus handler is created once; it reads pause state through a ref so
  // toggling pause does not resubscribe and drop the tail.
  const pausedRef = useRef(false);
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const clear = useCallback(() => setLines([]), []);

  // Start/stop with the panel so a closed panel costs nothing on the host.
  useEffect(() => {
    const bus = busRef?.current;
    if (!bus || !serial || !active) return;

    // A different device is a different log — starting it appended the new
    // lines under the old device's, which read as one stream.
    setLines([]);

    const onLines = ({ lines: incoming }) => {
      if (pausedRef.current || !Array.isArray(incoming)) return;
      setLines((prev) => {
        const next = prev.concat(incoming.map((l) => parse(l, seqRef.current++)));
        return next.length > LOG_BUFFER_LINES ? next.slice(next.length - LOG_BUFFER_LINES) : next;
      });
    };
    bus.on("mobile:logcat", onLines);
    // packageName is omitted, not sent as null, until the user has chosen: that
    // lets the host scope to the foreground app immediately instead of
    // streaming everything until the app list arrives here.
    emitAck(bus, "mobile:logcatStart", {
      serial, minLevel, search, includeNoise,
      ...(pickedRef.current || packageName ? { packageName } : {})
    });

    return () => {
      bus.off("mobile:logcat", onLines);
      bus.emit("mobile:logcatStop");
    };
    // Filters are pushed by the effect below — restarting here would drop the tail.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busRef, serial, active]);

  // Filter changes are applied in place; no restart, so history is kept.
  useEffect(() => {
    if (!active || !serial) return;
    const id = setTimeout(() => {
      busRef?.current?.emit("mobile:logcatFilter", { minLevel, search, packageName, includeNoise });
    }, 200);
    return () => clearTimeout(id);
  }, [minLevel, search, packageName, includeNoise, active, serial, busRef]);

  return {
    lines, clear,
    minLevel, setMinLevel,
    search, setSearch,
    packageName, setPackageName: choosePackage,
    paused, setPaused,
    includeNoise, setIncludeNoise
  };
}
