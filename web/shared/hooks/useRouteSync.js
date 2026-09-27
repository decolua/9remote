"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams, useRouter } from "next/navigation";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useShallow } from "zustand/react/shallow";
import { pathToView, viewToPath, stackForUrl, OVERLAY_VIEWS } from "@/features/terminal/constants/routeConfig";

// URL is the single source of truth for navigation. Browser history drives the
// viewStack (URL -> store). Store changes from in-app forward actions (open
// terminal/remote/files) push a matching URL so links stay shareable.
// navSourceRef breaks the feedback loop: when URL drives store (browser Back),
// the store change must not push a new URL entry on top.
export function useRouteSync(hydrated) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { viewStack, pushView, setViewStack } = useTerminalStore(
    useShallow((s) => ({ viewStack: s.viewStack, pushView: s.pushView, setViewStack: s.setViewStack }))
  );
  const currentView = viewStack[viewStack.length - 1];
  // Overlay views have no URL of their own — compare against the view below them
  const routedView = OVERLAY_VIEWS.includes(currentView?.type)
    ? viewStack[viewStack.length - 2]
    : currentView;
  const lastSyncedPath = useRef(null);
  const prevViewRef = useRef(null);
  const prevStackLenRef = useRef(null);
  const navSourceRef = useRef(null); // "url" | "store"

  // URL -> store: apply view parsed from URL when it differs from current
  useEffect(() => {
    if (!hydrated) return;
    const view = pathToView(pathname, searchParams);
    if (!view) return;
    const target = viewToPath(view);
    if (target === lastSyncedPath.current) return; // already in sync
    lastSyncedPath.current = target;
    if (routedView && viewToPath(routedView) === target) return; // store already matches
    navSourceRef.current = "url";
    const nextStack = stackForUrl(viewStack, view);
    if (nextStack) setViewStack(nextStack);
    else pushView(view);
  }, [hydrated, pathname, searchParams]);

  // store -> URL: reflect forward navigation (open terminal/remote/files) into the URL.
  // Skipped when the change originated from URL (browser Back/Forward) or when the
  // URL already matches, so no duplicate history entries are created.
  useEffect(() => {
    if (!hydrated) return;
    // The URL→store effect above may have just replaced the stack in this same
    // commit; this effect's `currentView` is still the pre-update closure. Read
    // the live store so a stale view can never be mirrored back into the URL
    // (that is how /workspace rewrote itself to the last terminal).
    const live = useTerminalStore.getState().viewStack;
    const liveView = live[live.length - 1];
    if (!liveView) return;
    if (liveView !== currentView) {
      // Defer to the render that carries the live view.
      return;
    }
    // Overlay views (site browser) live outside the URL — nothing to mirror
    if (OVERLAY_VIEWS.includes(liveView?.type)) return;
    const target = viewToPath(liveView);
    if (target === lastSyncedPath.current) return;
    const currentUrlPath = viewToPath(pathToView(pathname, searchParams));
    const fromUrl = navSourceRef.current === "url";
    if (fromUrl) navSourceRef.current = null;
    // Tab switch within terminal view is same-level: replace (not push) so browser Back
    // returns to session list instead of the previous tab.
    const sameLevelTerminal = prevViewRef.current?.type === "terminal" && liveView?.type === "terminal";
    // Collapsing the whole stack back to its root is "leave this section", not a forward
    // move: pushing would leave the section behind a Back press that re-enters it.
    const toRoot = liveView?.type === "list" && live.length === 1;
    // A stack that shrank is a pop — pushing here would strand a duplicate entry behind
    // the OS back gesture (it slides a screen onto itself and looks stuck mid-way).
    const isPop = live.length < prevStackLenRef.current;
    navSourceRef.current = "store";
    lastSyncedPath.current = target;
    prevViewRef.current = liveView;
    prevStackLenRef.current = live.length;
    if (fromUrl || target === currentUrlPath) return;
    if (sameLevelTerminal || toRoot || isPop) router.replace(target);
    else router.push(target);
  }, [hydrated, currentView, pathname, searchParams]);
}
