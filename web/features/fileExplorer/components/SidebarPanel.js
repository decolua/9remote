"use client";

import { RefreshCw } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { ACTIVITY_PANELS } from "../constants/fileExplorer.js";
import { PANEL_HEADER_HEIGHT } from "@/shared/constants/layout";
import ExplorerPanel from "./ExplorerPanel.js";
import SearchPanel from "./SearchPanel.js";
import ScmPanel from "./ScmPanel.js";
import SettingsPanel from "./SettingsPanel.js";

const PANEL_TITLES = {
  [ACTIVITY_PANELS.explorer]: "Explorer",
  [ACTIVITY_PANELS.search]: "Search",
  [ACTIVITY_PANELS.scm]: "Source Control",
  [ACTIVITY_PANELS.settings]: "Settings"
};

function renderBody({ activePanel, workspace, fileBus, onOpenFile, onSwitchWorkspace, activeFile }) {
  switch (activePanel) {
    case ACTIVITY_PANELS.explorer:
      return (
        <ExplorerPanel
          workspace={workspace}
          fileBus={fileBus}
          onOpenFile={onOpenFile}
          activeFile={activeFile}
          onSwitchWorkspace={onSwitchWorkspace}
        />
      );
    case ACTIVITY_PANELS.search:
      return <SearchPanel workspace={workspace} fileBus={fileBus} onOpenFile={onOpenFile} />;
    case ACTIVITY_PANELS.scm:
      return <ScmPanel workspace={workspace} fileBus={fileBus} onOpenFile={onOpenFile} />;
    case ACTIVITY_PANELS.settings:
      return <SettingsPanel />;
    default:
      return null;
  }
}

export default function SidebarPanel({
  activePanel,
  workspace,
  fileBus,
  onOpenFile,
  onSwitchWorkspace,
  activeFile
}) {
  const title = PANEL_TITLES[activePanel] || "";

  const handleRefresh = () => {
    vibrate(10);
    fileBus?.refresh?.();
  };

  // The explorer draws its own title bar (workspace name + new file/folder/refresh), so a
  // second strip above it would just repeat the word EXPLORER and the refresh button.
  const ownsHeader = activePanel === ACTIVITY_PANELS.explorer;

  return (
    <div className="flex flex-col h-full">
      {!ownsHeader && (
        <div
          style={{ height: PANEL_HEADER_HEIGHT }}
          className="bg-surface px-3 border-b border-border flex items-center justify-between flex-shrink-0"
        >
          <span className="uppercase tracking-wider text-xs text-text-muted">{title}</span>
          <button
            type="button"
            title="Refresh"
            onClick={handleRefresh}
            className="w-7 h-7 flex items-center justify-center rounded-brand text-text-muted hover:text-text hover:bg-surface-2 transition-all duration-150 ease-out active:scale-[0.96]"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {renderBody({ activePanel, workspace, fileBus, onOpenFile, onSwitchWorkspace, activeFile })}
      </div>
    </div>
  );
}
