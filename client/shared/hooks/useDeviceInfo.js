import { useMemo } from "react";

/**
 * Hook to detect device/platform info
 */
export function useDeviceInfo() {
  const isBrowser = typeof window !== "undefined";

  // Detect iOS PWA standalone mode
  const isIosPwa = useMemo(() => {
    if (!isBrowser) return false;
    const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
    const isStandalone = window.navigator.standalone === true;
    return isIos && isStandalone;
  }, [isBrowser]);

  // Detect OS type for keyboard layout
  const osType = useMemo(() => {
    if (!isBrowser) return "linux";
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
    return isMac ? "macos" : "linux";
  }, [isBrowser]);

  return {
    isIosPwa,
    osType
  };
}
