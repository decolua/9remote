"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Copy, X, Check, Trash2, Plus } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";

const SAVE_DEBOUNCE_MS = 500;

// Quick checklist stored as markdown task-list text via the existing getNote/saveNote
// socket API — the agent never learns about checklists, it just keeps the text.
const ITEM_RE = /^- \[([ xX])\] ?/;

function parseItems(text) {
  return (text || "").split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
    const m = line.match(ITEM_RE);
    return m ? { done: m[1] !== " ", text: line.slice(m[0].length) } : { done: false, text: line };
  });
}

function serializeItems(items) {
  return items.map((i) => `- [${i.done ? "x" : " "}] ${i.text}`).join("\n");
}

export default function NotePanel({ socket, sessionId, appendOnOpen, onClose }) {
  const { t } = useI18n();
  const [items, setItems] = useState(null); // null until loaded
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  const itemsRef = useRef([]);
  const saveTimerRef = useRef(null);
  const appendRef = useRef(appendOnOpen);

  const doSave = useCallback((value) => {
    socket?.emit("saveNote", { sessionId, text: value }, () => {});
  }, [socket, sessionId]);

  // Any mutation flows through here: update state + debounce-save the whole list
  const mutate = useCallback((fn) => {
    setItems((prev) => {
      const next = fn(prev || []);
      itemsRef.current = next;
      return next;
    });
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      doSave(serializeItems(itemsRef.current));
    }, SAVE_DEBOUNCE_MS);
  }, [doSave]);

  // Load once on open; append selection text (each line = one unchecked item)
  useEffect(() => {
    if (!socket || !sessionId) return;
    let cancelled = false;
    socket.emit("getNote", { sessionId }, (res) => {
      if (cancelled) return;
      let next = parseItems(res?.success ? res.text : "");
      let appended = false;
      if (appendRef.current) {
        const extra = appendRef.current.split("\n").map((l) => l.trim()).filter(Boolean).map((text) => ({ done: false, text }));
        if (extra.length) { next = [...next, ...extra]; appended = true; }
        appendRef.current = null;
      }
      itemsRef.current = next;
      setItems(next);
      // Appended selection must survive a close-without-edit — save it now
      if (appended) doSave(serializeItems(next));
    });
    return () => { cancelled = true; };
  }, [socket, sessionId, doSave]);

  // Flush pending save on unmount
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        doSave(serializeItems(itemsRef.current));
      }
    };
  }, [doSave]);

  const handleAdd = (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    vibrate();
    setInput("");
    mutate((prev) => [...prev, { done: false, text }]);
  };

  const handleToggle = (idx) => {
    vibrate();
    mutate((prev) => prev.map((it, i) => (i === idx ? { ...it, done: !it.done } : it)));
  };

  const handleRemove = (idx) => {
    vibrate();
    mutate((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleCopy = async () => {
    vibrate();
    try {
      await navigator.clipboard?.writeText(serializeItems(items || []));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const handleClear = () => {
    vibrate();
    mutate(() => []);
  };

  const hasItems = (items?.length || 0) > 0;

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60] p-4"
      onMouseDown={(e) => { e.preventDefault(); onClose(); }}
    >
      <div
        className="card-elev w-full max-w-lg h-[55dvh] min-h-[300px] flex flex-col overflow-hidden"
        onMouseDown={(e) => { e.stopPropagation(); }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface flex-shrink-0">
          <span className="text-text text-sm font-medium">{t("note.title")}</span>
          <div className="flex items-center gap-1">
            <button onClick={handleCopy} disabled={!hasItems}
              className="p-2 hover:bg-surface-2 text-text rounded-brand transition-colors disabled:opacity-40"
              title={t("note.copy")}>
              {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
            </button>
            <button onClick={handleClear} disabled={!hasItems}
              className="p-2 hover:bg-surface-2 text-red-400 rounded-brand transition-colors disabled:opacity-40"
              title={t("note.clear")}>
              <Trash2 size={16} />
            </button>
            <button onClick={onClose}
              className="p-2 hover:bg-surface-2 text-text rounded-brand transition-colors"
              title="Close">
              <X size={16} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto">
          {items === null ? null : !hasItems ? (
            <p className="text-text-subtle text-sm px-4 py-6 text-center">{t("note.placeholder")}</p>
          ) : (
            <ul className="py-1">
              {items.map((item, idx) => (
                <li key={idx} className="flex items-center gap-2 px-3 py-1.5">
                  <button
                    onClick={() => handleToggle(idx)}
                    className={`w-5 h-5 flex-shrink-0 flex items-center justify-center rounded border-2 transition-colors ${
                      item.done ? "bg-brand-500 border-brand-500" : "border-border hover:border-brand-400"
                    }`}
                  >
                    {item.done && <Check size={13} className="text-white" />}
                  </button>
                  <span
                    onClick={() => handleToggle(idx)}
                    className={`flex-1 text-sm break-words cursor-pointer select-none ${
                      item.done ? "text-text-subtle line-through" : "text-text"
                    }`}
                  >
                    {item.text}
                  </span>
                  <button
                    onClick={() => handleRemove(idx)}
                    className="p-1.5 text-text-subtle hover:text-red-400 rounded-brand transition-colors"
                    title="Remove"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Render only after load — an add before getNote returns would be overwritten by the load callback */}
        {items !== null && (
        <form onSubmit={handleAdd} className="flex items-center gap-2 p-3 border-t border-border flex-shrink-0">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={t("note.placeholder")}
            className="flex-1 min-w-0 bg-surface-2 border border-border-subtle focus-within:border-brand-500 rounded-brand px-3 py-2 text-sm text-text outline-none placeholder:text-text-subtle transition-colors"
            autoFocus
          />
          <button type="submit" disabled={!input.trim()}
            className="p-2 bg-brand-500 hover:bg-brand-600 text-white rounded-brand transition-colors disabled:opacity-40"
            title="Add">
            <Plus size={16} />
          </button>
        </form>
        )}
      </div>
    </div>
  );
}
