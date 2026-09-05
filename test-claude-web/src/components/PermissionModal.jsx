// test-claude-web/src/components/PermissionModal.jsx
import React, { useEffect } from "react";

export function PermissionModal({ data, onDecision }) {
  if (!data) return null;

  const { requestId, toolName, input = {}, reason } = data;

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "y" || e.key === "Y" || e.key === "Enter") {
        e.preventDefault();
        onDecision(requestId, "allow");
      } else if (e.key === "n" || e.key === "N" || e.key === "Escape") {
        e.preventDefault();
        onDecision(requestId, "deny");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [requestId, onDecision]);

  const isDangerousBash =
    toolName === "Bash" &&
    /(rm\s+-rf|sudo|kill|mkfs|format|dd\s+if)/.test(input.command || "");

  return (
    <div className="fixed inset-0 bg-black/75 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
      <div className="w-full max-w-lg bg-slate-900 border border-white/15 rounded-2xl p-6 shadow-2xl flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center text-xl">
            🛡️
          </div>
          <div>
            <div className="text-base font-bold text-white">
              Cấp quyền: {toolName}
            </div>
            <div className="text-xs text-slate-400">
              ID: {requestId.slice(0, 8)} • Nhấn (Y) để cho phép, (N) để từ chối
            </div>
          </div>
        </div>

        <div className="bg-amber-500/10 border-l-2 border-amber-500 px-3 py-2 rounded text-xs text-amber-200">
          Lý do: {reason || "Hệ thống cần bạn xác nhận trước khi thực thi"}
        </div>

        {isDangerousBash && (
          <div className="bg-rose-500/15 border border-rose-500/30 text-rose-300 px-3 py-2 rounded text-xs flex items-center gap-2">
            <span>⚠️</span>
            <span>Cảnh báo: Lệnh này can thiệp sâu hoặc có thể xóa dữ liệu hệ thống!</span>
          </div>
        )}

        {/* Specialized Content */}
        <div className="bg-black/50 border border-white/10 rounded-lg overflow-hidden max-h-56 overflow-y-auto">
          {toolName === "Bash" && (
            <div className="p-3 font-mono text-xs text-amber-300 break-all leading-relaxed">
              $ {input.command || ""}
              {input.description && (
                <div className="text-slate-400 text-[11px] mt-1 italic border-t border-white/5 pt-1">
                  Mô tả: {input.description}
                </div>
              )}
            </div>
          )}

          {toolName === "Edit" && (
            <div className="p-3 font-mono text-xs">
              <div className="text-emerald-400 font-semibold mb-2">File: {input.file_path}</div>
              <div className="bg-rose-500/15 text-rose-300 p-2 rounded mb-1 whitespace-pre-wrap">
                - {input.old_string}
              </div>
              <div className="bg-emerald-500/15 text-emerald-300 p-2 rounded whitespace-pre-wrap">
                + {input.new_string}
              </div>
            </div>
          )}

          {toolName === "Write" && (
            <div className="p-3 font-mono text-xs">
              <div className="text-sky-400 font-semibold mb-2">Ghi file: {input.file_path}</div>
              <div className="text-slate-300 bg-black/40 p-2 rounded whitespace-pre-wrap">
                {input.content?.slice(0, 400)}...
              </div>
            </div>
          )}

          {toolName !== "Bash" && toolName !== "Edit" && toolName !== "Write" && (
            <pre className="p-3 font-mono text-xs text-slate-300">
              {JSON.stringify(input, null, 2)}
            </pre>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 mt-1">
          <button
            onClick={() => onDecision(requestId, "deny")}
            className="px-4 py-2 rounded-lg text-xs font-semibold text-rose-300 bg-rose-500/10 border border-rose-500/30 hover:bg-rose-500/20 transition-all"
          >
            Từ chối (N / Esc)
          </button>
          <button
            onClick={() => onDecision(requestId, "allow")}
            className="px-5 py-2 rounded-lg text-xs font-semibold text-white bg-gradient-to-r from-blue-600 to-sky-500 hover:from-blue-500 hover:to-sky-400 shadow-lg shadow-sky-500/20 transition-all"
          >
            Cho phép thực thi (Y / Enter)
          </button>
        </div>
      </div>
    </div>
  );
}
