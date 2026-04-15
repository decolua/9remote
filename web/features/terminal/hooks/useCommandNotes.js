import { useState, useCallback, useEffect } from "react";
import { COMMAND_NOTES_CONFIG, DEFAULT_COMMAND_NOTES } from "@/features/terminal/constants/commandNotes";

const { storageKey, maxNotes } = COMMAND_NOTES_CONFIG;

/**
 * Hook to manage command notes in localStorage
 * CRUD operations with auto-seed default commands
 */
export function useCommandNotes() {
  const [notes, setNotes] = useState([]);

  // Load notes from localStorage (seed defaults if empty)
  const loadNotes = useCallback(() => {
    if (typeof window === "undefined") return [];
    try {
      const data = localStorage.getItem(storageKey);
      if (data) return JSON.parse(data);
      // Seed default commands
      const defaults = DEFAULT_COMMAND_NOTES.map((n, i) => ({
        id: `default_${i}`,
        ...n
      }));
      localStorage.setItem(storageKey, JSON.stringify(defaults));
      return defaults;
    } catch (err) {
      console.error("Failed to load command notes:", err);
      return [];
    }
  }, []);

  // Init on mount
  useEffect(() => {
    setNotes(loadNotes());
  }, [loadNotes]);

  // Persist helper
  const persist = useCallback((updated) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(updated));
      setNotes(updated);
    } catch (err) {
      console.error("Failed to persist command notes:", err);
    }
  }, []);

  // Add note
  const addNote = useCallback((command) => {
    const updated = [
      { id: Date.now().toString(), command },
      ...notes
    ].slice(0, maxNotes);
    persist(updated);
  }, [notes, persist]);

  // Update note
  const updateNote = useCallback((id, command) => {
    const updated = notes.map((n) =>
      n.id === id ? { ...n, command } : n
    );
    persist(updated);
  }, [notes, persist]);

  // Delete note
  const deleteNote = useCallback((id) => {
    const updated = notes.filter((n) => n.id !== id);
    persist(updated);
  }, [notes, persist]);

  return { notes, addNote, updateNote, deleteNote };
}
