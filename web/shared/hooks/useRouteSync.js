"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { pathToView, viewToPath } from "@/features/terminal/constants/routeConfig";

// Two-way sync between browser URL and terminalStore viewStack.
// URL is the source of truth on navigation (back/forward/F5/deep-link);
// store changes push a matching URL so links stay shareable.
export function useRouteSync(hydrated) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { viewStack, pushView, setViewStack } = useTerminalStore();
  const currentView = viewStack[viewStack.length - 1];
  const lastSyncedPath = useRef(null);

  // URL -> store: apply view parsed from URL when it differs from current
  useEffect(() => {
    if (!hydrated) return;
    const view = pathToView(pathname, searchParams);
    if (!view) return;
    const target = viewToPath(view);
    if (target === lastSyncedPath.current) return; // already in sync
    lastSyncedPath.current = target;
    if (viewToPath(currentView) === target) return; // store already matches
    if (view.type === "list") {
      setViewStack([{ type: "list" }]);
    } else {
      pushView(view);
    }
  }, [hydrated, pathname, searchParams]);

  // store -> URL: reflect current view into the address bar
  useEffect(() => {
    if (!hydrated) return;
    const target = viewToPath(currentView);
    if (target === lastSyncedPath.current) return;
    lastSyncedPath.current = target;
    router.push(target);
  }, [hydrated, currentView]);
}
