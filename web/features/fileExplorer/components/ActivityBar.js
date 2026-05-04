"use client";

import { Files, Search, GitBranch, Settings, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { ACTIVITY_PANELS, ACTIVITY_BAR_WIDTH } from "../constants/fileExplorer.js";

const TOP_ITEMS = [
  { id: ACTIVITY_PANELS.explorer, Icon: Files, label: "Explorer" },
  { id: ACTIVITY_PANELS.search, Icon: Search, label: "Search" },
  { id: ACTIVITY_PANELS.scm, Icon: GitBranch, label: "Source Control" }
];

function BarButton({ active, onClick, label, children }) {
  const base = "relative w-10 h-10 flex items-center justify-center rounded-brand transition-all duration-150 ease-out active:scale-[0.96]";
  const state = active
    ? "bg-brand-500/20 text-text border-l-2 border-brand-500"
    : "text-text-muted hover:text-text hover:bg-surface-2";
  return (
    <button type="button" title={label} onClick={onClick} className={`${base} ${state}`}>
      {children}
    </button>
  );
}

export default function ActivityBar({ activePanel, onSelectPanel, onBack }) {
  const handleSelect = (id) => {
    vibrate(10);
    onSelectPanel?.(id);
  };
  const handleBack = () => {
    vibrate(10);
    onBack?.();
  };

  return (
    <div
      className="flex flex-col items-center justify-between bg-surface border-r border-border py-2"
      style={{ width: ACTIVITY_BAR_WIDTH }}
    >
      <div className="flex flex-col items-center gap-1">
        {TOP_ITEMS.map(({ id, Icon, label }) => (
          <BarButton key={id} active={activePanel === id} onClick={() => handleSelect(id)} label={label}>
            <Icon size={20} />
          </BarButton>
        ))}
      </div>
      <div className="flex flex-col items-center gap-1">
        <BarButton
          active={activePanel === ACTIVITY_PANELS.settings}
          onClick={() => handleSelect(ACTIVITY_PANELS.settings)}
          label="Settings"
        >
          <Settings size={20} />
        </BarButton>
        <BarButton onClick={handleBack} label="Back">
          <X size={20} />
        </BarButton>
      </div>
    </div>
  );
}
