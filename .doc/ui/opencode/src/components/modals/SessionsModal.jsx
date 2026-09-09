// test-opencode-web/src/components/modals/SessionsModal.jsx
import React, { useState, useEffect } from "react";

export function SessionsModal({ onClose, onResumeSession }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch("/api/sessions")
      .then((res) => res.json())
      .then((data) => {
        setSessions(data.sessions || []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, []);

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-white/15 rounded-2xl w-full max-w-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[85vh]">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">📂</span>
            <h2 className="text-sm font-semibold text-white">Lịch sử phiên OpenCode (/resume)</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        <div className="p-5 flex-1 overflow-y-auto flex flex-col gap-2">
          {loading && (
            <div className="text-center py-8 text-xs text-slate-400">
              Đang tải danh sách phiên OpenCode...
            </div>
          )}

          {error && (
            <div className="p-3 bg-rose-500/20 border border-rose-500/40 text-rose-300 rounded-xl text-xs">
              Lỗi: {error}
            </div>
          )}

          {!loading && sessions.length === 0 && (
            <div className="text-center py-8 text-xs text-slate-500">
              Chưa có phiên làm việc OpenCode nào trong lịch sử.
            </div>
          )}

          {sessions.map((s) => (
            <div
              key={s.sessionId}
              className="p-3.5 rounded-xl bg-white/5 border border-white/10 hover:border-amber-500/50 hover:bg-white/10 transition-all flex items-center justify-between gap-3 group"
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-white truncate group-hover:text-amber-300 transition-colors">
                  {s.title}
                </div>
                <div className="flex items-center gap-3 mt-1 text-[11px] font-mono text-slate-500">
                  <span className="truncate max-w-[140px]">{s.sessionId}</span>
                  {s.updatedAt && (
                    <>
                      <span>•</span>
                      <span>{s.updatedAt}</span>
                    </>
                  )}
                </div>
              </div>

              <button
                onClick={() => {
                  onResumeSession(s.sessionId);
                  onClose();
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600/80 hover:bg-amber-600 text-white shadow-sm transition-colors flex-shrink-0"
              >
                Tiếp tục ▶
              </button>
            </div>
          ))}
        </div>

        <div className="p-4 border-t border-white/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-xs text-slate-300 hover:bg-white/10 transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
