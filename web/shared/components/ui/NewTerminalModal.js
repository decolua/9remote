"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X, Terminal, Bot, Search, Check } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useAgentClis } from "@/features/terminal/hooks/useAgentClis";
import { agentIconUrl, canSkipPermissions } from "@/features/terminal/constants/agentCli";

// Shared "New terminal" modal: pick what to launch (plain shell or a TUI agent CLI
// detected on the host's PATH), name it, and on Windows pick the shell.
// Used by workspace TerminalHeader/Sidebar and home SessionList. Remount via `key` to reset.
const SHELL_PREF_KEY = "9remote.terminal.shellPref";
const AGENT_PREF_KEY = "9remote.terminal.agentPref";
const YOLO_PREF_KEY = "9remote.terminal.yoloPref";

export function loadShellPref() {
  try { return localStorage.getItem(SHELL_PREF_KEY) || null; } catch { return null; }
}

function loadPref(key) {
  try { return localStorage.getItem(key) || null; } catch { return null; }
}

function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

// Agent logo, falling back to a neutral glyph when an agent ships no bundled icon
function AgentAvatar({ agent }) {
  const [broken, setBroken] = useState(false);
  if (!agent) return <Terminal size={16} className="text-text-muted" />;
  if (broken) return <Bot size={16} className="text-text-muted" />;
  return (
    <img
      src={agentIconUrl(agent.id)}
      alt=""
      width={16}
      height={16}
      onError={() => setBroken(true)}
      className="w-4 h-4 object-contain"
    />
  );
}

export default function NewTerminalModal({ onClose, onCreate, shells = [], suggestName = "", socketRef = null }) {
  const { t } = useI18n();
  const agentClis = useAgentClis(socketRef);
  // "" = plain terminal. Held as an id (not the object) so the last-used agent
  // restores from localStorage before detection lands, with no effect/setState race.
  const [agentId, setAgentId] = useState(() => loadPref(AGENT_PREF_KEY) || "");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  // Off unless the user turned it on before — this lets the agent act without approval
  const [skipPermissions, setSkipPermissions] = useState(() => loadPref(YOLO_PREF_KEY) === "1");
  const [shellId, setShellId] = useState(() => {
    const saved = loadShellPref();
    if (saved && shells.some((s) => s.id === saved)) return saved;
    return shells[0]?.id || "";
  });
  const inputRef = useRef(null);
  const nameRef = useRef(null);
  const listRef = useRef(null);
  const didScrollToPickRef = useRef(false);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  // Bring the restored pick into view once, after detection populates the list.
  // Not per-render: re-scrolling on every keystroke would fight the user's scroll.
  useEffect(() => {
    if (didScrollToPickRef.current || !agentClis?.length || !agentId) return;
    didScrollToPickRef.current = true;
    listRef.current?.querySelector("[data-picked=true]")?.scrollIntoView({ block: "nearest" });
  }, [agentClis, agentId]);

  // A saved id the host no longer has (CLI uninstalled) falls back to plain terminal
  const agent = (agentId && agentClis?.find((a) => a.id === agentId)) || null;

  // Picking a launcher moves focus to the name field — the next thing to fill in
  const pick = (picked) => {
    vibrate();
    setAgentId(picked?.id || "");
    requestAnimationFrame(() => { nameRef.current?.focus(); const el = nameRef.current; if (el) el.setSelectionRange(el.value.length, el.value.length); });
  };

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return agentClis || [];
    return (agentClis || []).filter((a) => a.label.toLowerCase().includes(q));
  }, [agentClis, query]);

  const showTerminalRow = !query.trim() || t("terminal.newTerminal").toLowerCase().includes(query.trim().toLowerCase());

  // Agent tabs default to "<Agent> <n>" so two Claude terminals stay tellable apart;
  // suggestName already carries the caller's per-workspace counter.
  const suggestIndex = suggestName.match(/\d+$/)?.[0];
  const defaultName = agent
    ? `${agent.label}${suggestIndex ? ` ${suggestIndex}` : ""}`
    : (suggestName || t("terminal.defaultName"));

  const submit = (picked = agent) => {
    vibrate();
    if (!picked && shellId) savePref(SHELL_PREF_KEY, shellId);
    savePref(AGENT_PREF_KEY, picked?.id || "");
    savePref(YOLO_PREF_KEY, skipPermissions ? "1" : "0");
    const yolo = skipPermissions && canSkipPermissions(picked);
    // An agent tab left unnamed takes the agent's name, not the host's generic "Term N"
    const suffix = suggestIndex ? ` ${suggestIndex}` : "";
    const finalName = name.trim() || (picked ? `${picked.label}${suffix}` : null);
    onCreate?.(finalName, !picked ? (shellId || null) : null, picked, yolo);
    onClose?.();
  };

  const rowClass = (active) =>
    `w-full flex items-center gap-2.5 px-2.5 py-2 rounded-brand text-left transition-colors ${
      active ? "bg-brand-500/15 text-text" : "text-text-muted hover:bg-surface-2 hover:text-text"
    }`;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4 bg-black/70"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      onClick={onClose}
    >
      <div
        className="bg-surface rounded-brand-lg w-[22rem] max-w-full shadow-elev overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search filters the launcher list; the header doubles as the title bar */}
        <div className="flex items-center gap-2 px-4 pt-4 pb-3">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            <input
              type="text"
              ref={inputRef}
              value={query}
              placeholder={t("terminal.searchAgents")}
              onInput={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit(matches.length === 1 && !showTerminalRow ? matches[0] : agent);
                if (e.key === "Escape") onClose?.();
              }}
              className="w-full pl-8 pr-8 py-2 bg-surface-2 rounded-brand text-sm text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
            {query && (
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
                title={t("common.cancel")}
              >
                <X size={15} />
              </button>
            )}
          </div>
          <button onClick={onClose} className="text-text-muted hover:text-text shrink-0">
            <X size={18} />
          </button>
        </div>

        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-2 pb-1">
          {showTerminalRow && (
            <button type="button" onClick={() => pick(null)} className={rowClass(!agent)}>
              <AgentAvatar agent={null} />
              <span className="flex-1 text-sm font-medium truncate">{t("terminal.newTerminal")}</span>
              {!agent && <Check size={15} className="text-brand-400 shrink-0" />}
            </button>
          )}
          {matches.map((a) => (
            <button
              type="button"
              key={a.id}
              onClick={() => pick(a)}
              onDoubleClick={() => submit(a)}
              data-picked={agent?.id === a.id}
              className={rowClass(agent?.id === a.id)}
            >
              <AgentAvatar agent={a} />
              <span className="flex-1 text-sm font-medium truncate">{a.label}</span>
              {agent?.id === a.id && <Check size={15} className="text-brand-400 shrink-0" />}
            </button>
          ))}
          {!showTerminalRow && matches.length === 0 && (
            <p className="px-2.5 py-6 text-center text-xs text-text-muted">{t("terminal.noAgentsFound")}</p>
          )}
        </div>

        <div className="px-4 pt-3 pb-4 border-t border-border/60 space-y-3">
          <input
            type="text"
            ref={nameRef}
            value={name}
            placeholder={defaultName}
            onInput={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape") onClose?.();
            }}
            className="w-full px-3 py-2 bg-surface-2 rounded-brand text-sm text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
          {canSkipPermissions(agent) && (
            <label className="flex items-center gap-2 px-0.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={skipPermissions}
                onChange={(e) => setSkipPermissions(e.target.checked)}
                className="w-4 h-4 accent-brand-500 cursor-pointer"
              />
              <span className="text-xs text-text-muted">{t("terminal.skipPermissions")}</span>
            </label>
          )}
          {!agent && shells.length > 0 && (
            <select
              value={shellId}
              onChange={(e) => setShellId(e.target.value)}
              className="w-full px-3 py-2 bg-surface-2 rounded-brand text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            >
              {shells.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => submit()}
              className="flex-1 py-2 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-brand transition-colors"
            >
              {t("common.create")}
            </button>
            <button
              onClick={onClose}
              className="flex-1 py-2 text-sm text-text-muted bg-surface-2 hover:bg-surface-3 rounded-brand transition-colors"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
