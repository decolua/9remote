"use client";

import { X } from "@/shared/components/ui/Icon";

// Static help content — grouped by category
const HELP_SECTIONS = [
  {
    title: "Gestures",
    items: [
      { key: "1 finger tap", desc: "Click" },
      { key: "1 finger long-press", desc: "Right-click" },
      { key: "1 finger double-tap", desc: "Double-click" },
      { key: "2 fingers pinch", desc: "Zoom canvas" },
      { key: "2 fingers swipe", desc: "Scroll remote" },
      { key: "1 finger drag (zoom>1)", desc: "Pan canvas" }
    ]
  },
  {
    title: "Pointer modes",
    items: [
      { key: "Direct", desc: "Tap position = cursor position" },
      { key: "Trackpad", desc: "Swipe to move virtual cursor (like laptop trackpad)" }
    ]
  },
  {
    title: "Toolbar keys",
    items: [
      { key: "⌨️", desc: "Toggle device native keyboard (always visible when on)" },
      { key: "Aa", desc: "Open text batch input panel (type then Send)" },
      { key: "□", desc: "Rectangle selection mode (drag to select)" },
      { key: "🖱️", desc: "Toggle Direct / Trackpad pointer mode" },
      { key: "Copy / Paste", desc: "Send Ctrl+C / Ctrl+V to remote" },
      { key: "Ctrl / Alt / Shift / ⌘", desc: "Sticky modifier — combine with next key" }
    ]
  },
  {
    title: "Arrow keys",
    items: [
      { key: "↑ ↓ ← →", desc: "Enable native keyboard (⌨️) then use arrow keys from device" }
    ]
  }
];

export default function RemoteHelpModal({ onClose }) {
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
          <h2 className="text-white text-base font-semibold">Remote Desktop — Help</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-dark-500 text-dark-100 hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {HELP_SECTIONS.map((section) => (
            <div key={section.title}>
              <h3 className="text-brand-400 text-xs font-semibold uppercase tracking-wider mb-2">
                {section.title}
              </h3>
              <ul className="space-y-1.5">
                {section.items.map((item) => (
                  <li key={item.key} className="flex gap-3 text-sm">
                    <span className="text-white font-mono bg-dark-700 px-2 py-0.5 rounded text-xs shrink-0 min-w-[100px] text-center">
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
