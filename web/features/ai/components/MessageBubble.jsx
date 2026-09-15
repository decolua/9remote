"use client";

import { memo, useState } from "react";
import { Pencil, Paperclip, Image as ImageIcon, Copy, Check, X, Loader2 } from "@/shared/components/ui/Icon";
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
  onCutLocal,
  rewindIndex = null,
  canRewind = false
}) {
  const [copiedMsg, setCopiedMsg] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [confirm, setConfirm] = useState(null); // { files, error } from the host preview
  const [busy, setBusy] = useState(false);
  // Which half of the round-trip is in flight, so the wait reads honestly: asking the
  // host what would change, or asking it to go ahead and do it.
  const [phase, setPhase] = useState(null); // null | "preview" | "apply"
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
    // The turn travels as a position from the end of the thread, not as this bubble's
    // id: the id was minted here and the CLI has never seen it.
    // Declared before the edit box below: that box's Enter handler is a closure over
    // this binding, and an early return above it would leave the binding uninitialized.
    const beginRewind = async (text) => {
      setBusy(true);
      setPhase("preview");
      const preview = await onPreviewRewind?.(null, { index: rewindIndex });
      setBusy(false);
      setPhase(null);
      if (!preview?.ok) {
        setConfirm({ error: preview?.error || "The host could not preview this rewind.", text });
        return;
      }
      setConfirm({ files: preview.files || [], text });
    };

    const applyRewind = async () => {
      const text = confirm?.text;
      setConfirm(null);
      setBusy(true);
      setPhase("apply");
      // Drop the turns BELOW this prompt now rather than after the round-trip: a rewind
      // is a subtractive action, and watching it happen is what makes it legible. The
      // host spawns a CLI for the file half, so the round-trip is seconds.
      //
      // This bubble stays, carrying the edited text — cutting it too would erase the
      // words just typed and leave an empty gap to stare at. So this component is still
      // mounted when the host answers, and the state below still runs.
      onCutLocal?.(id, text);
      const res = await onRewind?.(null, text, { index: rewindIndex });
      setBusy(false);
      setPhase(null);
      // The host refused (a turn still running, the cut failed). The local cut above has
      // to be undone and the reason shown — swallowing this left a pane that looked like
      // the rewind had run and then quietly reverted itself. The hook re-fetches the
      // host's own log on a failed apply, so this only has to say why.
      if (res && !res.ok) {
        setConfirm({ error: res.error || "The rewind did not go through.", text });
        return;
      }
      setEditing(false);
    };

    // Rendered by BOTH branches below: the confirm is raised from inside the edit box,
    // while `editing` is still true. Kept in the bubble branch alone it never mounted —
    // the edit box's early return won the render and the dialog was silently dropped.
    const confirmDialog = (
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
    );

    if (editing) {
      return (
        <>
          <div className="flex justify-end my-3">
            <div className="max-w-[85%] sm:max-w-[75%] w-full">
              <textarea
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                // Losing focus ends the edit, the way clicking away from any other inline
                // editor does. Two exceptions, both of which WOULD blur the box without
                // the user leaving it: while the host is being asked what would change,
                // and once the confirm is up — it takes focus for its own button, and
                // unmounting the editor under it would swap the button's DOM node out
                // from between mousedown and click, so the Rewind press would be lost.
                onBlur={() => { if (!busy && !confirm) setEditing(false); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                    e.preventDefault();
                    if (busy) return;
                    if (confirm) return;
                    if (editValue.trim()) beginRewind(editValue.trim());
                  }
                  if (e.key === "Escape") setEditing(false);
                }}
                rows={Math.min(10, editValue.split("\n").length + 1)}
                className="w-full resize-none overflow-hidden rounded-brand-lg bg-surface-2 px-4 py-2.5 text-sm text-text focus:outline-none focus:ring-1 focus:ring-brand-500 leading-relaxed"
                autoFocus
              />
              <div className="flex justify-end items-center gap-1.5 mt-1.5 text-[11px] text-text-muted">
                {/* Two waits, named apart: the host spawns a CLI for the file half of an
                    apply, so that one takes seconds and the difference matters. The
                    spinner lives here, not on the bubble's pencil — that button is
                    outside this branch and is not drawn while the box is up. */}
                {busy && <Loader2 size={11} className="animate-spin" />}
                <span>
                  {phase === "apply" ? "Rewinding..." : phase === "preview" ? "Checking what this would change..." : "Enter to rewind, Esc to cancel"}
                </span>
              </div>
            </div>
          </div>
          {confirmDialog}
        </>
      );
    }

    // The edit control and the bubble itself do the same thing, so the gesture is only
    // meaningful where a rewind actually is — same guard as the button. Nothing to open
    // on an engine that cannot rewind, and a pointer cursor there would promise one.
    const canEdit = canRewind && Boolean(onRewind);
    const openEditor = () => {
      vibrate();
      setEditValue(content || "");
      setEditing(true);
    };

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
              <div
                onClick={canEdit ? (e) => {
                  // Selecting the text to copy it is not a request to edit it — a click
                  // that ends a drag-selection still carries one. Scoped to THIS bubble:
                  // a leftover selection elsewhere on the page is not a reason to
                  // swallow the click, and swallowing it is how a press looks broken.
                  const sel = window.getSelection();
                  if (sel && !sel.isCollapsed && sel.containsNode(e.currentTarget, true)) return;
                  openEditor();
                } : undefined}
                className={`px-4 py-2.5 rounded-brand-lg bg-brand-500/15 border border-brand-500/25 text-text text-sm whitespace-pre-wrap wrap-anywhere ${
                  canEdit ? "cursor-pointer" : ""
                }`}
              >
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
            {canEdit && (
              <button
                type="button"
                disabled={busy}
                onClick={openEditor}
                className="px-1.5 py-0.5 rounded text-[11px] text-text-muted hover:text-text hover:bg-surface-2 flex items-center gap-1 transition-colors disabled:opacity-40"
                title="Edit & rewind to here"
              >
                {/* Spins only for a preview: that is the one wait that happens with the
                    bubble's own controls on screen. An apply is waited out in the edit
                    box above, which carries its own spinner. */}
                {busy && phase === "preview" ? <Loader2 size={11} className="animate-spin" /> : <Pencil size={11} />}
              </button>
            )}
          </div>
        </div>

        {confirmDialog}
      </>
    );
  }

  // Only user prompts reach here. Everything the agent did in response is a turn of
  // ordered steps, rendered by AiTurn — see lib/turnRows.js for why that moved out.
  return null;
}, (prev, next) => {
  // A turn's position shifts when a later prompt arrives, so it is part of the
  // comparison: an unchanged message with a stale index would rewind the wrong turn.
  if (prev.message === next.message && prev.onResolvePermission === next.onResolvePermission && prev.rewindIndex === next.rewindIndex) return true;
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
      prev.rewindIndex === next.rewindIndex &&
      prev.onResolvePermission === next.onResolvePermission
    );
  }
  return false;
});
