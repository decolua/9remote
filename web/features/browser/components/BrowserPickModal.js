"use client";

import { useMemo, useState } from "react";
import { Check, ChevronLeft, Copy, Send, Trash2, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useFleetStore } from "@/shared/stores/fleetStore";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { connForSession, useAllSessionStatus } from "@/shared/transport/hostConn";
import { statusVisual } from "@/shared/utils/statusVisual";
import { OPEN_SESSION_EVENT } from "@/features/terminal/constants/terminalConfig";
import { agentIconUrl, AGENT_ICON_CLS } from "@/features/terminal/constants/agentCli";
import { buildPickPayload } from "@/features/browser/lib/pickPayload";
import BrowserModalShell from "./BrowserModalShell";

// Two steps in one modal: review the picked elements (copy / send), then pick
// which running session receives them.
export default function BrowserPickModal({ picked = [], url = null, onRemoveItem, onClear, onClose }) {
  const [step, setStep] = useState("review");
  const [prompt, setPrompt] = useState("");
  const [copied, setCopied] = useState(false);
  const [sentTo, setSentTo] = useState(null);
  const hosts = useFleetStore((s) => s.hosts);
  const currentKey = useFleetStore((s) => s.currentKey);
  const agentBySession = useTerminalStore((s) => s.agentBySession || {});
  const sessionStatus = useAllSessionStatus();

  // The typed prompt rides along with the picked elements — context for the
  // agent that receives them.
  const payload = useMemo(
    () => buildPickPayload(picked, url) + (prompt.trim() ? `\n\n${prompt.trim()}` : ""),
    [picked, url, prompt]
  );

  // Main host's sessions first, then other hosts' — the tab strip's own order.
  const sessions = useMemo(() => {
    const list = Object.values(hosts || {}).sort((a, b) => (a.key === currentKey ? -1 : b.key === currentKey ? 1 : 0));
    return list.flatMap((h) => (h.sessions || []).map((s) => ({ ...s, hostLabel: h.key === currentKey ? null : (h.label || h.key) })));
  }, [hosts, currentKey]);

  const copyAll = async () => {
    vibrate();
    await navigator.clipboard?.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ai:prompt is the one door: the host auto-creates an AI session (claude) for a
  // plain terminal, so every running session is a valid target.
  const sendToSession = (session) => {
    vibrate();
    const conn = connForSession(session.id);
    conn?.busRef?.current?.emit?.("ai:prompt", { sessionId: session.id, message: payload });
    useTerminalStore.getState().popView(); // drop the browser overlay first
    window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: { sessionId: session.id } }));
    setSentTo(session.id);
    onClear?.();
    setTimeout(onClose, 500);
  };

  if (step === "sessions") {
    return (
      <BrowserModalShell
        wide
        title="Send to Session"
        icon={<ChevronLeft size={14} className="text-text-muted shrink-0" />}
        onClose={onClose}
      >
        <div className="flex flex-col gap-1">
          {sessions.length === 0 && (
            <div className="py-6 text-center text-xs text-text-muted">No running sessions.</div>
          )}
          {sessions.map((s) => {
            const st = sessionStatus[s.id]?.state || "idle";
            const v = statusVisual(st);
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => sendToSession(s)}
                className="w-full text-left px-2.5 py-2 rounded-brand text-xs flex items-center gap-2 hover:bg-surface-2 transition-colors"
              >
                <span className="w-4 h-4 shrink-0 flex items-center justify-center relative">
                  {sentTo === s.id ? (
                    <Check size={14} className="text-emerald-500" />
                  ) : agentIconUrl(agentBySession[s.id]) ? (
                    <img src={agentIconUrl(agentBySession[s.id])} alt="" width={16} height={16} className={`w-4 h-4 object-contain ${AGENT_ICON_CLS}`} />
                  ) : (
                    <span className="w-1.5 h-1.5 rounded-full bg-text-muted" />
                  )}
                  {sentTo !== s.id && (
                    <span
                      className={`absolute -bottom-0.5 -right-0.5 w-1.5 h-1.5 rounded-full term-dot ${v.cls}${v.pulse ? ` pulse-${v.pulse}` : ""}`}
                      style={{ background: v.dot }}
                    />
                  )}
                </span>
                <span className="flex-1 min-w-0 truncate text-text">{s.name || "Terminal"}</span>
                {s.hostLabel && <span className="shrink-0 text-[10px] text-text-muted">{s.hostLabel}</span>}
              </button>
            );
          })}
        </div>
      </BrowserModalShell>
    );
  }

  return (
    <BrowserModalShell
      wide
      title={`Picked Elements (${picked.length})`}
      onClose={onClose}
      footer={
        <div className="flex items-center gap-2">
          <button
            onClick={() => { vibrate(); setStep("sessions"); }}
            disabled={!picked.length}
            className="flex-1 py-1.5 bg-brand-500 hover:bg-brand-600 disabled:opacity-40 disabled:pointer-events-none text-white rounded-brand text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
          >
            <Send size={13} />
            Send
          </button>
          <button
            onClick={copyAll}
            disabled={!picked.length}
            className="flex-1 py-1.5 bg-surface-2 hover:bg-surface-3 disabled:opacity-40 disabled:pointer-events-none text-text rounded-brand text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
          >
            {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={() => { vibrate(); onClear?.(); }}
            className="p-2 text-text-muted hover:text-red-500 rounded-brand transition-colors"
            title="Clear all"
          >
            <Trash2 size={14} />
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        {picked.map((it, idx) => (
          <div key={`${it.selector}-${idx}`} className="p-2 rounded-brand bg-surface-2 border border-border-subtle flex items-start justify-between gap-2 text-xs">
            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-text">{idx + 1}.</span>
                <span className="font-mono text-brand-500 font-medium">{it.tag}</span>
                <span className="font-mono text-text-muted truncate">{it.selector || it.tag}</span>
              </div>
              {it.text && <div className="text-text-muted truncate">{it.text}</div>}
            </div>
            <button
              onClick={() => { vibrate(); onRemoveItem?.(idx); }}
              className="p-1 text-text-muted hover:text-red-500 rounded shrink-0"
              title="Remove"
            >
              <X size={12} />
            </button>
          </div>
        ))}
        {/* Attached prompt — sent with the elements */}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Add a prompt for the receiving session…"
          rows={2}
          className="mt-1 p-2 bg-surface-2 border border-border-subtle rounded-brand text-xs text-text placeholder-text-muted focus:outline-none focus:border-brand-500 resize-none"
        />
      </div>
    </BrowserModalShell>
  );
}
