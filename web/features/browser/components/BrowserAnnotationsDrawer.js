"use client";

import { useState } from "react";
import { Check, Copy, Send, Trash2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { OPEN_SESSION_EVENT } from "@/features/terminal/constants/terminalConfig";
import BrowserModalShell from "./BrowserModalShell";

export default function BrowserAnnotationsDrawer({ annotations = [], onDelete, onClear, onClose }) {
  const [copiedAll, setCopiedAll] = useState(false);
  const [sent, setSent] = useState(false);

  const buildPrompt = () => [
    `## Design & Code Feedback (${annotations.length} items)`,
    ...annotations.map((a, i) => [
      `\n### ${i + 1}. Element: \`<${a.tag}>\``,
      `- Selector: \`${a.selector}\``,
      a.text ? `- Text: "${a.text}"` : null,
      a.note ? `- **Requested Change**: ${a.note}` : null
    ].filter(Boolean).join("\n"))
  ].join("\n");

  const copyAll = async () => {
    if (!annotations.length) return;
    vibrate();
    await navigator.clipboard?.writeText?.(buildPrompt());
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 2000);
  };

  // Hand the compiled prompt to the first open AI chat pane: switch to it, then
  // fill its composer (the Composer listens for 9r:ai-prompt).
  const sendToAi = () => {
    if (!annotations.length) return;
    vibrate();
    const agentBySession = useTerminalStore.getState().agentBySession || {};
    const entry = Object.entries(agentBySession).find(([, agent]) => agent?.endsWith("-ui"));
    if (!entry) {
      copyAll(); // no AI pane open — copy is the fallback door
      return;
    }
    const [sessionId] = entry;
    const text = buildPrompt();
    useTerminalStore.getState().popView(); // drop the browser overlay first
    window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId } }));
    // The composer may still be mounting — send twice, the listener dedupes.
    for (const delay of [200, 700]) {
      setTimeout(() => window.dispatchEvent(new CustomEvent("9r:ai-prompt", { detail: { sessionId, text } })), delay);
    }
    setSent(true);
    setTimeout(() => setSent(false), 2000);
  };

  return (
    <BrowserModalShell
      title={`Collected Notes (${annotations.length})`}
      onClose={onClose}
      footer={
        annotations.length > 0 ? (
          <div className="flex items-center gap-2">
            <button
              onClick={sendToAi}
              className="flex-1 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-brand text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
              title="Send to the open AI chat"
            >
              {sent ? <Check size={13} /> : <Send size={13} />}
              {sent ? "Sent" : "Send to AI"}
            </button>
            <button
              onClick={copyAll}
              className="flex-1 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded-brand text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
            >
              {copiedAll ? <Check size={13} /> : <Copy size={13} />}
              {copiedAll ? "Copied" : "Copy All"}
            </button>
            <button
              onClick={onClear}
              className="p-2 text-text-muted hover:text-red-500 rounded-brand transition-colors"
              title="Clear all"
            >
              <Trash2 size={14} />
            </button>
          </div>
        ) : null
      }
    >
      {annotations.length === 0 ? (
        <div className="py-6 text-center text-xs text-text-muted">
          No annotations yet. Click the message icon on toolbar to annotate elements.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {annotations.map((item, idx) => (
            <div key={item.id || idx} className="p-2 rounded-brand bg-surface-2 border border-border-subtle flex items-start justify-between gap-2 text-xs">
              <div className="flex flex-col gap-1 min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold text-text">{idx + 1}.</span>
                  <span className="font-mono text-brand-500 font-medium">{item.tag}</span>
                  <span className="font-mono text-text-muted truncate">{item.selector}</span>
                </div>
                {item.note && (
                  <div className="text-text font-medium bg-surface/50 p-1.5 rounded">
                    {item.note}
                  </div>
                )}
              </div>
              <button
                onClick={() => onDelete?.(item.id)}
                className="p-1 text-text-muted hover:text-red-500 rounded shrink-0"
                title="Delete"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </BrowserModalShell>
  );
}
