"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "@/shared/components/ui/Icon";
import useClampedMenu from "@/shared/hooks/useClampedMenu";
import { vibrate } from "@/shared/utils/vibration";

// A "..." button opening a small anchored popover of actions — matching the desktop
// context menu (menu-popover). Items are { icon, label, danger?, amber?, onClick }; falsy
// entries are skipped. Pass `anchor` ({ left, top }) to open from outside (e.g. right-click).
export default function IconMenu({
  items, size = 12, label = "", revealCls = "", className = "", anchor = null, onClose
}) {
  const visible = items.filter(Boolean);
  const [selfAnchor, setSelfAnchor] = useState(null);
  const at = anchor ?? selfAnchor;
  const open = at !== null;
  const popRef = useRef(null);
  const pos = useClampedMenu(popRef, at?.left ?? 0, at?.top ?? 0);

  const close = useCallback(() => {
    setSelfAnchor(null);
    onClose?.();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  if (!visible.length) return null;

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          vibrate();
          if (open) {
            close();
            return;
          }
          const r = e.currentTarget.getBoundingClientRect();
          setSelfAnchor({ left: r.left, top: r.bottom + 2 });
        }}
        className={`p-0.5 text-text-subtle hover:text-text rounded-[2px] hover:bg-surface-2 transition-colors ${revealCls} ${className}`}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
      >
        <MoreHorizontal size={size} />
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <>
          {/* Backdrop intercepts outside clicks so they never click through to the view underneath */}
          <div
            className="fixed inset-0 z-[69]"
            onPointerDown={(e) => {
              e.stopPropagation();
              close();
            }}
            onClick={(e) => {
              e.stopPropagation();
              close();
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              close();
            }}
          />

          <div
            ref={popRef}
            role="menu"
            className="fixed z-[70] menu-popover p-1 min-w-[160px] animate-in fade-in zoom-in-95 duration-100 shadow-xl"
            style={{ left: pos.left, top: pos.top }}
          >
            {visible.map(({ icon: Icon, label: text, danger, amber, onClick }) => (
              <button
                key={text}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  vibrate();
                  close();
                  onClick?.();
                }}
                className={`w-full text-left px-2.5 py-1.5 text-xs rounded-[6px] flex items-center gap-2 transition-colors ${
                  danger ? "text-red-500 hover:bg-red-500/10"
                    : amber ? "text-amber-500 hover:bg-amber-500/10"
                    : "text-text hover:bg-surface-2/80"
                }`}
              >
                {Icon && <Icon size={13} className="flex-shrink-0" />}
                <span className="truncate">{text}</span>
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </>
  );
}
