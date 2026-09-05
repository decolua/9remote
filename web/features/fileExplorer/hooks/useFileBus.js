"use client";

import { useFileBusStore } from "@/shared/stores/fileBusStore";

// File Explorer bus hook — delegates to useFileBusStore (backed by useConnectionStore)
export function useFileBus() {
  return useFileBusStore.getState();
}
