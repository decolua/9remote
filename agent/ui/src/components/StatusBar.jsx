import Icon from "./Icon";
import { vibrate } from "../lib/vibrate";
import { STATUS_BAR_HEIGHT } from "../lib/fileExplorer/constants";

export default function StatusBar({
  gitBranch,
  line,
  column,
  language,
  encoding,
  activeFile,
  sidebarVisible,
  onToggleSidebar,
  bottomVisible,
  onTogglePanel,
}) {
  const itemCls = "hover:bg-white/10 px-2 py-0.5 cursor-pointer transition-colors flex items-center gap-1";

  return (
    <div
      style={{ height: STATUS_BAR_HEIGHT }}
      className="bg-brand-500 text-white text-xs px-3 flex items-center gap-4 flex-shrink-0"
    >
      <button
        onClick={() => { vibrate(); onToggleSidebar?.(); }}
        className={itemCls}
        title={sidebarVisible ? "Hide Sidebar" : "Show Sidebar"}
      >
        <Icon name={sidebarVisible ? "panelLeftClose" : "panelLeftOpen"} size={12} />
      </button>

      {activeFile && (
        <span className={itemCls}>
          <Icon name="gitBranch" size={12} />
          {gitBranch || "no branch"}
        </span>
      )}

      <div className="flex-1" />

      {onTogglePanel && (
        <button
          onClick={() => { vibrate(); onTogglePanel(); }}
          className={itemCls}
          title={bottomVisible ? "Hide Terminal" : "Show Terminal"}
        >
          <Icon name="terminalSquare" size={12} />
        </button>
      )}

      {activeFile && (
        <>
          <span className={itemCls}>{`Ln ${line || 1}, Col ${column || 1}`}</span>
          <span className={itemCls}>{language || "plaintext"}</span>
          <span className={itemCls}>{encoding || "UTF-8"}</span>
          <span className={itemCls}>Spaces: 2</span>
        </>
      )}
    </div>
  );
}
