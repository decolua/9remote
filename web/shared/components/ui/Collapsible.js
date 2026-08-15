"use client";

import { createContext, useCallback, useContext, useId, useMemo, useState } from "react";
import { ChevronRight } from "@/shared/components/ui/Icon";

const CollapsibleContext = createContext(null);

export function Collapsible({ defaultOpen = false, open: controlledOpen, onOpenChange, className = "", children }) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = controlledOpen != null;
  const open = isControlled ? controlledOpen : uncontrolledOpen;
  const id = useId();

  const toggle = useCallback(() => {
    const next = !open;
    if (!isControlled) setUncontrolledOpen(next);
    onOpenChange?.(next);
  }, [open, isControlled, onOpenChange]);

  const value = useMemo(() => ({ open, toggle, id }), [open, toggle, id]);

  return (
    <CollapsibleContext.Provider value={value}>
      <div className={className} data-state={open ? "open" : "closed"}>{children}</div>
    </CollapsibleContext.Provider>
  );
}

export function CollapsibleTrigger({ className = "", children, showChevron = true, chevronSize = 12 }) {
  const ctx = useContext(CollapsibleContext);
  if (!ctx) return null;
  return (
    <button
      type="button"
      onClick={ctx.toggle}
      aria-expanded={ctx.open}
      aria-controls={ctx.id}
      className={className}
    >
      {showChevron && (
        <ChevronRight
          size={chevronSize}
          className={`flex-shrink-0 transition-transform duration-150 ${ctx.open ? "rotate-90" : ""}`}
        />
      )}
      {children}
    </button>
  );
}

export function CollapsibleContent({ className = "", children }) {
  const ctx = useContext(CollapsibleContext);
  if (!ctx || !ctx.open) return null;
  return <div id={ctx.id} className={className}>{children}</div>;
}

export function useCollapsible() {
  return useContext(CollapsibleContext);
}
