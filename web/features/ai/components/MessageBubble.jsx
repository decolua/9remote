"use client";

import { memo, useState } from "react";
import { Pencil, Paperclip, Image as ImageIcon, Copy, Check, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useTerminalStore } from "@/shared/stores/terminalStore";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

export const MessageBubble = memo(function MessageBubble({
  message,
  engine = "claude",
  workspacePath = "",
  onResolvePermission,
  onRewind,
  onPreviewRewind,
  canRewind = false
}) {
  const [copiedMsg, setCopiedMsg] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [confirm, setConfirm] = useState(null); // { files, error } from the host preview
  const [busy, setBusy] = useState(false);
  const openEditorFile = useTerminalStore((s) => s.openEditorFile);
  const { id, role, content, thinking, diffs = [], tools = [], permission = null, isLive = false, attachments = [] } = message;
  const handleCopyAll = () => {
    vibrate();
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopiedMsg(true);
    setTimeout(() => setCopiedMsg(false), 2000);
  };

  if (role === "user") {
    // A rewind discards every turn after this one and, where the engine can, puts the
    // files back. Both are destructive and neither is obvious, so the host is asked
    // first what would actually change and that list is what the user confirms.
    // Declared before the edit box below: that box's Enter handler is a closure over
    // this binding, and an early return above it would leave the binding uninitialized.
    const beginRewind = async (text) => {
      setBusy(true);
      const preview = await onPreviewRewind?.(message.id);
      setBusy(false);
      if (!preview?.ok) {
        setConfirm({ error: preview?.error || "The host could not preview this rewind.", text });
        return;
      }
      setConfirm({ files: preview.files || [], text });
    };

    const applyRewind = async () => {
      const text = confirm?.text;
      setConfirm(null);
      setEditing(false);
      setBusy(true);
      await onRewind?.(message.id, text);
      setBusy(false);
    };

    if (editing) {
      return (
        <div className="flex justify-end my-3">
          <div className="max-w-[85%] sm:max-w-[75%] w-full">
            <textarea
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  if (editValue.trim()) beginRewind(editValue.trim());
                }
                if (e.key === "Escape") setEditing(false);
              }}
              rows={Math.min(10, editValue.split("\n").length + 1)}
              className="w-full resize-none overflow-hidden rounded-brand-lg bg-surface-2 px-4 py-2.5 text-sm text-text focus:outline-none focus:ring-1 focus:ring-brand-500 leading-relaxed"
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-1.5 text-[11px] text-text-muted">
              <span>Enter to rewind, Esc to cancel</span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <>
        <div className="group/msg flex flex-col items-end my-3">
          <div className="max-w-[85%] sm:max-w-[75%] flex flex-col items-end gap-1.5">
            {/* Files the prompt carried — names only: the bytes stay on the host. The
                icon is what says an image was sent, since there is no thumbnail. */}
            {attachments.length > 0 && (
              <div className="flex flex-wrap justify-end gap-1.5">
                {attachments.map((att, i) => (
                  <span
                    key={`${att.filename}-${i}`}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
                      att.isImage
                        ? "border-brand-500/40 bg-brand-500/10 text-brand-500"
                        : "border-border-subtle bg-surface-2 text-text-muted"
                    }`}
                  >
                    {att.isImage ? <ImageIcon size={10} /> : <Paperclip size={10} />}
                    <span className="max-w-[160px] truncate">{att.filename}</span>
                  </span>
                ))}
              </div>
            )}
            {content && (
              <div className="px-4 py-2.5 rounded-brand-lg bg-brand-500/15 border border-brand-500/25 text-text text-sm whitespace-pre-wrap wrap-anywhere">
                {content}
              </div>
            )}
          </div>

          {/* Actions below the bubble, always visible — a phone has no hover, so the
              old hover-only controls were unreachable there. */}
          <div className="flex items-center gap-1 mt-1">
            <button
              type="button"
              onClick={handleCopyAll}
              className="px-1.5 py-0.5 rounded text-[11px] text-text-muted hover:text-text hover:bg-surface-2 flex items-center gap-1 transition-colors"
              title="Copy this prompt"
            >
              {copiedMsg ? <Check size={11} className="text-success" /> : <Copy size={11} />}
            </button>
            {/* Only where a rewind would actually do something. Everywhere else the
                button is absent rather than present-and-lying. */}
            {canRewind && onRewind && (
              <button
                type="button"
                disabled={busy}
                onClick={() => { vibrate(); setEditValue(content || ""); setEditing(true); }}
                className="px-1.5 py-0.5 rounded text-[11px] text-text-muted hover:text-text hover:bg-surface-2 flex items-center gap-1 transition-colors disabled:opacity-40"
                title="Edit & rewind to here"
              >
                <Pencil size={11} />
              </button>
            )}
          </div>
        </div>

        <ConfirmDialog
          isOpen={Boolean(confirm)}
          onClose={() => setConfirm(null)}
          onConfirm={confirm?.error ? () => setConfirm(null) : applyRewind}
          title={confirm?.error ? "Cannot rewind" : "Rewind to this prompt?"}
          message={
            confirm?.error
              ? confirm.error
              : [
                  "This discards every turn after this prompt and re-sends your edited text.",
                  confirm?.files?.length
                    ? `These ${confirm.files.length} file${confirm.files.length === 1 ? "" : "s"} go back to how they were:`
                    : "No file changes to restore — this rewinds the conversation only.",
                  ...(confirm?.files?.slice(0, 8).map((f) => `· ${f.file}${f.status ? ` (${f.status})` : ""}`) || []),
                  confirm?.files?.length > 8 ? `… and ${confirm.files.length - 8} more` : "",
                  "Edits made by hand, or by shell commands, are NOT restored."
                ].filter(Boolean).join("\n")
          }
          confirmText={confirm?.error ? "OK" : "Rewind"}
        />
      </>
    );
  }

  // Only user prompts reach here. Everything the agent did in response is a turn of
  // ordered steps, rendered by AiTurn — see lib/turnRows.js for why that moved out.
  return null;
}, (prev, next) => {
  if (prev.message === next.message && prev.onResolvePermission === next.onResolvePermission) return true;
  // Freezed comparison for completed messages
  if (!prev.message.isLive && !next.message.isLive) {
    return (
      prev.message.id === next.message.id &&
      prev.message.content === next.message.content &&
      prev.message.thinking === next.message.thinking &&
      prev.message.permission === next.message.permission &&
      // Identity, not length: a tool result (or a sub-agent's nested calls) updates
      // rows in place, and a length-only check left those updates unrendered.
      prev.message.tools === next.message.tools &&
      prev.message.diffs === next.message.diffs &&
      prev.canRewind === next.canRewind &&
      prev.onResolvePermission === next.onResolvePermission
    );
  }
  return false;
});
