"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Copy, X, Check, Trash2, Plus, GripVertical, Pin, PinOff, Maximize2 } from "@/shared/components/ui/Icon";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import { NOTE_SUGGESTIONS, NOTE_SYNC_EVENT, INPUT_ENTER_DELAY, INPUT_MAX_HEIGHT_MOBILE, INPUT_MAX_HEIGHT_DESKTOP, DESKTOP_BREAKPOINT } from "../constants/terminalConfig";
import { STATUS_BAR_HEIGHT } from "@/shared/constants/layout";

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

// Latest items per session, shared by every mount. Saves are debounced, so a strip that
// mounts right after the first item is added would read an empty note from the agent —
// and it mounts too late to hear the sync event. This is what it reads instead.
const noteCache = new Map();

const writeClipboard = (text) => {
  try { navigator.clipboard?.writeText(text).catch(() => {}); } catch {}
};

export default function NotePanel({ socket, sessionId, appendOnOpen, onClose, variant = "modal", pinned = false, onPin, onExpand }) {
  const { t } = useI18n();
  const noteChips = useTerminalStore((s) => s.noteChips);
  const addNoteChip = useTerminalStore((s) => s.addNoteChip);
  const removeNoteChip = useTerminalStore((s) => s.removeNoteChip);
  const [items, setItems] = useState(null); // null until loaded
  const [input, setInput] = useState("");
  const [copied, setCopied] = useState(false);
  // Copy accumulation: ids stacked so far — the clipboard always holds exactly these
  // rows joined in list order; the header copy marks every to-do row at once.
  const [marked, setMarked] = useState(() => new Set());
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState("");
  // Drag reorder. Only dragId is state (it restyles the row); the follow-the-finger
  // movement is written straight to style.transform, so a drag never re-renders the list.
  const [dragId, setDragId] = useState(null);
  const rowElsRef = useRef(new Map()); // item id -> <li> element
  const dragIdRef = useRef(null); // readable from the sync listener without re-subscribing
  const [addingChip, setAddingChip] = useState(false);
  const [chipInput, setChipInput] = useState("");
  const itemsRef = useRef([]);
  const inputRef = useRef(null);
  const idSeqRef = useRef(0);
  const saveTimerRef = useRef(null);
  const appendRef = useRef(appendOnOpen);
  const [instanceId] = useState(() => Symbol("note"));
  // Parents pass an inline onPin; a ref keeps it out of the load effect's deps
  const onPinRef = useRef(onPin);
  useEffect(() => { onPinRef.current = onPin; });

  const withIds = (list) => list.map((it) => ({ ...it, id: ++idSeqRef.current }));

  // Selection text handed in on open, consumed once, one item per line
  const appendLines = () => {
    const raw = appendRef.current;
    appendRef.current = null;
    if (!raw) return [];
    return raw.split("\n").map((l) => l.trim()).filter(Boolean).map((text) => ({ done: false, text }));
  };

  const doSave = useCallback((value) => {
    socket?.emit("saveNote", { sessionId, text: value }, () => {});
  }, [socket, sessionId]);

  // Any mutation flows through here: update state + debounce-save the whole list, and
  // tell this session's other NotePanel mount (pinned strip vs modal) about the change.
  const mutate = useCallback((fn) => {
    const next = fn(itemsRef.current || []);
    itemsRef.current = next;
    noteCache.set(sessionId, next);
    setItems(next);
    window.dispatchEvent(new CustomEvent(NOTE_SYNC_EVENT, { detail: { sessionId, items: next, from: instanceId } }));
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      doSave(serializeItems(itemsRef.current));
    }, SAVE_DEBOUNCE_MS);
  }, [doSave, sessionId, instanceId]);

  // Load once on open; append selection text (each line = one unchecked item)
  useEffect(() => {
    if (!socket || !sessionId) return;
    let cancelled = false;
    const cached = noteCache.get(sessionId);
    const adopt = (next, appended) => {
      for (const it of next) if (it.id > idSeqRef.current) idSeqRef.current = it.id;
      itemsRef.current = next;
      noteCache.set(sessionId, next);
      setItems(next);
      // Appended selection must survive a close-without-edit — save it now
      if (appended) doSave(serializeItems(next));
    };
    if (cached) {
      const extra = appendLines();
      adopt(extra.length ? [...cached, ...withIds(extra)] : cached, extra.length > 0);
      return;
    }
    socket.emit("getNote", { sessionId }, (res) => {
      if (cancelled) return;
      const next = parseItems(res?.success ? res.text : "");
      const extra = appendLines();
      // Selection text landing in an empty note starts a checklist too — pin it
      if (extra.length && !next.length) onPinRef.current?.(true);
      adopt(withIds([...next, ...extra]), extra.length > 0);
    });
    return () => { cancelled = true; };
  }, [socket, sessionId, doSave]);

  // Adopt changes made by this session's other mount — it already saved them
  useEffect(() => {
    const onSync = (e) => {
      const d = e.detail;
      if (!d || d.sessionId !== sessionId || d.from === instanceId) return;
      // A drag holds the pre-drag order; swapping the list under it would land the row
      // in the wrong slot. The drop broadcasts its own version a moment later anyway.
      if (dragIdRef.current != null) return;
      // That mount owns this version and is saving it; our pending save is now stale
      if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null; }
      // Ids are minted per mount, so keep ours ahead of any id we adopt — two mounts
      // must never hand out the same id to different items.
      for (const it of d.items) if (it.id > idSeqRef.current) idSeqRef.current = it.id;
      itemsRef.current = d.items;
      noteCache.set(sessionId, d.items);
      setItems(d.items);
    };
    window.addEventListener(NOTE_SYNC_EVENT, onSync);
    return () => window.removeEventListener(NOTE_SYNC_EVENT, onSync);
  }, [sessionId, instanceId]);

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

  // Auto-grow the add box up to the same cap the terminal input uses
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const cap = window.innerWidth >= DESKTOP_BREAKPOINT ? INPUT_MAX_HEIGHT_DESKTOP : INPUT_MAX_HEIGHT_MOBILE;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
  }, [input]);

  // Send splits the box on newlines — type or paste a block, get one item per line
  const handleAdd = (e) => {
    e.preventDefault();
    const lines = input.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) return;
    vibrate();
    setInput("");
    // Starting a checklist pins it: the point of writing one is to keep it in sight,
    // and the strip is where it stays visible. Only on the first items, never re-pinning
    // a list the user deliberately unpinned.
    if (!itemsRef.current.length) onPin?.(true);
    mutate((prev) => [...prev, ...withIds(lines.map((text) => ({ done: false, text })))]);
    inputRef.current?.focus();
  };

  const handleToggle = (id) => {
    vibrate();
    mutate((prev) => prev.map((it) => (it.id === id ? { ...it, done: !it.done } : it)));
  };

  const handleRemove = (id) => {
    vibrate();
    mutate((prev) => prev.filter((it) => it.id !== id));
  };

  // Pointer drag on the grip. Rows are moved by transform only while dragging — the
  // list state is committed once on release, so no re-render (and no debounced save)
  // fires per pointermove. Passed rows shift by one row-height to open the gap.
  const startDrag = (e, item) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    vibrate();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragIdRef.current = item.id;
    setDragId(item.id);

    const order = (itemsRef.current || []).map((it) => it.id);
    const fromIdx = order.indexOf(item.id);
    const self = rowElsRef.current.get(item.id);
    const rowH = self?.getBoundingClientRect().height || 0;
    const startY = e.clientY;
    let toIdx = fromIdx;
    let frame = null;

    const paint = (dy) => {
      frame = null;
      if (self) self.style.transform = `translateY(${dy}px)`;
      // Every other row slides one slot to open a gap where the dragged row will land
      order.forEach((id, i) => {
        if (id === item.id) return;
        const el = rowElsRef.current.get(id);
        if (!el) return;
        let shift = 0;
        if (fromIdx < toIdx && i > fromIdx && i <= toIdx) shift = -rowH;
        else if (fromIdx > toIdx && i >= toIdx && i < fromIdx) shift = rowH;
        el.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    };

    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      // Index the pointer has travelled to, in whole rows — no hit-testing needed
      const moved = rowH ? Math.round(dy / rowH) : 0;
      toIdx = Math.max(0, Math.min(order.length - 1, fromIdx + moved));
      if (frame) return;
      frame = requestAnimationFrame(() => paint(dy));
    };

    const clearTransforms = () => {
      if (frame) { cancelAnimationFrame(frame); frame = null; }
      for (const el of rowElsRef.current.values()) if (el) el.style.transform = "";
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      clearTransforms();
      dragIdRef.current = null;
      setDragId(null);
      if (toIdx === fromIdx) return;
      mutate((prev) => {
        const from = prev.findIndex((it) => it.id === item.id);
        if (from < 0) return prev;
        const next = [...prev];
        next.splice(Math.min(toIdx, next.length - 1), 0, next.splice(from, 1)[0]);
        return next;
      });
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const startEdit = (item) => {
    vibrate();
    setEditingId(item.id);
    setEditText(item.text);
  };

  const saveEdit = () => {
    const text = editText.trim();
    if (text && editingId != null) {
      mutate((prev) => prev.map((it) => (it.id === editingId ? { ...it, text } : it)));
    }
    setEditingId(null);
  };

  // Clipboard holds the marked rows in list order — recomputed from the next mark set
  const toggleCopyMark = (item) => {
    vibrate();
    const next = new Set(marked);
    if (next.has(item.id)) next.delete(item.id);
    else next.add(item.id);
    setMarked(next);
    writeClipboard((items || []).filter((it) => next.has(it.id)).map((it) => it.text).join("\n"));
  };

  const handleCopyTodo = () => {
    const todo = (items || []).filter((it) => !it.done);
    if (!todo.length) return;
    vibrate();
    // Marks land on the rows so the user sees exactly what went to the clipboard
    setMarked(new Set(todo.map((it) => it.id)));
    writeClipboard(todo.map((it) => it.text).join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const handleClearDone = () => {
    vibrate();
    mutate((prev) => prev.filter((it) => !it.done));
  };

  // A chip sends its text plus the checklist (markdown) into this pane's terminal
  const sendChip = (chip) => {
    vibrate();
    socket?.emit("input", { sessionId, data: `${chip}\n${serializeItems(items || [])}` });
    setTimeout(() => socket?.emit("input", { sessionId, data: "\r" }), INPUT_ENTER_DELAY);
    onClose();
  };

  const commitChip = () => {
    const text = chipInput.trim();
    if (text && !chips.includes(text)) addNoteChip(text);
    setChipInput("");
    setAddingChip(false);
  };

  const handleAddChip = (e) => {
    e.preventDefault();
    commitChip();
  };

  const hasItems = (items?.length || 0) > 0;
  const doneCount = items?.filter((it) => it.done).length || 0;
  const todoCount = (items?.length || 0) - doneCount;
  // Guard the spread: a corrupted persisted store must not crash the whole modal
  const chips = [...NOTE_SUGGESTIONS, ...(Array.isArray(noteChips) ? noteChips : [])];

  // Pinned: one thin strip at the very top of the pane showing only the current task —
  // the same shape as the bottom status bar, so it reads as chrome rather than a card.
  // Negative margins cancel the pane's padding so it spans edge to edge like that bar.
  // Ticking it advances to the next unchecked item; the modal (expand) holds the rest.
  if (variant === "pinned") {
    // Nothing to show yet (still loading, or every item deleted) — an empty strip would
    // just eat a terminal row. It comes back on its own once an item exists.
    if (!hasItems) return null;
    const current = items.find((it) => !it.done) || null;
    return (
      <div
        style={{ height: STATUS_BAR_HEIGHT }}
        className="flex items-center gap-2 px-2 -mt-1.5 -mx-1.5 mb-1.5 flex-shrink-0 bg-surface border-b border-border-subtle text-[11px] text-text-muted select-none"
        onMouseDown={(e) => e.stopPropagation()}
        onTouchStart={(e) => e.stopPropagation()}
      >
        {current ? (
          <>
            <button
              onClick={() => handleToggle(current.id)}
              className="w-3.5 h-3.5 flex-shrink-0 flex items-center justify-center rounded-[3px] border-2 border-border hover:border-brand-400 transition-colors"
              title={t("common.done")}
            />
            <span className="flex-1 min-w-0 truncate text-text" title={current.text}>{current.text}</span>
          </>
        ) : (
          <span className="flex-1 min-w-0 truncate">{t("note.allDone")}</span>
        )}
        <span className="flex-shrink-0 text-text-subtle">{doneCount}/{items.length}</span>
        <button
          onClick={() => { vibrate(); onExpand?.(); }}
          className="p-0.5 text-text-muted hover:text-text rounded-[2px] hover:bg-white/10 transition-colors flex-shrink-0"
          title={t("note.expand")}>
          <Maximize2 size={12} />
        </button>
        <button
          onClick={() => { vibrate(); onClose(); }}
          className="p-0.5 text-text-muted hover:text-text rounded-[2px] hover:bg-white/10 transition-colors flex-shrink-0"
          title={t("note.unpin")}>
          <X size={12} />
        </button>
      </div>
    );
  }

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
        <div className="flex items-center justify-between pl-4 pr-2 py-2 border-b border-border bg-surface flex-shrink-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="text-text text-sm font-medium truncate">{t("note.title")}</span>
            {hasItems && (
              <span className="text-xs text-text-subtle flex-shrink-0">{doneCount}/{items.length}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {onPin && (
              <button onClick={() => { vibrate(); onPin(!pinned); if (!pinned) onClose(); }}
                className={`p-2 hover:bg-surface-2 rounded-brand transition-colors ${pinned ? "text-brand-500" : "text-text"}`}
                title={pinned ? t("note.unpin") : t("note.pin")}>
                {pinned ? <PinOff size={16} /> : <Pin size={16} />}
              </button>
            )}
            <button onClick={handleCopyTodo} disabled={!todoCount}
              className="p-2 hover:bg-surface-2 text-text rounded-brand transition-colors disabled:opacity-40"
              title={t("note.copyTodo")}>
              {copied ? <Check size={16} className="text-green-400" /> : <Copy size={16} />}
            </button>
            <button onClick={handleClearDone} disabled={!doneCount}
              className="p-2 hover:bg-surface-2 text-red-400 rounded-brand transition-colors disabled:opacity-40"
              title={t("note.clearDone")}>
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
              {items.map((item) => (
                <li
                  key={item.id}
                  ref={(el) => { if (el) rowElsRef.current.set(item.id, el); else rowElsRef.current.delete(item.id); }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 ${
                    dragId === item.id
                      ? "relative z-10 bg-surface-2 shadow-elev select-none"
                      : dragId != null
                      ? "transition-transform duration-150 ease-out"
                      : ""
                  }`}
                >
                  <span
                    onPointerDown={(e) => startDrag(e, item)}
                    className={`p-1 -ml-1.5 flex-shrink-0 touch-none cursor-grab active:cursor-grabbing ${
                      dragId === item.id ? "text-brand-500" : "text-text-subtle/60 hover:text-text-subtle"
                    }`}
                    title={t("note.drag")}>
                    <GripVertical size={13} />
                  </span>
                  <button
                    onClick={() => handleToggle(item.id)}
                    className={`w-5 h-5 flex-shrink-0 flex items-center justify-center rounded border-2 transition-colors ${
                      item.done ? "bg-brand-500 border-brand-500" : "border-border hover:border-brand-400"
                    }`}
                  >
                    {item.done && <Check size={13} className="text-white" />}
                  </button>
                  {editingId === item.id ? (
                    <input
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveEdit();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      onBlur={saveEdit}
                      autoFocus
                      className="flex-1 min-w-0 bg-surface-2 border border-brand-500 rounded-brand px-2 py-1 text-sm text-text outline-none"
                    />
                  ) : (
                    <span
                      onClick={() => startEdit(item)}
                      className={`flex-1 min-w-0 text-sm break-words cursor-text ${
                        item.done ? "text-text-subtle line-through" : "text-text"
                      }`}
                      title={t("note.edit")}
                    >
                      {item.text}
                    </span>
                  )}
                  <button
                    onClick={() => toggleCopyMark(item)}
                    className={`p-1.5 rounded-brand transition-colors flex-shrink-0 ${
                      marked.has(item.id)
                        ? "text-brand-500 bg-brand-500/10"
                        : "text-text-subtle hover:text-text hover:bg-surface-2"
                    }`}
                    title={t("note.copyItem")}>
                    <Copy size={13} />
                  </button>
                  <button
                    onClick={() => handleRemove(item.id)}
                    className="p-1.5 text-text-subtle hover:text-red-400 rounded-brand transition-colors flex-shrink-0"
                    title={t("common.delete")}>
                    <X size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Suggestion chips: tap = send chip text + checklist into the pane's terminal.
            Rendered after load so an empty checklist disables the whole row. */}
        {items !== null && (
        <div className="flex items-center gap-1.5 px-3 py-2 border-t border-border flex-shrink-0 overflow-x-auto scrollbar-thin">
          {chips.map((chip) => (
            <div key={chip} className="flex items-center flex-shrink-0">
              <button
                onClick={() => sendChip(chip)}
                disabled={!hasItems}
                className="px-2 py-1 text-[11px] text-text-secondary bg-surface-2 hover:bg-surface-3 rounded-brand transition-colors disabled:opacity-40"
                title={t("note.sendHint")}>
                {chip}
              </button>
              {!NOTE_SUGGESTIONS.includes(chip) && (
                <button
                  onClick={() => { vibrate(); removeNoteChip(chip); }}
                  className="p-1 text-text-subtle hover:text-red-400 transition-colors"
                  title={t("note.removeChip")}>
                  <X size={10} />
                </button>
              )}
            </div>
          ))}
          {addingChip ? (
            <form onSubmit={handleAddChip} className="flex items-center flex-shrink-0">
              <input
                value={chipInput}
                onChange={(e) => setChipInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setAddingChip(false); setChipInput(""); } }}
                onBlur={commitChip}
                placeholder={t("note.chipPlaceholder")}
                autoFocus
                className="w-28 bg-surface-2 border border-border-subtle focus-within:border-brand-500 rounded-brand px-2 py-1 text-[11px] text-text outline-none placeholder:text-text-subtle"
              />
            </form>
          ) : (
            <button
              onClick={() => { vibrate(); setAddingChip(true); }}
              className="p-1 text-text-subtle hover:text-text hover:bg-surface-2 rounded-brand transition-colors flex-shrink-0"
              title={t("note.addChip")}>
              <Plus size={14} />
            </button>
          )}
        </div>
        )}

        {/* Render only after load — an add before getNote returns would be overwritten by the load callback */}
        {items !== null && (
        <form onSubmit={handleAdd} className="flex items-end gap-2 p-3 border-t border-border flex-shrink-0">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; Shift+Enter (or the mobile return key) breaks the line
              if (e.key === "Enter" && !e.shiftKey && window.innerWidth >= DESKTOP_BREAKPOINT) handleAdd(e);
            }}
            rows={1}
            placeholder={t("note.multilinePlaceholder")}
            className="flex-1 min-w-0 resize-none bg-surface-2 border border-border-subtle focus-within:border-brand-500 rounded-brand px-3 py-2 text-sm text-text outline-none placeholder:text-text-subtle transition-colors"
          />
          {/* Tapping the button would blur the box and drop the soft keyboard between
              items — swallow the blur, then hand focus straight back. */}
          <button type="submit" disabled={!input.trim()}
            onMouseDown={(e) => e.preventDefault()}
            className="p-2 bg-brand-500 hover:bg-brand-600 text-white rounded-brand transition-colors disabled:opacity-40 flex-shrink-0"
            title={t("note.addLines")}>
            <Plus size={16} />
          </button>
        </form>
        )}
      </div>
    </div>
  );
}
