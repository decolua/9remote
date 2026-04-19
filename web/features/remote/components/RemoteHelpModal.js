"use client";

import { X } from "@/shared/components/ui/Icon";

// Build help sections based on current mode. Keep it SHORT — only the essentials.
function buildSections(inputMode, pointerMode) {
  // PC mode — physical mouse + keyboard
  if (inputMode === "mouse") {
    return [
      {
        title: "Mouse",
        items: [
          { key: "Click / Drag", desc: "Left-click, drag to select/move" },
          { key: "Right-click", desc: "Context menu on remote" },
          { key: "Wheel", desc: "Scroll remote (Shift + Wheel = horizontal)" },
          { key: "Double-click", desc: "Double-click on remote" }
        ]
      },
      {
        title: "Keyboard",
        items: [
          { key: "Physical keys", desc: "Sent directly (Tab, F-keys, etc. captured)" },
          { key: "Ctrl / Alt / Shift / ⌘", desc: "Sticky modifier — combine with next key" }
        ]
      }
    ];
  }

  // Touch — Trackpad (virtual cursor ✋)
  if (pointerMode === "trackpad") {
    return [
      {
        title: "Gestures (Trackpad ✋)",
        items: [
          { key: "1 finger swipe", desc: "Move virtual cursor" },
          { key: "1 finger tap", desc: "Left-click at cursor" },
          { key: "2 fingers tap", desc: "Right-click at cursor" },
          { key: "2 fingers swipe", desc: "Scroll at cursor position" },
          { key: "2 fingers pinch", desc: "Zoom canvas" }
        ]
      },
      {
        title: "Toolbar",
        items: [
          { key: "✋", desc: "Hold left-click (drag mode) — tap again to release" },
          { key: "🖱️", desc: "Switch to Direct mode" },
          { key: "⌨️ / Aa", desc: "Native keyboard / text batch input" }
        ]
      }
    ];
  }

  // Touch — Direct
  return [
    {
      title: "Gestures (Direct)",
      items: [
        { key: "1 finger tap", desc: "Click at tap position" },
        { key: "1 finger long-press", desc: "Right-click" },
        { key: "1 finger double-tap", desc: "Double-click" },
        { key: "2 fingers swipe", desc: "Scroll remote" },
        { key: "2 fingers pinch", desc: "Zoom canvas" },
        { key: "1 finger drag (zoom>1)", desc: "Pan canvas" }
      ]
    },
    {
      title: "Toolbar",
      items: [
        { key: "🖱️", desc: "Switch to Trackpad (virtual cursor)" },
        { key: "⌨️ / Aa", desc: "Native keyboard / text batch input" },
        { key: "□", desc: "Rectangle selection mode" }
      ]
    }
  ];
}

export default function RemoteHelpModal({ onClose, inputMode = "touch", pointerMode = "direct" }) {
  const sections = buildSections(inputMode, pointerMode);
  const modeLabel = inputMode === "mouse"
    ? "PC / Mouse"
    : pointerMode === "trackpad"
      ? "Touch · Trackpad"
      : "Touch · Direct";

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-dark-600 border border-dark-400 rounded-brand max-w-lg w-full max-h-[80vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-dark-400 sticky top-0 bg-dark-600 z-10">
          <div className="flex items-baseline gap-2">
            <h2 className="text-white text-base font-semibold">Help</h2>
            <span className="text-brand-400 text-xs font-mono">{modeLabel}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-dark-500 text-dark-100 hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {sections.map((section) => (
            <div key={section.title}>
              <h3 className="text-brand-400 text-xs font-semibold uppercase tracking-wider mb-2">
                {section.title}
              </h3>
              <ul className="space-y-1.5">
                {section.items.map((item) => (
                  <li key={item.key} className="flex gap-3 text-sm">
                    <span className="text-white font-mono bg-dark-700 px-2 py-0.5 rounded text-xs shrink-0 min-w-[120px] text-center">
                      {item.key}
                    </span>
                    <span className="text-dark-100">{item.desc}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
