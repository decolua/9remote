"use client";

// Keeps every host's device count in step with its host, for the whole
// session — per-host entries, no main/fleet branch. Separate from
// useMobileDevices, which only lives while a mirror panel is open: the header
// buttons have to show whether a device is up even when the panel is closed.

import { useEffect } from "react";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { connOf } from "@/shared/transport/hostConn";

export function useMobileDeviceWatch() {
  // Primitive selector (joined heads): the map's identity changes on every
  // status tick, and re-attaching listeners per tick would churn every bus.
  // currentKey rides along: a host switch changes which bus is the workspace
  // connection without changing the online SET — watchers must re-bind.
  const onlineHeads = useFleetStore((s) => `${s.currentKey}|` + Object.values(s.hosts)
    .filter((h) => h.status === "online" || h.status === "full")
    .map((h) => h.key)
    .join(","));

  useEffect(() => {
    const st = useFleetStore.getState();
    const headsPart = onlineHeads.slice(onlineHeads.indexOf("|") + 1);
    const cleanups = [];
    for (const key of headsPart.split(",").filter(Boolean)) {
      const head = key === st.currentKey ? null : key;
      const bus = connOf(head).bus;
      if (!bus) continue;
      const apply = ({ count }) => useFleetStore.getState()._patchHost(key, { mobileDeviceCount: Number(count) || 0 });
      bus.on("mobile:devicesChanged", apply);
      // The host pushes its first count when the bus connects, which is before
      // this listener exists, and then only speaks up on change — so ask once
      // for the value already missed.
      bus.emit("mobile:deviceCount", {}, (res) => {
        if (res && typeof res.count === "number") apply(res);
      });
      cleanups.push(() => bus.off("mobile:devicesChanged", apply));
    }
    return () => { for (const fn of cleanups) fn(); };
  }, [onlineHeads]);
}
