import { useI18n } from "../i18n";
import Icon from "./Icon";
import { vibrate } from "../lib/vibrate";
import { FILE_ICON_NAMES, LANGUAGE_MAP, GIT_STATUS_COLORS } from "../lib/fileExplorer/constants";

const ICON_COLORS = {
  folder: "text-blue-400",
  file: "text-text-muted",
  fileCode: "text-yellow-500/70",
  fileJson: "text-green-500/70",
  fileText: "text-purple-500/70",
  package: "text-red-500/70",
  image: "text-pink-500/70",
};

function getFileIcon(file) {
  let iconName;
  if (file.type === "folder") iconName = FILE_ICON_NAMES.folder;
  else if (file.type === "binary") iconName = FILE_ICON_NAMES.binary;
  else {
    const ext = "." + file.name.split(".").pop()?.toLowerCase();
    const lang = LANGUAGE_MAP[ext];
    iconName = (lang && FILE_ICON_NAMES[lang]) || FILE_ICON_NAMES.file;
  }
  const colorClass = ICON_COLORS[iconName] || "text-text-muted";
  return <Icon name={iconName} size={20} className={colorClass} />;
}

function getRelativePath(filePath, workspacePath) {
  if (!workspacePath) return filePath;
  return filePath.replace(workspacePath + "/", "");
}

function getStatusColor(status) {
  if (status === "folder-changed") return "text-yellow-400";
  return GIT_STATUS_COLORS[status] || "";
}

export default function FileTree({ files, loading, onFileClick, onFolderClick, onMoreClick, selectedPath, gitStatusMap = {}, workspacePath }) {
  const { t } = useI18n();
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-text-muted">{t("common.loading")}</div>
      </div>
    );
  }
  if (!files || files.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-text-muted">{t("files.emptyFolder")}</div>
      </div>
    );
  }

  const handleMoreClick = (e, file) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    onMoreClick?.(file, { x: rect.right, y: rect.top });
  };

  return (
    <div>
      {files.map((file) => {
        const relativePath = getRelativePath(file.path, workspacePath);
        const gitStatus = gitStatusMap[relativePath];
        const statusColor = getStatusColor(gitStatus);
        return (
          <div
            key={file.path}
            className={`w-full px-4 py-1.5 flex items-center gap-2.5 border-b border-border hover:bg-surface-2 transition ${selectedPath === file.path ? "bg-surface-2" : ""}`}
          >
            <button
              onClick={() => { vibrate(); file.type === "folder" ? onFolderClick(file) : onFileClick(file); }}
              className="flex-1 flex items-center gap-2.5 text-left min-w-0"
            >
              <span className="flex-shrink-0">{getFileIcon(file)}</span>
              <div className="flex-1 min-w-0">
                <div className={`truncate text-sm ${statusColor || "text-text"}`}>
                  {file.name}
                  {gitStatus && gitStatus !== "folder-changed" && (
                    <span className="ml-2 text-xs opacity-70">[{gitStatus}]</span>
                  )}
                </div>
                {file.type !== "folder" && file.sizeFormatted && (
                  <div className="text-text-subtle text-xs">{file.sizeFormatted}</div>
                )}
              </div>
            </button>

            {onMoreClick && (
              <button
                onClick={(e) => { vibrate(); handleMoreClick(e, file); }}
                className="p-2 text-text-muted hover:text-text hover:bg-surface-2 rounded transition flex-shrink-0"
                title={t("menu.settings")}
              >
                <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                  <circle cx="12" cy="5" r="2" />
                  <circle cx="12" cy="12" r="2" />
                  <circle cx="12" cy="19" r="2" />
                </svg>
              </button>
            )}

            {file.type === "folder" && (
              <button
                onClick={() => { vibrate(); onFolderClick(file); }}
                className="p-1 text-text-muted flex-shrink-0"
              >
                <Icon name="chevronRight" size={20} />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
