"use client";

import { useCallback, useRef, useState, useEffect } from "react";

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "application/pdf", "text/plain"];
const MAX_SIZE_MB = 5;

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Compact inline button — dùng trong input bar
export function FileUploadButton({ onFilesReady, disabled, pendingCount = 0 }) {
  const inputRef = useRef(null);

  const processFiles = useCallback(async (fileList) => {
    const results = [];
    for (const file of fileList) {
      if (!ALLOWED_MIME.includes(file.type)) continue;
      if (file.size > MAX_SIZE_MB * 1024 * 1024) continue;
      const content = await fileToBase64(file);
      const isImage = file.type.startsWith("image/");
      results.push({
        type: isImage ? "image" : "file",
        mimeType: file.type,
        fileName: file.name,
        content,
        preview: isImage ? `data:${file.type};base64,${content}` : null,
      });
    }
    if (results.length > 0) onFilesReady(results);
  }, [onFilesReady]);

  const handleFileSelect = useCallback((e) => {
    const fileList = Array.from(e.target.files || []);
    processFiles(fileList);
    e.target.value = "";
  }, [processFiles]);

  // Paste handler
  useEffect(() => {
    const handlePaste = (e) => {
      if (disabled) return;
      const items = Array.from(e.clipboardData?.items || []);
      const fileList = items.map((item) => item.getAsFile()).filter(Boolean);
      if (fileList.length > 0) processFiles(fileList);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [disabled, processFiles]);

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        title="Đính kèm file (ảnh, PDF)"
        className="relative flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
      >
        <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.586-6.586a4 4 0 00-5.656-5.656L5.757 10.757a6 6 0 108.486 8.486L20 13" />
        </svg>
        {pendingCount > 0 && (
          <span className="absolute -top-1 -right-1 w-4 h-4 bg-blue-500 text-white text-[10px] rounded-full flex items-center justify-center leading-none">
            {pendingCount}
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ALLOWED_MIME.join(",")}
        onChange={handleFileSelect}
        className="hidden"
      />
    </>
  );
}

// Full drop zone component (legacy, kept for reuse)
export default function FileUpload({ onFilesReady, disabled }) {
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState([]);
  const inputRef = useRef(null);

  const processFiles = useCallback(async (fileList) => {
    const results = [];
    for (const file of fileList) {
      if (!ALLOWED_MIME.includes(file.type)) continue;
      if (file.size > MAX_SIZE_MB * 1024 * 1024) continue;
      const content = await fileToBase64(file);
      const isImage = file.type.startsWith("image/");
      results.push({
        type: isImage ? "image" : "file",
        mimeType: file.type,
        fileName: file.name,
        content,
        preview: isImage ? `data:${file.type};base64,${content}` : null,
      });
    }
    if (results.length > 0) {
      setFiles((prev) => [...prev, ...results]);
      onFilesReady(results);
    }
  }, [onFilesReady]);

  const handleDragOver = useCallback((e) => { e.preventDefault(); if (!disabled) setIsDragging(true); }, [disabled]);
  const handleDragLeave = useCallback(() => setIsDragging(false), []);
  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    processFiles(Array.from(e.dataTransfer.files));
  }, [disabled, processFiles]);

  const handleFileSelect = useCallback((e) => {
    processFiles(Array.from(e.target.files || []));
    e.target.value = "";
  }, [processFiles]);

  const handleRemove = useCallback((index) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  return (
    <div className="space-y-2">
      <div
        onClick={() => !disabled && inputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
          isDragging ? "border-brand-500 bg-brand-500/10" : "border-dark-400 hover:border-dark-300"
        } ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        <div className="text-dark-100 text-sm">📎 Kéo thả file, paste (Ctrl+V), hoặc click để chọn</div>
        <div className="text-dark-300 text-xs mt-1">Hỗ trợ: ảnh (jpg, png, webp, gif, heic), PDF • Max {MAX_SIZE_MB}MB</div>
      </div>
      <input ref={inputRef} type="file" multiple accept={ALLOWED_MIME.join(",")} onChange={handleFileSelect} className="hidden" />
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((file, i) => (
            <div key={i} className="relative group">
              {file.preview ? (
                <img src={file.preview} alt={file.fileName} className="w-16 h-16 object-cover rounded border border-dark-400" />
              ) : (
                <div className="w-16 h-16 flex items-center justify-center bg-dark-500 rounded border border-dark-400 text-2xl">📄</div>
              )}
              <button onClick={() => handleRemove(i)} className="absolute -top-1 -right-1 w-5 h-5 bg-red-600 text-white rounded-full text-xs opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
              <div className="text-xs text-dark-200 mt-1 truncate w-16" title={file.fileName}>{file.fileName}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
