"use client";

// Keeps the store's device count in step with the agent, for the whole session.
//
// Separate from useMobileDevices, which only lives while the mirror panel is
// open: the header button has to show whether a device is up even when the
// panel is closed, and a windowless emulator gives no other clue that it is.

import { useEffect } from "react";
import { useTerminalStore } from "@/shared/stores/terminalStore";

export function useMobileDeviceWatch({ socketRef, connected, enabled }) {
  const setMobileDeviceCount = useTerminalStore((s) => s.setMobileDeviceCount);
  const setMobileAvailable = useTerminalStore((s) => s.setMobileAvailable);

  useEffect(() => {
    const socket = socketRef?.current;
    if (!socket || !connected || !enabled) return;
    const onChanged = ({ count, available }) => {
      setMobileDeviceCount(count);
      if (typeof available === "boolean") setMobileAvailable(available);
    };
    socket.on("mobile:devicesChanged", onChanged);
    // The agent pushes its first count when the socket connects, which is before
    // this listener exists, and then only speaks up on change — so ask once for
    // the value already missed.
    socket.emit("mobile:deviceCount", {}, (res) => {
      if (res && typeof res.count === "number") setMobileDeviceCount(res.count);
      if (res && typeof res.available === "boolean") setMobileAvailable(res.available);
    });
    return () => {
      socket.off("mobile:devicesChanged", onChanged);
      // A dropped connection says nothing about the host's devices; clear it so
      // the button does not claim a device is up on a stale reading.
      setMobileDeviceCount(0);
      setMobileAvailable(false);
    };
  }, [socketRef, connected, enabled, setMobileDeviceCount, setMobileAvailable]);
}
