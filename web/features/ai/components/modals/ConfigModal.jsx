"use client";

import { memo, useState } from "react";
import { Settings } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { ModalShell } from "./ModalShell";
import { PERSONALITY_OPTIONS } from "../../registry";

// "Default" is the Config modal's own extra choice (clears the option); the rest are
// the shared persona list the `/personality` slash command also offers.
const PERSONALITY_CHOICES = [{ value: "", label: "Default" }, ...PERSONALITY_OPTIONS];

// Runtime options the CLIs actually accept, declared per engine. Each entry names the
// session-option key the host expects, so this modal never builds an argv itself.
//   kind "bool"  → a checkbox, applied as the option's boolean value
//   kind "list"  → a comma-separated text field, split into an array
//   kind "menu"  → a pick-one row list
//
// Each engine also declares how its payload is delivered: codex takes the keys as
// top-level session options, while opencode and antigravity read them from a `flags`
// bag, the way their adapters have always parsed them.
const CONFIG_OPTIONS = {
  claude: { shape: "flat", items: [] },
  codex: {
    shape: "flat",
    items: [
      { key: "personality", kind: "menu", label: "Personality", desc: "Communication style codex is instructed to use", choices: PERSONALITY_CHOICES, default: "" },
      { key: "networkAccess", kind: "bool", label: "Network access", desc: "Let sandboxed commands reach the network", default: false },
      { key: "planEffort", kind: "menu", label: "Plan mode reasoning", desc: "Reasoning tier used while in plan mode", choices: [
        { value: "", label: "Default" },
        { value: "low", label: "low" },
        { value: "medium", label: "medium" },
        { value: "high", label: "high" },
        { value: "xhigh", label: "xhigh" },
      ], default: "" },
      { key: "addDirs", kind: "list", label: "Extra writable directories", desc: "Absolute paths, comma-separated", default: [] },
      { key: "enable", kind: "list", label: "Enable features", desc: "Feature names, comma-separated (see `codex features list`)", default: [] },
      { key: "disable", kind: "list", label: "Disable features", desc: "Feature names, comma-separated", default: [] },
      { key: "skipGitRepoCheck", kind: "bool", label: "Allow outside a git repo", desc: "Run in a directory without a repository", default: false },
      { key: "ephemeral", kind: "bool", label: "Ephemeral run", desc: "Do not persist the session to disk", default: false },
    ],
  },
  opencode: {
    shape: "flags",
    items: [
      { key: "pure", kind: "bool", label: "Pure mode", desc: "Run without external plugins", default: false },
      { key: "printLogs", kind: "bool", label: "Print logs", desc: "Show CLI logs on stderr", default: false },
    ],
  },
};

function optionsFor(engine) {
  return CONFIG_OPTIONS[engine] || { shape: "flat", items: [] };
}

function buildInitial(engine, current) {
  const opts = optionsFor(engine).items;
  // Values are read flat off the session metadata either way: the adapters publish
  // each option under its own key (opencode sets `metadata.pure`, not a nested bag),
  // so the `flags` shape only decides how the payload is sent back.
  const source = current || {};
  return Object.fromEntries(
    opts.map((o) => [o.key, source[o.key] !== undefined ? source[o.key] : o.default])
  );
}

// Applies the edited options by sending them to the host as session options; the
// adapter turns each one into the argv token or config override it needs.
export const ConfigModal = memo(function ConfigModal({ engine = "claude", options: current, onClose, onApply }) {
  const { shape, items } = optionsFor(engine);
  const [config, setConfig] = useState(() => buildInitial(engine, current));

  const set = (key, value) => setConfig((prev) => ({ ...prev, [key]: value }));

  const handleApply = () => {
    vibrate();
    const out = {};
    for (const o of items) {
      const v = config[o.key];
      if (o.kind === "list") {
        out[o.key] = String(v || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      } else {
        out[o.key] = v;
      }
    }
    onApply?.(shape === "flags" ? { flags: out } : out);
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
      footer={items.length > 0 ? (
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
        {items.length === 0 ? (
          <div className="text-center py-8 text-xs text-text-muted">
            No runtime flags are configurable for {engine}.
          </div>
        ) : (
          items.map((opt) => (
            <div
              key={opt.key}
              className="p-3 rounded-brand bg-surface-2/40 border border-border-subtle"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-text">{opt.label}</div>
                  <div className="text-[11px] text-text-muted">{opt.desc}</div>
                </div>
                {opt.kind === "bool" && (
                  <input
                    type="checkbox"
                    checked={!!config[opt.key]}
                    onChange={() => set(opt.key, !config[opt.key])}
                    className="w-4 h-4 accent-brand-500 rounded shrink-0"
                  />
                )}
              </div>

              {opt.kind === "menu" && (
                <div className="flex items-center gap-1.5 flex-wrap mt-2">
                  {opt.choices.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      onClick={() => { vibrate(); set(opt.key, c.value); }}
                      className={`px-2.5 py-1 rounded-brand text-[11px] border transition-colors ${
                        config[opt.key] === c.value
                          ? "border-brand-500 bg-brand-500/10 text-brand-400"
                          : "border-border-subtle bg-surface-2/30 text-text-muted hover:text-text hover:bg-surface-2"
                      }`}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              )}

              {opt.kind === "list" && (
                <input
                  type="text"
                  value={Array.isArray(config[opt.key]) ? config[opt.key].join(", ") : (config[opt.key] || "")}
                  onChange={(e) => set(opt.key, e.target.value)}
                  placeholder="/path/one, /path/two"
                  className="mt-2 w-full px-2.5 py-1.5 rounded bg-bg border border-border-subtle text-xs font-mono text-text placeholder-text-muted focus:outline-none focus:border-brand-500"
                />
              )}
            </div>
          ))
        )}
      </div>
    </ModalShell>
  );
});
