"use client";

import { FILE_ICONS, LANGUAGE_MAP, GIT_STATUS_COLORS } from "../constants/fileExplorer.js";

function getFileIcon(file) {
  if (file.type === "folder") return FILE_ICONS.folder;
  if (file.type === "binary") return FILE_ICONS.binary;
  
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  const lang = LANGUAGE_MAP[ext];
  
  if (lang && FILE_ICONS[lang]) return FILE_ICONS[lang];
  return FILE_ICONS.file;
}

// Get relative path from workspace
function getRelativePath(filePath, workspacePath) {
  if (!workspacePath) return filePath;
  return filePath.replace(workspacePath + "/", "");
}

// Get git status color class
function getStatusColor(status) {
  if (status === "folder-changed") return "text-yellow-400";
  return GIT_STATUS_COLORS[status] || "";
}

export default function FileTree({ 
  files, 
  loading, 
  onFileClick, 
  onFolderClick, 
  onMoreClick,
  selectedPath,
  gitStatusMap = {},
  workspacePath
}) {
  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-slate-400">Loading...</div>
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-slate-400">Empty folder</div>
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
            className={`w-full px-4 py-3 flex items-center gap-3 border-b border-slate-800 hover:bg-slate-800/50 transition ${
              selectedPath === file.path ? "bg-slate-800" : ""
            }`}
          >
            <button
              onClick={() => file.type === "folder" ? onFolderClick(file) : onFileClick(file)}
              className="flex-1 flex items-center gap-3 text-left min-w-0"
            >
              <span className="text-xl flex-shrink-0">{getFileIcon(file)}</span>
              <div className="flex-1 min-w-0">
                <div className={`truncate ${statusColor || "text-white"}`}>
                  {file.name}
                  {gitStatus && gitStatus !== "folder-changed" && (
                    <span className="ml-2 text-xs opacity-70">[{gitStatus}]</span>
                  )}
                </div>
                {file.type !== "folder" && file.sizeFormatted && (
                  <div className="text-slate-500 text-xs">{file.sizeFormatted}</div>
                )}
              </div>
            </button>
            
            {/* More button (workspace mode only) */}
            {onMoreClick && (
              <button
                onClick={(e) => handleMoreClick(e, file)}
                className="p-2 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition flex-shrink-0"
                title="More actions"
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
                onClick={() => onFolderClick(file)}
                className="p-1 text-slate-400 flex-shrink-0"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
