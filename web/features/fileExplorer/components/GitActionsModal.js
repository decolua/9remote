"use client";

import { useState, useEffect } from "react";
import { X, Check, ArrowUp, GitBranch, Loader2 } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { commitSummary, pushSummary } from "../lib/gitOutput.js";

// Git commit/push actions. Commit stages all (add .) then commits.
export default function GitActionsModal({ workspace, fileBus, branch, changedCount, onDone, onClose }) {
  const { t } = useI18n();
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState(null); // { ok, text }

  useEffect(() => {
    const onEsc = (e) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose, busy]);

  const canCommit = msg.trim().length > 0 && !busy;

  const doCommit = async () => {
    const add = await fileBus.gitAdd(workspace);
    if (!add.success) return { ok: false, text: add.error || t("git.stageFailed") };
    const res = await fileBus.gitCommit(workspace, msg.trim());
    if (!res.success) return { ok: false, text: res.output || res.error || t("git.commitFailed") };
    return { ok: true, text: commitSummary(t, res.output) };
  };

  const handleCommit = async () => {
    if (!canCommit) return;
    vibrate(); setBusy(true); setOutput(null);
    const r = await doCommit();
    setBusy(false); setOutput(r);
    if (r.ok) { setMsg(""); onDone?.(); }
  };

  const handlePush = async () => {
    if (busy) return;
    vibrate(); setBusy(true); setOutput(null);
    const res = await fileBus.gitPush(workspace);
    setBusy(false);
    setOutput({ ok: res.success, text: res.success ? pushSummary(t, res.output) : (res.output || res.error || t("git.pushFailed")) });
    if (res.success) onDone?.();
  };

  const handleCommitAndPush = async () => {
    if (!canCommit) return;
    vibrate(); setBusy(true); setOutput(null);
    const c = await doCommit();
    if (!c.ok) { setBusy(false); setOutput(c); return; }
    setMsg("");
    const res = await fileBus.gitPush(workspace);
    setBusy(false);
    setOutput({ ok: res.success, text: res.success ? pushSummary(t, res.output) : (res.output || res.error || t("git.pushFailed")) });
    onDone?.();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px] animate-in fade-in duration-200" onClick={() => !busy && onClose()} />
      <div className="relative card-elev max-w-md w-full flex flex-col animate-in zoom-in-95 duration-200">
        <div className="px-5 py-4 flex items-center justify-between flex-shrink-0">
          <h3 className="text-lg font-semibold text-text flex items-center gap-2">
            <GitBranch size={18} className="text-brand-500" />
            {t("git.title")}{branch ? ` · ${branch}` : ""}
          </h3>
          <button onClick={() => !busy && onClose()} className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded-brand transition-all duration-150 ease-out" aria-label={t("common.close")}>
            <X size={20} />
          </button>
        </div>
        <div className="px-5 pb-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <textarea
              value={msg}
              onChange={(e) => setMsg(e.target.value)}
              rows={2}
              placeholder={t("git.commitPlaceholder")}
              disabled={busy}
              className="w-full px-3 py-2 bg-surface-2 text-text text-sm rounded-brand outline-none focus:ring-1 focus:ring-brand-500 resize-y min-h-[54px] max-h-[200px] disabled:opacity-60"
            />
            <span className="text-xs text-text-subtle">{t("git.stageAllNote", { count: changedCount })}</span>
          </div>

          <button
            onClick={handleCommitAndPush}
            disabled={!canCommit}
            className="w-full px-4 py-2.5 text-sm bg-brand-500 hover:bg-brand-500/80 text-white font-medium rounded-brand transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? <Loader2 size={16} className="animate-spin" /> : <><Check size={16} /><ArrowUp size={16} /></>}
            {t("git.commitAndPush")}
          </button>

          <div className="flex gap-2">
            <button
              onClick={handleCommit}
              disabled={!canCommit}
              className="flex-1 px-4 py-2 text-sm bg-surface-3 hover:bg-surface text-text rounded-brand transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Check size={16} />{t("git.commit")}
            </button>
            <button
              onClick={handlePush}
              disabled={busy}
              className="flex-1 px-4 py-2 text-sm bg-surface-3 hover:bg-surface text-text rounded-brand transition-colors flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ArrowUp size={16} />{t("git.push")}
            </button>
          </div>

          {output && (
            <pre className={`text-xs whitespace-pre-wrap break-words px-3 py-2 rounded-brand max-h-32 overflow-y-auto ${output.ok ? "bg-emerald-500/15 text-emerald-400" : "bg-red-500/15 text-red-400"}`}>
              {output.text}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
