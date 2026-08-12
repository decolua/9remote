"use client";

import { useEffect, useRef } from "react";

export function useFileExplorerShortcuts({
  onToggleSidebar,
  onSave,
  onCloseTab,
  onCommandPalette,
  onQuickOpen,
  onTogglePanel
} = {}) {
  // Refs so the listener registers ONCE (no re-registration churn) and always
  // calls the latest callbacks. Registered on document capture phase to intercept
  // browser-level shortcuts (e.g. Cmd+W) before Chrome processes them.
  const cbRef = useRef({});
  useEffect(() => {
    cbRef.current = { onToggleSidebar, onSave, onCloseTab, onCommandPalette, onQuickOpen, onTogglePanel };
  });

  useEffect(() => {
    const handler = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const shift = e.shiftKey;
      const cb = cbRef.current;

      // mod+shift+p → command palette
      if (mod && shift && key === "p") { e.preventDefault(); cb.onCommandPalette?.(); return; }
      // mod+k → command palette (alternative)
      if (mod && !shift && key === "k") { e.preventDefault(); cb.onCommandPalette?.(); return; }
      // mod+p → quick open
      if (mod && !shift && key === "p") { e.preventDefault(); cb.onQuickOpen?.(); return; }
      // mod+s → save
      if (mod && !shift && key === "s") { e.preventDefault(); cb.onSave?.(); return; }
      // mod+w → close active editor tab (capture phase intercepts before browser)
      if (mod && !shift && key === "w") { e.preventDefault(); cb.onCloseTab?.(); return; }
      // mod+b → toggle sidebar
      if (mod && !shift && key === "b") { e.preventDefault(); cb.onToggleSidebar?.(); return; }
      // mod+j → toggle panel (optional)
      if (mod && !shift && key === "j" && cb.onTogglePanel) { e.preventDefault(); cb.onTogglePanel(); }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, []);
}
