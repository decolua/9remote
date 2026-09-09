// test-opencode-web/src/components/modals/DoctorModal.jsx
import React, { useState, useEffect } from "react";

export function DoctorModal({ onClose }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/doctor")
      .then((res) => res.json())
      .then((data) => {
        setReport(data);
        setLoading(false);
      })
      .catch((err) => {
        setReport({ error: err.message });
        setLoading(false);
      });
  }, []);

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-white/15 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[85vh]">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">🩺</span>
            <h2 className="text-sm font-semibold text-white">Chẩn đoán hệ thống OpenCode (/doctor)</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        <div className="p-5 flex-1 overflow-y-auto flex flex-col gap-4 font-mono text-xs">
          {loading && (
            <div className="text-center py-8 text-slate-400">
              Đang chạy kiểm tra sức khỏe OpenCode...
            </div>
          )}

          {report?.error && (
            <div className="p-3 bg-rose-500/20 border border-rose-500/40 text-rose-300 rounded-xl">
              Lỗi kiểm tra: {report.error}
            </div>
          )}

          {report && !report.error && (
            <>
              <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 flex items-center gap-2">
                <span>✅</span>
                <span className="font-semibold font-sans">Môi trường OpenCode CLI hoạt động bình thường</span>
              </div>

              <div className="flex flex-col gap-2">
                <div className="p-3 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between">
                  <span className="text-slate-400">Node.js Runtime:</span>
                  <span className="text-white font-semibold">{report.nodeVersion}</span>
                </div>

                <div className="p-3 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between">
                  <span className="text-slate-400">Hệ điều hành:</span>
                  <span className="text-white font-semibold">{report.platform} ({report.arch})</span>
                </div>

                <div className="p-3 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between">
                  <span className="text-slate-400">OpenCode Version:</span>
                  <span className="text-amber-300 font-semibold">{report.opencodeVersion || "Đã cài đặt"}</span>
                </div>

                <div className="p-3 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between">
                  <span className="text-slate-400">Git Branch hiện tại:</span>
                  <span className="text-purple-300 font-semibold">{report.branch}</span>
                </div>

                <div className="p-3 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between">
                  <span className="text-slate-400">Thư mục dự án:</span>
                  <span className="text-slate-200 truncate max-w-xs" title={report.projectRoot}>
                    {report.projectRoot}
                  </span>
                </div>

                {report.sessionId && (
                  <div className="p-3 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between">
                    <span className="text-slate-400">Session ID hiện tại:</span>
                    <span className="text-sky-300 font-semibold truncate max-w-xs">{report.sessionId}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="p-4 border-t border-white/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-xs text-white bg-amber-600 hover:bg-amber-500 transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
