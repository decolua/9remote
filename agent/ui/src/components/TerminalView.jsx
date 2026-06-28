import { useState, useEffect, useRef } from "preact/hooks";
import Icon from "./Icon";
import TerminalPane from "./TerminalPane";
import { DESKTOP_BREAKPOINT, PANE_MIN_WIDTH } from "../lib/constants";

const UNGROUPED = { id: null, name: "Ungrouped" };

// Full-screen terminal overlay — mirrors web workspace (split panes + tabs + group selector)
export default function TerminalView({ socket, sessions, groups = [], openedIds, activeId, connected, theme = "dark", onSwitch, onCreate, onSelectGroup, onBack }) {
  const [isDesktop, setIsDesktop] = useState(typeof window !== "undefined" ? window.innerWidth >= DESKTOP_BREAKPOINT : false);
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const groupMenuRef = useRef(null);
  const tabsRef = useRef(null);
  const activeTabRef = useRef(null);
  const paneEls = useRef({});

  useEffect(() => {
    let t = 0;
    const check = () => { clearTimeout(t); t = setTimeout(() => setIsDesktop(window.innerWidth >= DESKTOP_BREAKPOINT), 50); };
    window.addEventListener("resize", check);
    return () => { clearTimeout(t); window.removeEventListener("resize", check); };
  }, []);

  // Close group menu on outside click
  useEffect(() => {
    if (!showGroupMenu) return;
    const onDoc = (e) => { if (groupMenuRef.current && !groupMenuRef.current.contains(e.target)) setShowGroupMenu(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [showGroupMenu]);

  // Auto-scroll active tab into center when switching (web parity)
  useEffect(() => {
    if (activeTabRef.current && tabsRef.current) {
      activeTabRef.current.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [activeId]);

  // Desktop split: scroll the focused pane into center of viewport (web parity)
  useEffect(() => {
    if (!isDesktop) return;
    const el = paneEls.current[activeId];
    if (!el) return;
    const id = requestAnimationFrame(() => el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" }));
    return () => cancelAnimationFrame(id);
  }, [activeId, isDesktop, openedIds]);

  const active = sessions.find((s) => s.id === activeId);
  const activeGroupId = active?.groupId || null;
  const groupSessions = sessions.filter((s) => (s.groupId || null) === activeGroupId);
  const openedGroup = groupSessions.filter((s) => openedIds.includes(s.id));
  const multi = openedGroup.length > 1;

  const hasUngrouped = sessions.some((s) => !s.groupId);
  const groupOptions = [...groups, ...(hasUngrouped ? [UNGROUPED] : [])];
  const activeGroupName = groups.find((g) => g.id === activeGroupId)?.name || UNGROUPED.name;
  const showGroupSelector = groupOptions.length > 1;

  return (
    <div className="fixed inset-0 z-50 flex flex-col slide-in-right" style={{ background: "var(--bg-body)" }}>
      {/* Header — back + group selector + tabs + new (web TerminalHeader parity) */}
      <div className="px-2 sm:px-4 pt-2 pb-1 flex items-center gap-2 flex-shrink-0">
        <button
          onClick={onBack}
          title="Back to sessions"
          className="p-1.5 rounded-lg transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0 term-btn"
          style={{ background: "var(--surface-2)", color: "var(--text-main)" }}
        >
          <Icon name="chevronLeft" size={18} />
        </button>

        {/* Group selector — shown when >1 group option */}
        {showGroupSelector && (
          <div ref={groupMenuRef} className="relative flex-shrink-0">
            <button
              onClick={() => setShowGroupMenu((v) => !v)}
              className="px-2 py-1.5 rounded-lg transition-all duration-150 ease-out flex items-center gap-1 max-w-[160px] term-btn"
              style={{ background: "var(--surface-2)", color: "var(--text-main)" }}
              title="Switch group"
            >
              <span className="truncate text-sm font-medium">{activeGroupName}</span>
              <Icon name="chevronDown" size={14} />
            </button>
            {showGroupMenu && (
              <div className="absolute left-0 top-full mt-1 z-30 rounded-lg shadow-lg py-1 min-w-[160px]" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
                {groupOptions.map((g) => (
                  <button
                    key={g.id || "ungrouped"}
                    onClick={() => { onSelectGroup?.(g.id); setShowGroupMenu(false); }}
                    className="w-full text-left px-3 py-1.5 text-sm transition term-group-item"
                    style={{ color: g.id === activeGroupId ? "var(--brand-500)" : "var(--text-main)" }}
                  >
                    {g.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Tabs */}
        <div ref={tabsRef} className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex gap-0.5 min-w-max items-center">
            {groupSessions.map((s) => {
              const isActive = s.id === activeId;
              return (
                <button
                  key={s.id}
                  ref={isActive ? activeTabRef : null}
                  onClick={() => onSwitch?.(s.id)}
                  className="px-2 py-1.5 text-sm font-medium transition-all duration-150 ease-out flex items-center gap-2 whitespace-nowrap term-tab"
                  style={{ color: isActive ? "var(--brand-500)" : "var(--text-muted)" }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ background: connected ? "#22c55e" : "#ef4444" }} />
                  <span className="truncate max-w-[120px]">{s.name || s.id}</span>
                </button>
              );
            })}
            <button
              onClick={() => connected && onCreate?.(activeGroupId)}
              disabled={!connected}
              title="New terminal"
              className="p-1.5 ml-1 rounded-lg transition-all duration-150 ease-out active:scale-[0.94] flex-shrink-0 term-btn"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)", opacity: connected ? 1 : 0.4, cursor: connected ? "pointer" : "not-allowed" }}
            >
              <Icon name="plus" size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* Panes: desktop = horizontal split, mobile = active pane only */}
      <div className={`flex-1 min-h-0 ${isDesktop ? "flex flex-row overflow-x-auto overflow-y-hidden" : "relative"}`}>
        {openedGroup.map((s) => {
          const isFocused = s.id === activeId;
          return (
            <div
              key={s.id}
              ref={(el) => { if (el) paneEls.current[s.id] = el; else delete paneEls.current[s.id]; }}
              className={isDesktop
                ? "flex-1 h-full border-r"
                : `absolute inset-0 ${isFocused ? "opacity-100 z-10" : "opacity-0 z-0 pointer-events-none"}`}
              style={isDesktop ? { minWidth: `${PANE_MIN_WIDTH}px`, borderColor: "var(--border)" } : undefined}
            >
              <TerminalPane
                socket={socket}
                sessionId={s.id}
                theme={theme}
                isFocused={isFocused}
                onActivate={onSwitch}
                showFocusBorder={isDesktop && multi}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
