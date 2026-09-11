"use client";

import { memo, useState } from "react";
import { Settings } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { ModalShell } from "./ModalShell";

// Runtime flags the CLIs actually accept on the command line. Declared per engine
// so a flag an engine does not support is simply absent here — no branch needed.
// `arg` is the literal argv token(s) the adapter appends when the flag is on.
const ENGINE_CONFIG_OPTIONS = {
  claude: [],
  codex: [
    { key: "skipGitRepoCheck", label: "Allow outside a git repo", desc: "Run in a directory without a repository", arg: ["--skip-git-repo-check"], default: false },
    { key: "ephemeral", label: "Ephemeral run", desc: "Do not persist the session to disk", arg: ["--ephemeral"], default: false },
  ],
  opencode: [
    { key: "pure", label: "Pure mode", desc: "Run without external plugins", arg: ["--pure"], default: false },
    { key: "printLogs", label: "Print logs", desc: "Show CLI logs on stderr", arg: ["--print-logs"], default: false },
  ],
};

function buildInitial(engine) {
  const opts = ENGINE_CONFIG_OPTIONS[engine] || [];
  return Object.fromEntries(opts.map((o) => [o.key, o.default]));
}

// Applies the toggled flags by sending them to the host as session options; the
// adapter appends the matching argv tokens to the next CLI run.
export const ConfigModal = memo(function ConfigModal({ engine = "claude", onClose, onApply }) {
  const options = ENGINE_CONFIG_OPTIONS[engine] || [];
  const [config, setConfig] = useState(() => buildInitial(engine));

  const toggle = (key) => setConfig((prev) => ({ ...prev, [key]: !prev[key] }));

  const handleApply = () => {
    vibrate();
    const flags = {};
    for (const o of options) flags[o.key] = Boolean(config[o.key]);
    onApply?.(flags);
    onClose?.();
  };

  return (
    <ModalShell
      icon={<Settings size={14} />}
      iconClass="bg-surface-3 text-text-muted"
      title="Configuration"
      subtitle={`Runtime flags for ${engine}`}
      maxWidth="max-w-md"
      onClose={onClose}
      footer={options.length > 0 ? (
        <div className="px-4 py-3 border-t border-border-subtle flex justify-end gap-2 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-brand text-xs text-text-muted hover:text-text hover:bg-surface-2 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="px-3 py-1.5 rounded-brand text-xs bg-brand-500 hover:bg-brand-600 text-white font-medium transition-colors"
          >
            Apply
          </button>
        </div>
      ) : null}
    >
      <div className="p-4 flex-1 overflow-y-auto space-y-2.5 custom-scrollbar">
        {options.length === 0 ? (
          <div className="text-center py-8 text-xs text-text-muted">
            No runtime flags are configurable for {engine}.
          </div>
        ) : (
          options.map((opt) => (
            <label
              key={opt.key}
              className="flex items-center justify-between p-3 rounded-brand bg-surface-2/40 border border-border-subtle cursor-pointer hover:bg-surface-2 transition-colors"
            >
              <div className="min-w-0 pr-3">
                <div className="text-xs font-semibold text-text">{opt.label}</div>
                <div className="text-[11px] text-text-muted">{opt.desc}</div>
              </div>
              <input
                type="checkbox"
                checked={!!config[opt.key]}
                onChange={() => toggle(opt.key)}
                className="w-4 h-4 accent-brand-500 rounded shrink-0"
              />
            </label>
          ))
        )}
      </div>
    </ModalShell>
  );
});
