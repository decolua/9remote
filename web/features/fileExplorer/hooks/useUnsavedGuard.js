"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Stands between unsaved edits and anything that would throw them away — closing the
 * panel, going back, switching files, closing the browser tab.
 *
 * With auto-save gone this is the only thing keeping work from vanishing on a stray tap,
 * so it guards every exit rather than just the obvious one.
 */
export function useUnsavedGuard({ dirty, onSave }) {
  // The action waiting on an answer, held until the user picks one.
  const [pending, setPending] = useState(null);

  useEffect(() => {
    if (!dirty || typeof window === "undefined") return;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      // Browsers ignore the text and show their own, but returning a value is what
      // triggers the prompt at all.
      e.returnValue = "";
      return "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // Wrap a leaving action: runs straight away when clean, asks first when not.
  const guard = useCallback((action) => {
    if (!dirty) return action();
    setPending(() => action);
  }, [dirty]);

  const saveThenLeave = useCallback(async () => {
    const ok = await onSave();
    // A failed write keeps the dialog open — leaving now would discard the edits the
    // save was meant to keep.
    if (!ok) return;
    const action = pending;
    setPending(null);
    action?.();
  }, [onSave, pending]);

  const discardAndLeave = useCallback(() => {
    const action = pending;
    setPending(null);
    action?.();
  }, [pending]);

  const cancel = useCallback(() => setPending(null), []);

  return { guard, asking: !!pending, saveThenLeave, discardAndLeave, cancel };
}
