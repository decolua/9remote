"use client";

import { FileText, ExternalLink, Copy, X } from "@/shared/components/ui/Icon";
import { parseFilePathWithLine } from "../utils/linkDetector";
import { LINK_PATTERNS } from "../constants/linkPatterns";

/**
 * Floating Action Button for selected text in terminal
 * Shows context menu with actions based on selection content
 */
export default function SelectionActionButton({ 
  text, 
  position, 
  onOpenFile, 
  onOpenUrl, 
  onCopy, 
  onClose 
}) {
  // Detect selection type
  const detectedType = detectSelectionType(text);

  // Handle action execution
  const handleAction = (action) => {
    if (action === "openFile" && detectedType.isFile) {
      const { path, line, column } = parseFilePathWithLine(detectedType.match);
      onOpenFile(path, line, column);
    } else if (action === "openUrl" && detectedType.isUrl) {
      onOpenUrl(detectedType.match);
    } else if (action === "copy") {
      onCopy(text);
    }
    onClose();
  };

  return (
    <div 
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-50"
      onMouseDown={(e) => {
        // Prevent focus loss when clicking backdrop
        e.preventDefault();
        onClose();
      }}
    >
      <div 
        className="bg-dark-500 border border-dark-400 rounded-lg shadow-xl overflow-hidden min-w-[200px]"
        onMouseDown={(e) => {
          // Prevent focus loss when clicking modal content
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-dark-400 bg-dark-600">
          <div className="text-white text-sm font-medium">Selected: {text.length > 30 ? text.substring(0, 30) + '...' : text}</div>
        </div>

        {/* Actions */}
        <div className="p-2">
          {/* File action */}
          {detectedType.isFile && (
            <button
              onClick={() => handleAction("openFile")}
              className="w-full px-4 py-3 flex items-center gap-3 hover:bg-dark-400 text-white text-left rounded-brand transition-colors mb-1"
            >
              <FileText size={20} />
              <span>Open in Editor</span>
            </button>
          )}

          {/* URL action */}
          {detectedType.isUrl && (
            <button
              onClick={() => handleAction("openUrl")}
              className="w-full px-4 py-3 flex items-center gap-3 hover:bg-dark-400 text-white text-left rounded-brand transition-colors mb-1"
            >
              <ExternalLink size={20} />
              <span>Open URL</span>
            </button>
          )}

          {/* Copy action - always available */}
          <button
            onClick={() => handleAction("copy")}
            className="w-full px-4 py-3 flex items-center gap-3 hover:bg-dark-400 text-white text-left rounded-brand transition-colors mb-1"
          >
            <Copy size={20} />
            <span>Copy</span>
          </button>

          {/* Close action */}
          <button
            onClick={onClose}
            className="w-full px-4 py-3 flex items-center gap-3 hover:bg-dark-400 text-red-400 text-left rounded-brand transition-colors border-t border-dark-400 mt-2 pt-3"
          >
            <X size={20} />
            <span>Close</span>
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Detect selection type (file, URL, or plain text)
 * @param {string} text - Selected text
 * @returns {Object} Detection result with type flags and matched text
 */
export function detectSelectionType(text) {
  const trimmed = text.trim();
  
  // Check if it's a URL
  const urlMatch = trimmed.match(LINK_PATTERNS.WEB_HTTP);
  if (urlMatch) {
    return { isUrl: true, isFile: false, match: urlMatch[0] };
  }
  
  // Check localhost
  const localhostMatch = trimmed.match(LINK_PATTERNS.WEB_LOCALHOST);
  if (localhostMatch) {
    return { isUrl: true, isFile: false, match: `http://${localhostMatch[0]}` };
  }
  
  // Check file with line numbers
  const fileWithLineMatch = trimmed.match(LINK_PATTERNS.FILE_WITH_LINE);
  if (fileWithLineMatch) {
    return { isUrl: false, isFile: true, match: fileWithLineMatch[0] };
  }
  
  // Check absolute file path
  const absoluteMatch = trimmed.match(LINK_PATTERNS.FILE_ABSOLUTE);
  if (absoluteMatch) {
    return { isUrl: false, isFile: true, match: absoluteMatch[0] };
  }
  
  // Check relative file path
  const relativeMatch = trimmed.match(LINK_PATTERNS.FILE_RELATIVE);
  if (relativeMatch) {
    return { isUrl: false, isFile: true, match: relativeMatch[0] };
  }
  
  // Plain text - only copy available
  return { isUrl: false, isFile: false, match: trimmed };
}
