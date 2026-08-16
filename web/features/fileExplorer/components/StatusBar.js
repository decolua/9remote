"use client";

import Icon, { GitBranch } from "@/shared/components/ui/Icon";
import SharedStatusBar, { statusItemCls, statusTextCls } from "@/shared/components/ui/StatusBar";
import { vibrate } from "@/shared/utils/vibration";

// File explorer status bar content. The shell (height, colours, borders) is the shared
// StatusBar so this bar and the terminal's line up exactly.
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
  onTogglePanel
}) {
  return (
    <SharedStatusBar
      left={<>
        <button
          onClick={() => { vibrate(); onToggleSidebar?.(); }}
          className={statusItemCls}
          title={sidebarVisible ? "Hide Sidebar" : "Show Sidebar"}
        >
          <Icon name={sidebarVisible ? "PanelLeftClose" : "PanelLeftOpen"} size={12} />
        </button>

        {activeFile && (
          <span className={statusTextCls}>
            <GitBranch size={12} className="opacity-60" />
            {gitBranch || "no branch"}
          </span>
        )}
      </>}
      right={<>
        {onTogglePanel && (
          <button
            onClick={() => { vibrate(); onTogglePanel(); }}
            className={statusItemCls}
            title={bottomVisible ? "Hide Terminal" : "Show Terminal"}
          >
            <Icon name="Terminal" size={12} />
          </button>
        )}

        {activeFile && (
          <>
            <span className={statusTextCls}>{`Ln ${line || 1}, Col ${column || 1}`}</span>
            <span className={statusTextCls}>{language || "plaintext"}</span>
            <span className={statusTextCls}>{encoding || "UTF-8"}</span>
          </>
        )}
      </>}
    />
  );
}
