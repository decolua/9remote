"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Send, Sparkles, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import BrowserModalShell from "./BrowserModalShell";

// Element detail: a centered modal when raised from grab/context-menu; the
// annotate intent anchors a compact card at the tapped element (orca pattern).
export default function BrowserInspectSheet({ element, autoFocusNote = false, at = null, onAddAnnotation, onClose }) {
  const [note, setNote] = useState("");
  const [copiedSel, setCopiedSel] = useState(false);
  const [copiedAi, setCopiedAi] = useState(false);
  const [added, setAdded] = useState(false);
  const noteRef = useRef(null);

  useEffect(() => {
    if (autoFocusNote) noteRef.current?.focus();
  }, [autoFocusNote]);

  if (!element) return null;

  const selector = element.selector || element.tag || "element";

  const copySelector = async () => {
    vibrate();
    await navigator.clipboard?.writeText(selector);
    setCopiedSel(true);
    setTimeout(() => setCopiedSel(false), 2000);
  };

  const copyForAi = async () => {
    vibrate();
    const prompt = [
      `### Target Element: \`<${element.tag}>\``,
      `- Selector: \`${selector}\``,
      element.text ? `- Text: "${element.text}"` : null,
      element.html ? `- HTML: \`${element.html.slice(0, 300)}\`` : null,
      note ? `- Instructions: ${note}` : null
    ].filter(Boolean).join("\n");
    await navigator.clipboard?.writeText(prompt);
    setCopiedAi(true);
    setTimeout(() => setCopiedAi(false), 2000);
  };

  const handleAddNote = () => {
    vibrate();
    onAddAnnotation?.({
      id: Date.now().toString(),
      tag: element.tag,
      selector,
      text: element.text,
      html: element.html,
      note: note.trim()
    });
    setAdded(true);
    setTimeout(() => {
      setAdded(false);
      onClose();
    }, 800);
  };

  const header = (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="px-1.5 py-0.5 rounded bg-brand-500/10 text-brand-500 font-mono text-xs font-semibold uppercase">
        {element.tag}
      </span>
      <span className="font-mono text-xs text-text truncate">
        {selector}
      </span>
    </div>
  );

  const body = (
    <>
      {!at && <div className="pb-1">{header}</div>}
      {element.text && (
        <div className="text-xs text-text-muted bg-surface-2 p-2 rounded-brand font-mono line-clamp-2">
          {element.text}
        </div>
      )}

      {element.styles && (
        <div className="flex flex-wrap gap-2 text-[11px] text-text-muted font-mono">
          {element.styles.display && <span>display: {element.styles.display}</span>}
          {element.styles.fontSize && <span>size: {element.styles.fontSize}</span>}
          {element.styles.color && <span>color: {element.styles.color}</span>}
        </div>
      )}

      <input
        ref={noteRef}
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleAddNote()}
        placeholder="Note for AI (e.g. change color to dark, fix alignment...)"
        className="w-full px-2.5 py-1.5 bg-surface-2 rounded-brand text-xs text-text placeholder-text-muted focus:outline-none focus:ring-1 focus:ring-brand-500"
      />
    </>
  );

  const actions = (
    <>
      <button
        onClick={copySelector}
        className="flex-1 py-1.5 bg-surface-2 hover:bg-surface-3 text-text rounded-brand text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
      >
        {copiedSel ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
        {copiedSel ? "Copied" : "Copy Selector"}
      </button>
      <button
        onClick={copyForAi}
        className="flex-1 py-1.5 bg-brand-500 hover:bg-brand-600 text-white rounded-brand text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
      >
        {copiedAi ? <Check size={13} /> : <Sparkles size={13} />}
        {copiedAi ? "Copied AI Prompt" : "Copy for AI"}
      </button>
      <button
        onClick={handleAddNote}
        className="px-3 py-1.5 bg-surface-2 hover:bg-surface-3 rounded-brand text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
      >
        {added ? <Check size={13} className="text-emerald-500" /> : <Send size={13} />}
        {added ? "Saved" : "Add Note"}
      </button>
    </>
  );

  if (at) {
    return (
      <div
        className="z-30 bg-surface border border-border-subtle shadow-2xl p-3 flex flex-col gap-2.5 overflow-y-auto animate-in fade-in duration-150 absolute w-[300px] max-w-[90%] max-h-[60%] rounded-xl"
        style={{
          left: `min(${at.x}px, calc(100% - 310px))`,
          top: `min(${at.y}px, calc(100% - 120px))`
        }}
      >
        <div className="flex items-center justify-between">
          {header}
          <button onClick={onClose} className="p-1 text-text-muted hover:text-text rounded-brand shrink-0" title="Close">
            <X size={15} />
          </button>
        </div>
        {body}
        <div className="flex items-center gap-2 pt-1">{actions}</div>
      </div>
    );
  }

  return (
    <BrowserModalShell title="Inspect Element" onClose={onClose} footer={<div className="flex items-center gap-2">{actions}</div>}>
      <div className="flex flex-col gap-2.5">
        {body}
      </div>
    </BrowserModalShell>
  );
}
