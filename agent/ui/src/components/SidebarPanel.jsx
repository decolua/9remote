import Icon from "./Icon";
import { vibrate } from "../lib/vibrate";
import { ACTIVITY_PANELS } from "../lib/fileExplorer/constants";
import ExplorerPanel from "./ExplorerPanel";
import SearchPanel from "./SearchPanel";
import ScmPanel from "./ScmPanel";
import SettingsPanel from "./SettingsPanel";

const PANEL_TITLES = {
  [ACTIVITY_PANELS.explorer]: "Explorer",
  [ACTIVITY_PANELS.search]: "Search",
  [ACTIVITY_PANELS.scm]: "Source Control",
  [ACTIVITY_PANELS.settings]: "Settings",
};

function renderBody({ activePanel, workspace, fileSocket, onOpenFile, activeFile }) {
  switch (activePanel) {
    case ACTIVITY_PANELS.explorer:
      return <ExplorerPanel workspace={workspace} fileSocket={fileSocket} onOpenFile={onOpenFile} activeFile={activeFile} />;
    case ACTIVITY_PANELS.search:
      return <SearchPanel workspace={workspace} fileSocket={fileSocket} onOpenFile={onOpenFile} />;
    case ACTIVITY_PANELS.scm:
      return <ScmPanel workspace={workspace} fileSocket={fileSocket} onOpenFile={onOpenFile} />;
    case ACTIVITY_PANELS.settings:
      return <SettingsPanel />;
    default:
      return null;
  }
}

export default function SidebarPanel({ activePanel, workspace, fileSocket, onOpenFile, activeFile }) {
  const title = PANEL_TITLES[activePanel] || "";

  return (
    <div className="flex flex-col h-full">
      <div className="bg-surface px-3 py-2 border-b border-border flex items-center justify-between">
        <span className="uppercase tracking-wider text-xs text-text-muted">{title}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {renderBody({ activePanel, workspace, fileSocket, onOpenFile, activeFile })}
      </div>
    </div>
  );
}
