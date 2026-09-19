"use client";

// The conductor's chat: a thin panel over the standalone agent. History comes
// from the host on open, steps stream in as jarvis:chat:event, sends go out as
// jarvis:chat — the host is the single source of every message on screen.
import { memo, useEffect, useRef, useState } from "react";
import { Bot, Send, Square } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";

// Persisted contents → the flat list this panel draws.
function historyToMessages(history = []) {
  const out = [];
  for (const turn of history) {
    for (const part of turn?.parts || []) {
      if (typeof part?.text === "string" && part.text) {
        out.push({ type: turn.role === "user" ? "user" : "assistant", text: part.text });
      } else if (part?.functionCall) {
        out.push({ type: "tool", name: part.functionCall.name, args: part.functionCall.args || {} });
      } else if (part?.functionResponse) {
        out.push({ type: "toolResult", name: part.functionResponse.name, text: JSON.stringify(part.functionResponse.response || {}).slice(0, 300) });
      }
    }
  }
  return out.slice(-80);
}

export const JarvisChatPanel = memo(function JarvisChatPanel({ bus }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);

  useEffect(() => {
    if (!bus?.emit) return;
    // Payload first, ack last — same shape every ai: emit uses.
    bus.emit("jarvis:chatHistory", {}, (res) => {
      if (res?.ok) setMessages(historyToMessages(res.history));
    });
    const onEvent = (ev) => {
      if (ev?.type === "assistant") setBusy(false);
      if (!ev?.type || ev.type === "user") return;
      setMessages((prev) => [...prev.slice(-160), ev]);
    };
    bus.on?.("jarvis:chat:event", onEvent);
    return () => bus.off?.("jarvis:chat:event", onEvent);
  }, [bus]);

  useEffect(() => {
    scroller.current?.scrollTo?.({ top: scroller.current.scrollHeight });
  }, [messages]);

  const send = () => {
    const text = input.trim();
    if (!text || busy || !bus?.emit) return;
    vibrate();
    setInput("");
    setBusy(true);
    // The host broadcasts the user turn back — no local echo, one source.
    bus.emit("jarvis:chat", { text }, (res) => {
      setBusy(false);
      if (res?.error) setMessages((prev) => [...prev, { type: "error", text: res.error }]);
    });
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto modal-scrollable px-3 py-3 flex flex-col gap-2.5">
        {messages.length === 0 && (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 text-text-muted p-4">
            <Bot size={28} className="opacity-50" />
            <span className="text-xs text-center leading-relaxed">
              Chat to coordinate — e.g. “create a demo task in 9router”, “who is free?”, “what is that worker doing?”
            </span>
          </div>
        )}
        {messages.map((m, i) => {
          if (m.type === "user") {
            return (
              <div key={i} className="self-end max-w-[85%] px-3 py-1.5 rounded-brand-lg rounded-br-sm bg-brand-500/15 text-sm text-text whitespace-pre-wrap break-words">
                {m.text}
              </div>
            );
          }
          if (m.type === "assistant") {
            return (
              <div key={i} className="self-start max-w-[85%] px-3 py-1.5 rounded-brand-lg rounded-bl-sm bg-surface-2 text-sm text-text whitespace-pre-wrap break-words">
                {m.text}
              </div>
            );
          }
          if (m.type === "error") {
            return <div key={i} className="self-start max-w-[85%] px-3 py-1.5 rounded-brand bg-red-500/10 text-xs text-red-400 break-words">{m.text}</div>;
          }
          return (
            <div key={i} className="self-start max-w-[85%] px-2 py-1 rounded-brand bg-surface-2/50 border border-border-subtle/60 text-[10px] font-mono text-text-muted break-words">
              <span className="text-brand-400">{m.name}</span>
              {m.type === "tool"
                ? `(${JSON.stringify(m.args).slice(0, 120)})`
                : ` → ${String(m.text || "").slice(0, 200)}`}
            </div>
          );
        })}
        {busy && <div className="self-start px-3 text-[11px] text-text-muted animate-pulse">Jarvis is thinking…</div>}
      </div>

      <div className="flex-shrink-0 border-t border-border-subtle p-2 flex items-end gap-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
          rows={1}
          placeholder="Delegate to Jarvis…"
          className="flex-1 resize-none max-h-32 px-3 py-2 rounded-brand bg-surface-2/40 border border-border-subtle text-sm text-text placeholder:text-text-muted/60 outline-none focus:border-brand-500/60 transition-colors"
        />
        <button
          type="button"
          onClick={send}
          disabled={busy || !input.trim()}
          className="p-2 rounded-brand bg-brand-500/15 text-brand-400 hover:bg-brand-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          aria-label="Send"
        >
          {busy ? <Square size={14} /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
});
