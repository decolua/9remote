"use client";

import { FILE_ICONS, LANGUAGE_MAP } from "../constants/fileExplorer.js";

function getFileIcon(file) {
  if (file.type === "folder") return FILE_ICONS.folder;
  if (file.type === "binary") return FILE_ICONS.binary;
  
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  const lang = LANGUAGE_MAP[ext];
  
  if (lang && FILE_ICONS[lang]) return FILE_ICONS[lang];
  return FILE_ICONS.file;
}

export default function FileTree({ 
  files, 
  loading, 
  onFileClick, 
  onFolderClick, 
  onLongPress,
  selectedPath 
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

  const handleTouchStart = (file, e) => {
    const timer = setTimeout(() => {
      onLongPress?.(file, e);
    }, 500);
    
    e.currentTarget.dataset.longPressTimer = timer;
  };

  const handleTouchEnd = (e) => {
    const timer = e.currentTarget.dataset.longPressTimer;
    if (timer) clearTimeout(timer);
  };

  return (
    <div className="flex-1 overflow-auto">
      {files.map((file) => (
        <button
          key={file.path}
          onClick={() => file.type === "folder" ? onFolderClick(file) : onFileClick(file)}
          onTouchStart={(e) => handleTouchStart(file, e)}
          onTouchEnd={handleTouchEnd}
          onContextMenu={(e) => {
            e.preventDefault();
            onLongPress?.(file, e);
          }}
          className={`w-full px-4 py-3 flex items-center gap-3 border-b border-slate-800 hover:bg-slate-800/50 transition text-left ${
            selectedPath === file.path ? "bg-slate-800" : ""
          }`}
        >
          <span className="text-xl flex-shrink-0">{getFileIcon(file)}</span>
          <div className="flex-1 min-w-0">
            <div className="text-white truncate">{file.name}</div>
            {file.type !== "folder" && file.sizeFormatted && (
              <div className="text-slate-500 text-xs">{file.sizeFormatted}</div>
            )}
          </div>
          {file.type === "folder" && (
            <svg className="w-5 h-5 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          )}
        </button>
      ))}
    </div>
  );
}
