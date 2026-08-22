"use client";

import { ExternalLink, Copy, X, ListChecks } from "@/shared/components/ui/Icon";
import { LINK_PATTERNS } from "../constants/linkPatterns";
import { useI18n } from "@/shared/i18n";

/**
 * Floating Action Button for selected text in terminal
 * Shows context menu with actions based on selection content
 */
export default function SelectionActionButton({
  text,
  position,
  onOpenUrl,
  onCopy,
  onAddToNote,
  onClose
}) {
  const { t } = useI18n();
  // Detect selection type
  const detectedType = detectSelectionType(text);

  // Handle action execution
  const handleAction = (action) => {
    if (action === "openUrl" && detectedType.isUrl) {
      onOpenUrl(detectedType.match);
    } else if (action === "copy") {
      onCopy(text);
    } else if (action === "addNote" && onAddToNote) {
      onAddToNote(text);
      return; // don't close here — caller controls overlay swap
    }
    onClose();
  };

  return (
    <div 
      className="fixed inset-0 bg-black/30 flex items-center justify-center z-[60]"
      onMouseDown={(e) => {
        // Prevent focus loss when clicking backdrop
        e.preventDefault();
        onClose();
      }}
    >
      <div 
        className="card-elev overflow-hidden min-w-[200px]"
        onMouseDown={(e) => {
          // Prevent focus loss when clicking modal content
          e.stopPropagation();
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-border bg-surface">
          <div className="text-text text-sm font-medium">Selected: {text.length > 30 ? text.substring(0, 30) + '...' : text}</div>
        </div>

        {/* Actions */}
        <div className="p-2">
          {/* URL action */}
          {detectedType.isUrl && (
            <button
              onClick={() => handleAction("openUrl")}
              className="w-full px-4 py-3 flex items-center gap-3 hover:bg-surface-2 text-text text-left rounded-brand transition-colors mb-1"
            >
              <ExternalLink size={20} />
              <span>Open URL</span>
            </button>
          )}

          {/* Copy action - always available */}
          <button
            onClick={() => handleAction("copy")}
            className="w-full px-4 py-3 flex items-center gap-3 hover:bg-surface-2 text-text text-left rounded-brand transition-colors mb-1"
          >
            <Copy size={20} />
            <span>Copy</span>
          </button>

          {/* Add to session note */}
          {onAddToNote && (
            <button
              onClick={() => handleAction("addNote")}
              className="w-full px-4 py-3 flex items-center gap-3 hover:bg-surface-2 text-text text-left rounded-brand transition-colors mb-1"
            >
              <ListChecks size={20} />
              <span>{t("terminalPane.addToNote")}</span>
            </button>
          )}

          {/* Close action */}
          <button
            onClick={onClose}
            className="w-full px-4 py-3 flex items-center gap-3 hover:bg-surface-2 text-red-400 text-left rounded-brand transition-colors border-t border-border mt-2 pt-3"
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
