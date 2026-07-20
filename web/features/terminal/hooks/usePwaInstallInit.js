"use client";

import { useEffect } from "react";
import { usePwaInstallStore } from "@/shared/stores/pwaInstallStore";

// Module-scope guard: register the beforeinstallprompt listener exactly once
// per page load, so we capture the event even if it fires before React mounts.
let listenerRegistered = false;

function registerListeners() {
  if (listenerRegistered || typeof window === "undefined") return;
  listenerRegistered = true;

  const store = usePwaInstallStore.getState();

  const onBeforeInstallPrompt = (e) => {
    e.preventDefault();
    usePwaInstallStore.getState().setDeferredPrompt(e);
  };
  const onAppInstalled = () => {
    usePwaInstallStore.getState().setDeferredPrompt(null);
    usePwaInstallStore.getState().setIsInstalled(true);
  };

  window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
  window.addEventListener("appinstalled", onAppInstalled);

  if (window.matchMedia("(display-mode: standalone)").matches) {
    store.setIsInstalled(true);
    return;
  }

  // Chrome/Edge expose getInstalledRelatedApps — detects installed PWA even
  // when the user opens a plain browser tab (display-mode != standalone).
  if (navigator.getInstalledRelatedApps) {
    navigator.getInstalledRelatedApps()
      .then((apps) => {
        if (apps?.length) store.setIsInstalled(true);
      })
      .catch(() => {});
  }
}

// Call once near the app root. Keeps listener registration deterministic
// while still guarding against SSR (no window on the server).
export function usePwaInstallInit() {
  useEffect(() => {
    registerListeners();
  }, []);
}
