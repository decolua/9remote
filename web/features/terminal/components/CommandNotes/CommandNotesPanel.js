"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { X, Pencil, Trash2, Copy, Check, FileText, Send } from "@/shared/components/ui/Icon";
import { useCommandNotes } from "@/features/terminal/hooks/useCommandNotes";
import { vibrate } from "@/shared/utils/vibration";
import { useDeviceInfo } from "@/shared/hooks/useDeviceInfo";

/**
 * CommandNotesPanel - Manage saved command line notes
 */
export default function CommandNotesPanel({ isOpen, onClose }) {
  const { notes, addNote, updateNote, deleteNote } = useCommandNotes();
  const [copiedId, setCopiedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [command, setCommand] = useState("");
  const textareaRef = useRef(null);
  const { isIosPwa } = useDeviceInfo();
  const [viewportHeight, setViewportHeight] = useState(null);

  // Focus textarea when panel opens or edit starts
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [isOpen, editingId]);

  // Track visual viewport to prevent keyboard covering textarea on mobile
  useEffect(() => {
    if (!isOpen || typeof window === "undefined" || !window.visualViewport) return;
    const vv = window.visualViewport;
    const update = () => setViewportHeight(vv.height);
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) onClose();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  const handleCopy = useCallback((id, cmd) => {
    vibrate();
    navigator.clipboard.writeText(cmd);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const handleStartEdit = useCallback((note) => {
    vibrate();
    setEditingId(note.id);
    setCommand(note.command);
  }, []);

  const handleSave = useCallback(() => {
    if (!command.trim()) return;
    vibrate();
    if (editingId) {
      updateNote(editingId, command.trim());
      setEditingId(null);
    } else {
      addNote(command.trim());
    }
    setCommand("");
  }, [command, editingId, addNote, updateNote]);

  const handleDelete = useCallback((id) => {
    vibrate();
    deleteNote(id);
    if (editingId === id) {
      setEditingId(null);
      setCommand("");
    }
  }, [deleteNote, editingId]);

  // Ctrl+Enter to save
  const handleKeyDown = useCallback((e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSave();
    }
  }, [handleSave]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-[2px] fade-in"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className="absolute top-0 right-0 w-[85vw] sm:w-96 max-w-md bg-dark-600 border-l border-dark-400 shadow-2xl flex flex-col slide-in-right"
        style={{ height: viewportHeight ? `${viewportHeight}px` : "100%" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className={`flex items-center justify-between px-4 py-3 border-b border-dark-400 flex-shrink-0 ${isIosPwa ? "safe-area-top" : ""}`}>
          <div className="flex items-center gap-2">
            <FileText size={20} className="text-brand-500" />
            <h2 className="text-lg font-semibold text-white">Command Notes</h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-dark-100 hover:text-white hover:bg-dark-500 rounded-brand transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* Notes List */}
        <div className="flex-1 overflow-y-auto modal-scrollable">
          {notes.length === 0 && (
            <div className="text-center text-dark-100 py-8">
              <FileText size={32} className="mx-auto mb-3 text-dark-200" />
              <p className="text-sm">No saved commands</p>
              <p className="text-xs text-dark-200 mt-1">Add your first command below</p>
            </div>
          )}

          {notes.map((note) => (
            <div
              key={note.id}
              className="px-4 py-3 border-b border-dark-500/50 hover:bg-dark-500/30 transition-colors group"
            >
              <div className="flex items-start justify-between gap-2">
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => handleCopy(note.id, note.command)}
                  title="Click to copy"
                >
                  <p className="text-sm text-white font-mono break-all">{note.command}</p>
                  {copiedId === note.id && (
                    <span className="text-xs text-green-400 mt-1 inline-block">Copied!</span>
                  )}
                </div>
                <div className="flex items-center gap-0.5 flex-shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleCopy(note.id, note.command)}
                    className="p-1.5 text-dark-100 hover:text-brand-400 rounded transition-colors"
                    title="Copy"
                  >
                    {copiedId === note.id ? (
                      <Check size={14} className="text-green-400" />
                    ) : (
                      <Copy size={14} />
                    )}
                  </button>
                  <button
                    onClick={() => handleStartEdit(note)}
                    className="p-1.5 text-dark-100 hover:text-brand-400 rounded transition-colors"
                    title="Edit"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(note.id)}
                    className="p-1.5 text-dark-100 hover:text-red-400 rounded transition-colors"
                    title="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Bottom Input */}
        <div className={`px-3 py-3 border-t border-dark-400 flex-shrink-0 ${isIosPwa ? "safe-area-bottom" : ""}`}>
          <div className="flex gap-2 items-end">
            <textarea
              ref={textareaRef}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={editingId ? "Edit command..." : "Add command..."}
              rows={2}
              className="flex-1 bg-dark-500 border border-dark-400 rounded-brand px-3 py-2 text-white text-sm placeholder-dark-100 focus:outline-none focus:border-brand-500 font-mono resize-none"
            />
            <button
              onClick={handleSave}
              disabled={!command.trim()}
              className="p-2.5 bg-brand-600 hover:bg-brand-500 disabled:bg-dark-400 disabled:cursor-not-allowed text-white rounded-brand transition-colors flex-shrink-0"
              title={editingId ? "Update" : "Add"}
            >
              <Send size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
