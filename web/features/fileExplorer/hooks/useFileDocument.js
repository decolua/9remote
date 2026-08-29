"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One file's contents, dirty flag and save, shared by every editor shell.
 *
 * Saving is explicit: there is no timer. An editor that saves behind the user's back
 * cannot be trusted with a file they are halfway through changing, and it hides write
 * failures until long after the edit that caused them.
 *
 * The live text lives in CodeMirror, not in React state — re-rendering the document on
 * every keystroke is what makes an editor feel slow. `register` hands this hook a reader
 * for it; `dirty` is driven by the editor telling us the text moved away from what was
 * loaded.
 */
export function useFileDocument({ filePath, fileBus }) {
  const [loading, setLoading] = useState(true);
  const [content, setContent] = useState(null);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  const originalRef = useRef("");
  const readTextRef = useRef(null);
  const savedTimerRef = useRef(null);
  // Set while something else is writing this file, so an editor holding unsaved edits
  // can offer the reload instead of having it done under the user's hands.
  const [staleOnDisk, setStaleOnDisk] = useState(false);

  // The editor calls this once it can read its own document.
  const register = useCallback((readText) => { readTextRef.current = readText; }, []);

  // Read the file into the document. `isCancelled` lets the mount effect abandon a read
  // whose file has already been switched away from; reload() passes nothing.
  const load = useCallback(async (isCancelled = () => false) => {
    setLoading(true);
    setError("");
    setDirty(false);
    setStaleOnDisk(false);

    const result = await fileBus.readFile(filePath);
    if (isCancelled()) return;
    if (!result?.success) {
      setError(result?.error || "");
      setLoading(false);
      return;
    }

    let text = result.content;
    // Over ~64KB the agent cannot answer inline (SCTP message limit) and asks us to
    // stream the file instead.
    if (result.streamInstead) {
      try {
        const chunks = [];
        await new Promise((resolve, reject) => {
          fileBus.streamMedia(filePath, {
            onMeta: () => {},
            onChunk: (payload) => chunks.push(payload),
            onDone: resolve,
            onError: reject
          });
        });
        if (isCancelled()) return;
        text = await new Blob(chunks).text();
      } catch (e) {
        if (isCancelled()) return;
        setError(e?.message || "");
        setLoading(false);
        return;
      }
    }

    originalRef.current = text;
    setContent(text);
    setLoading(false);
  }, [filePath, fileBus]);

  useEffect(() => {
    let cancelled = false;
    // Shells pass "" for a diff or a previewable binary: hooks cannot be skipped, so the
    // hook is told there is no document rather than being called conditionally.
    if (!filePath) {
      setLoading(false);
      setContent(null);
      setDirty(false);
      setError("");
      setStaleOnDisk(false);
      return;
    }
    load(() => cancelled);
    return () => { cancelled = true; };
  }, [filePath, load]);

  // Someone else wrote the file. Clean documents take the new text straight away;
  // a dirty one only raises the flag, because replacing text the user is halfway
  // through typing loses work no undo can reach.
  const onChangedOnDisk = useCallback(() => {
    if (dirty) { setStaleOnDisk(true); return; }
    load();
  }, [dirty, load]);

  useEffect(() => () => clearTimeout(savedTimerRef.current), []);

  // Called by the editor on every document change.
  const onTextChanged = useCallback((text) => {
    setDirty(text !== originalRef.current);
  }, []);

  const save = useCallback(async () => {
    const text = readTextRef.current?.();
    if (text == null || saving) return true;
    if (text === originalRef.current) return true;

    setSaving(true);
    const result = await fileBus.writeFile(filePath, text);
    setSaving(false);

    if (!result?.success) {
      setError(result?.error || "");
      return false;
    }
    originalRef.current = text;
    setDirty(false);
    setError("");
    setJustSaved(true);
    clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setJustSaved(false), 2000);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("fileExplorer:fileSaved", { detail: { filePath } }));
    }
    return true;
  }, [filePath, fileBus, saving]);

  // Give up the edits and go back to what is on disk.
  const discard = useCallback(() => {
    setDirty(false);
    setContent(originalRef.current);
  }, []);

  return {
    loading, content, error, dirty, saving, justSaved, staleOnDisk,
    register, onTextChanged, save, discard, setError,
    reload: load, onChangedOnDisk
  };
}
