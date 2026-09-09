"use client";

import { memo } from "react";
import { Package, X, CheckCircle2 } from "@/shared/components/ui/Icon";

export const McpModal = memo(function McpModal({
  mcpServers = [],
  onClose
}) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4 select-none">
      <div className="bg-surface border border-border-subtle rounded-brand-lg w-full max-w-lg shadow-2xl overflow-hidden flex flex-col max-h-[80vh] animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-sky-500/15 text-sky-400 flex items-center justify-center">
              <Package size={14} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-text">MCP Servers ({mcpServers.length})</h2>
              <p className="text-[11px] text-text-muted">Model Context Protocol tools and integrations</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-brand text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* List */}
        <div className="p-4 flex-1 overflow-y-auto space-y-2.5 custom-scrollbar">
          {mcpServers.length === 0 ? (
            <div className="text-center py-8 text-xs text-text-muted">
              No MCP servers configured yet in settings.json or config.toml.
            </div>
          ) : (
            mcpServers.map((srv, idx) => (
              <div
                key={srv.id || idx}
                className="p-3 rounded-brand border border-border-subtle bg-surface-2/40 flex items-center justify-between"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-text flex items-center gap-2">
                    <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
                    <span className="font-mono">{srv.name || srv.id}</span>
                  </div>
                  {srv.command && (
                    <div className="text-[11px] text-text-muted font-mono truncate mt-1" title={srv.command}>
                      {srv.command}
                    </div>
                  )}
                </div>

                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 uppercase shrink-0 ml-2">
                  {srv.status || "active"}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
});
