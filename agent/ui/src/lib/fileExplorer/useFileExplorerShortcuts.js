import { useEffect } from "preact/hooks";

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA"]);

function isEditableTarget(target) {
  if (!target) return false;
  if (EDITABLE_TAGS.has(target.tagName)) return true;
  if (target.isContentEditable) return true;
  return false;
}

export function useFileExplorerShortcuts({
  onToggleSidebar,
  onSave,
  onCloseTab,
  onCommandPalette,
  onQuickOpen,
  onTogglePanel,
} = {}) {
  useEffect(() => {
    const handler = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      const shift = e.shiftKey;

      if (shift && key === "p") { e.preventDefault(); onCommandPalette?.(); return; }
      if (!shift && key === "k") { e.preventDefault(); onCommandPalette?.(); return; }
      if (!shift && key === "p") { e.preventDefault(); onQuickOpen?.(); return; }
      if (!shift && key === "s") { e.preventDefault(); onSave?.(); return; }
      if (!shift && key === "w") {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        onCloseTab?.();
        return;
      }
      if (!shift && key === "b") { e.preventDefault(); onToggleSidebar?.(); return; }
      if (!shift && key === "j" && onTogglePanel) { e.preventDefault(); onTogglePanel(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onToggleSidebar, onSave, onCloseTab, onCommandPalette, onQuickOpen, onTogglePanel]);
}
