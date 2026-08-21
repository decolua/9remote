"use client";

import { useEffect, useRef, useState } from "react";
import { X, Terminal, Bot, Check } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useAgentClis } from "@/features/terminal/hooks/useAgentClis";
import { agentIconUrl, canSkipPermissions, loadShellPref, loadTerminalPrefs, savePref, TERMINAL_PREF_KEYS } from "@/features/terminal/constants/agentCli";
import { SHORTCUTS, shortcutKeys, SHORTCUT_KEY_CLS } from "@/features/terminal/constants/shortcuts";
import LocationPicker from "@/features/terminal/components/LocationPicker";
import FolderPickerModal from "@/features/terminal/components/FolderPickerModal";

// The quick-create chord (create from last prefs, no modal) hinted at in the title bar
const NEW_TERMINAL_SHORTCUT = SHORTCUTS.find((s) => s.id === "newTerminal");

// Shared "New terminal" modal: where it starts (workspace root / a repo's worktree),
// what to launch (plain shell or a TUI agent CLI detected on the host's PATH), how it
// runs, and what to call it — decision first, its dependents under it, name last.
// Used by workspace TerminalHeader/Sidebar and home SessionList. Remount via `key` to reset.
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

export default function NewTerminalModal({
  onClose, onCreate, shells = [], suggestName = "", socketRef = null,
  workspacePath = null, workspaceName = "", fileSocket = null, homeDir = null
}) {
  const { t } = useI18n();
  const agentClis = useAgentClis(socketRef);
  // "" = plain terminal. Held as an id (not the object) so the last-used agent
  // restores from localStorage before detection lands, with no effect/setState race.
  const [agentId, setAgentId] = useState(() => loadTerminalPrefs().agentId);
  const [name, setName] = useState("");
  // null = inherit the workspace's last cwd, same as before this picker existed
  const [cwd, setCwd] = useState(null);
  const [browsing, setBrowsing] = useState(false);
  // On by default — the agent acts without approval prompts unless the user opted out before
  const [skipPermissions, setSkipPermissions] = useState(() => loadTerminalPrefs().yolo);
  const [shellId, setShellId] = useState(() => {
    const saved = loadShellPref();
    if (saved && shells.some((s) => s.id === saved)) return saved;
    return shells[0]?.id || "";
  });
  const nameRef = useRef(null);
  const listRef = useRef(null);
  const didScrollToPickRef = useRef(false);

  useEffect(() => {
    // No autofocus on touch — the popping keyboard shoves the centered modal up abruptly
    if (!window.matchMedia("(pointer: fine)").matches) return;
    requestAnimationFrame(() => nameRef.current?.focus());
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
  const options = [null, ...(agentClis || [])];
  const canSkip = canSkipPermissions(agent);
  // The agent's own skip-mode token, e.g. --yolo / GOOSE_MODE=auto — null for plain shells
  const skipFlag = agent?.yolo
    || (agent?.yoloEnv ? Object.entries(agent.yoloEnv).map(([k, v]) => `${k}=${v}`).join(" ") : null);

  const pick = (picked) => { vibrate(); setAgentId(picked?.id || ""); };

  // Roving focus across the 2-column grid — a radiogroup is arrow-navigated, not tabbed.
  const onGridKey = (e, index) => {
    const delta = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 2, ArrowUp: -2 }[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const next = Math.max(0, Math.min(options.length - 1, index + delta));
    pick(options[next]);
    listRef.current?.querySelectorAll("[role=radio]")[next]?.focus();
  };

  // Agent tabs default to "<Agent> <n>" so two Claude terminals stay tellable apart;
  // suggestName already carries the caller's per-workspace counter.
  // Short name keeps the mobile placeholder tidy; buttons keep the full label.
  const suggestIndex = suggestName.match(/\d+$/)?.[0];
  const defaultName = agent
    ? `${agent.short || agent.label}${suggestIndex ? ` ${suggestIndex}` : ""}`
    : (suggestName || t("terminal.defaultName"));

  const submit = (picked = agent) => {
    vibrate();
    if (!picked && shellId) savePref(TERMINAL_PREF_KEYS.shell, shellId);
    savePref(TERMINAL_PREF_KEYS.agent, picked?.id || "");
    savePref(TERMINAL_PREF_KEYS.yolo, skipPermissions ? "1" : "0");
    const yolo = skipPermissions && canSkipPermissions(picked);
    // An agent tab left unnamed takes the agent's name, not the host's generic "Term N"
    const suffix = suggestIndex ? ` ${suggestIndex}` : "";
    const finalName = name.trim() || (picked ? `${picked.short || picked.label}${suffix}` : null);
    onCreate?.(finalName, !picked ? (shellId || null) : null, picked, yolo, cwd);
    onClose?.();
  };

  return (
    <>
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center px-4 bg-black/70"
      style={{ paddingTop: "max(1rem, env(safe-area-inset-top))", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="newTerminalTitle"
        className="bg-surface rounded-brand-lg w-[22rem] max-w-full shadow-elev overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => { if (e.key === "Escape") onClose?.(); }}
      >
        {/* Title, then where the terminal will start — context before choices */}
        <div className="px-4 pt-4 pb-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <h2 id="newTerminalTitle" className="flex-1 text-sm font-semibold text-text">{t("terminal.newTerminal")}</h2>
            {NEW_TERMINAL_SHORTCUT && (
              <span className="inline-flex items-center gap-1 shrink-0" aria-hidden="true">
                {shortcutKeys(NEW_TERMINAL_SHORTCUT).map((key) => (
                  <kbd key={key} className={SHORTCUT_KEY_CLS}>{key}</kbd>
                ))}
              </span>
            )}
            <button onClick={onClose} aria-label={t("common.cancel")} className="text-text-muted hover:text-text shrink-0">
              <X size={18} />
            </button>
          </div>
          {workspacePath && (
            <LocationPicker
              workspacePath={workspacePath}
              workspaceName={workspaceName}
              fileSocket={fileSocket}
              homeDir={homeDir}
              value={cwd}
              onChange={setCwd}
              onBrowse={() => setBrowsing(true)}
            />
          )}
        </div>

        {/* What to launch — the decision the fields below depend on */}
        <div
          ref={listRef}
          role="radiogroup"
          aria-label={t("terminal.newTerminal")}
          className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-3 pb-1 grid grid-cols-2 gap-1.5 content-start"
        >
          {options.map((a, i) => {
            const active = (a?.id || "") === (agent?.id || "");
            return (
              <button
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                key={a?.id || "__plain"}
                onClick={() => pick(a)}
                onDoubleClick={() => submit(a)}
                onKeyDown={(e) => onGridKey(e, i)}
                data-picked={active}
                className={`flex items-center gap-2 px-2.5 py-2 rounded-brand text-left transition-colors min-w-0 ${
                  active ? "bg-brand-500/15 text-text" : "text-text-muted hover:bg-surface-2 hover:text-text"
                }`}
              >
                <AgentAvatar agent={a} />
                <span className="flex-1 text-sm font-medium truncate">{a ? a.label : t("terminal.plainShell")}</span>
                {active && <Check size={14} className="text-brand-400 shrink-0" />}
              </button>
            );
          })}
        </div>

        <div className="px-4 pt-3 pb-4 border-t border-border/60 space-y-3">
          {/* Dependent on the pick above, so they sit right under it */}
          {!agent && shells.length > 0 && (
            <select
              value={shellId}
              onChange={(e) => setShellId(e.target.value)}
              aria-label={t("terminal.shell")}
              className="w-full px-3 py-2 bg-surface-2 rounded-brand text-sm text-text focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            >
              {shells.map((s) => (
                <option key={s.id} value={s.id}>{s.label}</option>
              ))}
            </select>
          )}
          {/* Always mounted — dimmed when the pick has no skip mode, so switching picks never resizes */}
          <label className={`flex items-center gap-2 px-0.5 select-none ${canSkip ? "cursor-pointer" : "opacity-50 cursor-not-allowed"}`}>
            <input
              type="checkbox"
              checked={canSkip && skipPermissions}
              disabled={!canSkip}
              onChange={(e) => setSkipPermissions(e.target.checked)}
              className="w-4 h-4 accent-brand-500 cursor-pointer disabled:cursor-not-allowed"
            />
            {skipFlag ? (
              <code className="min-w-0 text-xs font-mono text-text-muted truncate">{skipFlag}</code>
            ) : (
              <span className="text-xs text-text-muted">{t("terminal.skipPermissions")}</span>
            )}
          </label>
          <div className="space-y-1">
            <label htmlFor="newTerminalName" className="block text-[11px] font-medium text-text-muted px-0.5">
              {t("terminal.nameLabel")}
            </label>
            <input
              id="newTerminalName"
              type="text"
              ref={nameRef}
              value={name}
              placeholder={defaultName}
              onInput={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              className="w-full px-3 py-2 bg-surface-2 rounded-brand text-sm text-text placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
          </div>
          {/* Primary action last, at the end of the reading direction */}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 py-2 text-sm text-text-muted bg-surface-2 hover:bg-surface-3 rounded-brand transition-colors"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={() => submit()}
              className="flex-1 py-2 text-sm font-semibold text-white bg-brand-500 hover:bg-brand-600 rounded-brand transition-colors"
            >
              {t("common.create")}
            </button>
          </div>
        </div>
      </div>

      </div>

      {/* Sibling, not child: its backdrop click must not bubble into this modal's close */}
      {browsing && (
        <FolderPickerModal
          fileSocket={fileSocket}
          initialPath={cwd || workspacePath}
          onSelect={(p) => { setBrowsing(false); if (p) setCwd(p); }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </>
  );
}
