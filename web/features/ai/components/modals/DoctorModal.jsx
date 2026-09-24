"use client";

import { memo, useState, useEffect, useCallback } from "react";
import { HelpCircle, Loader2, RefreshCw, CheckCircle2, AlertCircle } from "@/shared/components/ui/Icon";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { ModalShell } from "./ModalShell";

// Runs the engine's own health command on the host (claude doctor / codex doctor
// / opencode debug) and shows the raw report. The host owns the CLI, so this is
// a bus request rather than anything the browser can run itself.
export const DoctorModal = memo(function DoctorModal({ engine = "claude", workspacePath = "", bus = null, onClose }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  const run = useCallback(() => {
    if (!bus?.emit) {
      setReport({ error: "Not connected to the host agent." });
      setLoading(false);
      return;
    }
    setLoading(true);
    bus.emit("ai:doctor", { engine, cwd: workspacePath }, (res) => {
      setReport(res?.ok ? { output: res.output || "", version: res.version || "" } : { error: res?.error || "Doctor check failed." });
      setLoading(false);
    });
  }, [engine, workspacePath]);

  useEffect(() => { run(); }, [run]);

  return (
    <ModalShell
      icon={<HelpCircle size={14} />}
      iconClass="bg-emerald-500/15 text-emerald-400"
      title="Diagnostics"
      subtitle={`Health check for the ${engine} CLI`}
      onClose={onClose}
    >
      <div className="p-3 flex-1 overflow-y-auto custom-scrollbar">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-text-muted">
            <Loader2 size={14} className="animate-spin" />
            <span>Running {engine} doctor...</span>
          </div>
        ) : report?.error ? (
          <div className="p-3 rounded-brand bg-danger/10 border border-danger/30 text-danger text-xs flex items-start gap-2">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{report.error}</span>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="p-3 rounded-brand bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle2 size={14} className="shrink-0" />
              <span className="font-medium">
                {report?.version ? `${engine} ${report.version}` : `${engine} environment report`}
              </span>
            </div>
            <pre className="p-3 rounded-brand bg-bg border border-border-subtle text-[11px] font-mono text-text-muted whitespace-pre-wrap break-words leading-relaxed">
              {report?.output || "No output."}
            </pre>
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-t border-border-subtle flex justify-end shrink-0">
        <button
          type="button"
          onClick={run}
          disabled={loading}
          className="px-3 py-1.5 rounded-brand text-xs text-text-muted hover:text-text hover:bg-surface-2 transition-colors flex items-center gap-1.5 disabled:opacity-50"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          <span>Re-run</span>
        </button>
      </div>
    </ModalShell>
  );
});
