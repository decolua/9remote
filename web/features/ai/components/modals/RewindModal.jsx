"use client";

import { memo, useCallback, useEffect, useState } from "react";
import { History, Loader2, CornerDownLeft, AlertCircle, Check } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { ModalShell } from "./ModalShell";

function relativeAge(ms) {
  if (!ms) return "";
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Rewind the conversation to an earlier prompt, and the files with it where the engine
// keeps backups. The turns come from the host (`ai:rewind list`), so this modal never
// guesses what is rewindable — an engine without support shows the host's own reason.
export const RewindModal = memo(function RewindModal({
  sessionId = "",
  onListPoints,
  onPreview,
  onApply,
  onClose
}) {
  const [points, setPoints] = useState([]);
  const [support, setSupport] = useState(null);
  const [loading, setLoading] = useState(true);
  // The turn picked for preview, and what the host says it would change.
  const [picked, setPicked] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    onListPoints?.()
      .then((res) => {
        if (!live) return;
        // null is the host not answering (timeout or refusal) — not an empty list. Say
        // so rather than showing "nothing to rewind to", which reads as a fact.
        if (!res) setError("The host did not answer. Try again.");
        setPoints(res?.points || []);
        setSupport(res?.support || null);
        setLoading(false);
      })
      .catch(() => { if (live) { setError("Could not read this conversation."); setLoading(false); } });
    return () => { live = false; };
  }, [onListPoints]);

  const pick = useCallback(async (point) => {
    vibrate();
    setPicked(point);
    setPreview(null);
    setError("");
    const res = await onPreview?.(point.messageId);
    if (!res?.ok) { setError(res?.error || "The host could not preview this rewind."); return; }
    setPreview(res);
  }, [onPreview]);

  const apply = useCallback(async () => {
    if (!picked) return;
    vibrate();
    setBusy(true);
    setError("");
    const res = await onApply?.(picked.messageId);
    setBusy(false);
    // The host broadcasts a conversation_reset, so the pane rebuilds itself — closing
    // is all this has left to do.
    if (!res?.ok) { setError(res?.error || "The rewind did not go through."); return; }
    onClose?.();
  }, [picked, onApply, onClose]);

  const unsupported = support && !support.conversation;

  return (
    <ModalShell
      icon={<History size={14} />}
      iconClass="bg-amber-500/15 text-amber-400"
      title="Rewind"
      subtitle="Go back to an earlier prompt. Turns after it are discarded."
      maxWidth="max-w-xl"
      onClose={onClose}
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-xs text-text-muted">
          <Loader2 size={14} className="animate-spin" />
          <span>Reading this conversation...</span>
        </div>
      ) : unsupported ? (
        <div className="flex flex-col items-center gap-2 py-12 px-6 text-center text-text-muted">
          <AlertCircle size={28} className="opacity-60" />
          <span className="text-sm">{support.how || "This engine cannot rewind a conversation."}</span>
        </div>
      ) : points.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-text-muted">
          <History size={32} className="opacity-50" />
          <span className="text-sm">{error || "Nothing to rewind to yet."}</span>
        </div>
      ) : (
        <>
          <div className="p-3 flex-1 overflow-y-auto flex flex-col gap-0.5 custom-scrollbar max-h-[45vh]">
            {/* Newest first: the turn someone wants back is nearly always the recent one. */}
            {[...points].reverse().map((p) => (
              <div
                key={p.messageId}
                onClick={() => pick(p)}
                className={`modal-row ${picked?.messageId === p.messageId ? "modal-row-active" : ""}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-text truncate">{p.text || "Untitled prompt"}</div>
                  {p.createdAt && (
                    <div className="mt-1 text-[10px] font-mono text-text-subtle">{relativeAge(Date.parse(p.createdAt))}</div>
                  )}
                </div>
                <span className="modal-row-acts text-[11px] text-brand-500 items-center gap-1">
                  <span>{picked?.messageId === p.messageId ? "Selected" : "Pick"}</span>
                  <CornerDownLeft size={11} />
                </span>
              </div>
            ))}
          </div>

          {error && (
            <div className="px-3 py-2 border-t border-border-subtle text-[11px] text-danger bg-danger/5">{error}</div>
          )}

          {/* Preview before applying — the file half of a rewind overwrites the working
              tree, so what it will touch is shown, not assumed. */}
          <div className="p-3 border-t border-border-subtle bg-bg shrink-0 flex flex-col gap-2">
            {picked && (
              <div className="text-[11px] leading-relaxed text-text-muted">
                {preview?.files?.length > 0 ? (
                  <>
                    <span className="text-text">{preview.files.length}</span> file{preview.files.length === 1 ? "" : "s"} will be restored.
                    {preview.note && <span className="block text-text-subtle">{preview.note}</span>}
                  </>
                ) : preview ? (
                  // An empty list is not "nothing changes" — the CLI leaves the mapping
                  // blank on an untouched session while its backups sit on disk.
                  <span className="block text-text-subtle">{preview.note}</span>
                ) : (
                  <span className="flex items-center gap-1.5">
                    <Loader2 size={11} className="animate-spin" />
                    Checking what this would change...
                  </span>
                )}
              </div>
            )}
            <button
              type="button"
              onClick={apply}
              disabled={!picked || busy || !preview?.ok}
              className={`px-3 py-1.5 rounded-brand text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${
                picked && !busy && preview?.ok
                  ? "bg-brand-500 hover:bg-brand-600 text-white cursor-pointer"
                  : "bg-surface-2 text-text-muted cursor-not-allowed opacity-50"
              }`}
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
              <span>{busy ? "Rewinding..." : "Rewind to this prompt"}</span>
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
});
