"use client";

import { memo } from "react";
import { Package, CheckCircle2 } from "@/shared/components/ui/Icon";
import { ModalShell } from "./ModalShell";

export const McpModal = memo(function McpModal({
  mcpServers = [],
  onClose
}) {
  return (
    <ModalShell
      icon={<Package size={14} />}
      iconClass="bg-sky-500/15 text-sky-400"
      title={`MCP Servers (${mcpServers.length})`}
      subtitle="Model Context Protocol tools and integrations"
      onClose={onClose}
    >
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
    </ModalShell>
  );
});
