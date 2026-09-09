// test-codex-web/src/components/modals/McpModal.jsx
import React from "react";

export function McpModal({ mcpServers = [], onClose }) {
  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-white/15 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[85vh]">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">🔌</span>
            <div>
              <h2 className="text-sm font-semibold text-white">Quản lý MCP Servers Codex (/mcp)</h2>
              <p className="text-[11px] text-slate-400">Được cấu hình trong ~/.codex/config.toml</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        <div className="p-5 flex-1 overflow-y-auto flex flex-col gap-3">
          <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider font-mono flex items-center justify-between">
            <span>Danh sách MCP Server</span>
            <span className="text-emerald-400">{mcpServers.length} servers</span>
          </div>

          {mcpServers.length === 0 ? (
            <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-xs text-slate-400 text-center">
              Chưa có MCP server nào được cấu hình trong ~/.codex/config.toml
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {mcpServers.map((srv, idx) => (
                <div key={idx} className="p-3.5 rounded-xl bg-white/5 border border-white/10 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${srv.enabled ? "bg-emerald-400" : "bg-slate-500"}`} />
                      <span className="text-xs font-semibold text-white">{srv.name}</span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/10 text-slate-400">
                        {srv.type}
                      </span>
                    </div>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono ${
                      srv.enabled
                        ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                        : "bg-white/5 text-slate-500 border border-white/10"
                    }`}>
                      {srv.status || (srv.enabled ? "enabled" : "disabled")}
                    </span>
                  </div>

                  <div className="text-[11px] font-mono text-slate-400 break-all bg-black/30 p-2 rounded">
                    {srv.target}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-white/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-xs text-white bg-emerald-600 hover:bg-emerald-500 transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
