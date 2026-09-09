// test-claude-web/src/components/modals/McpModal.jsx
import React from "react";

export function McpModal({ mcpServers = [], tools = [], onClose }) {
  // Group tools by mcp prefix or builtin
  const mcpTools = tools.filter((t) => typeof t === "string" && t.startsWith("mcp__"));
  const builtinTools = tools.filter((t) => typeof t === "string" && !t.startsWith("mcp__"));

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 border border-white/15 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150 flex flex-col max-h-[85vh]">
        <div className="px-5 py-4 border-b border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl">🔌</span>
            <h2 className="text-sm font-semibold text-white">Quản lý MCP & Công cụ (/mcp)</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-lg">✕</button>
        </div>

        <div className="p-5 flex-1 overflow-y-auto flex flex-col gap-5">
          {/* MCP Servers List */}
          <div>
            <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider font-mono mb-2 flex items-center justify-between">
              <span>MCP Servers Đang Kết Nối</span>
              <span className="text-sky-400">{mcpServers.length} servers</span>
            </div>
            {mcpServers.length === 0 ? (
              <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-xs text-slate-400 text-center">
                Chưa có MCP server nào được định cấu hình.
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {mcpServers.map((srv, idx) => (
                  <div key={idx} className="p-3 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between">
                    <div>
                      <div className="text-xs font-semibold text-white flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400" />
                        <span>{typeof srv === "string" ? srv : srv.name || srv.id}</span>
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        {srv.status || "Đã kết nối"}
                      </div>
                    </div>
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                      active
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* MCP Tools */}
          {mcpTools.length > 0 && (
            <div>
              <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider font-mono mb-2 flex items-center justify-between">
                <span>MCP Tools ({mcpTools.length})</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {mcpTools.map((tool, idx) => (
                  <span
                    key={idx}
                    className="px-2.5 py-1 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-300 text-[11px] font-mono"
                  >
                    {tool}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Builtin Tools */}
          <div>
            <div className="text-xs font-semibold text-slate-300 uppercase tracking-wider font-mono mb-2 flex items-center justify-between">
              <span>Công cụ tích hợp sẵn (Builtin Tools)</span>
              <span className="text-slate-400">{builtinTools.length} tools</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {builtinTools.map((tool, idx) => (
                <span
                  key={idx}
                  className="px-2 py-0.5 rounded bg-white/5 border border-white/10 text-slate-300 text-[11px] font-mono"
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="p-4 border-t border-white/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-xl text-xs text-white bg-blue-600 hover:bg-blue-500 transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
