"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Search, ChevronDown, ChevronRight, X } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";

const DEBOUNCE_MS = 400;

function basename(p) {
  if (!p) return "";
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function dirname(p) {
  if (!p) return "";
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(0, i) : "";
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Highlight matches inside a single line based on current options
function renderHighlighted(line, query, { caseSensitive, wholeWord, regex }) {
  if (!query) return line;
  let re;
  try {
    let pat = regex ? query : escapeRegExp(query);
    if (wholeWord && !regex) pat = `\\b${pat}\\b`;
    re = new RegExp(pat, caseSensitive ? "g" : "gi");
  } catch {
    return line;
  }
  const out = [];
  let last = 0;
  let m;
  let guard = 0;
  while ((m = re.exec(line)) !== null && guard++ < 500) {
    if (m.index > last) out.push(line.slice(last, m.index));
    out.push(
      <span key={`${m.index}-${guard}`} className="bg-brand-500/30 text-text rounded-sm">
        {m[0]}
      </span>
    );
    last = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

function ToggleBtn({ active, onClick, title, children }) {
  return (
    <button
      type="button"
      title={title}
      onClick={() => { vibrate(); onClick(); }}
      className={`px-2 h-6 text-xs rounded-brand border transition-colors ${
        active
          ? "bg-brand-500 text-white border-brand-500"
          : "bg-surface-2 text-text-muted border-border hover:bg-surface-3"
      }`}
    >
      {children}
    </button>
  );
}

export default function SearchPanel({ workspace, fileBus, onOpenFile }) {
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [includeGlob, setIncludeGlob] = useState("");
  const [excludeGlob, setExcludeGlob] = useState("");
  const [showGlobs, setShowGlobs] = useState(false);
  const [showReplace, setShowReplace] = useState(false);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState(new Set());
  const [confirmReplaceOpen, setConfirmReplaceOpen] = useState(false);
  const debounceRef = useRef(null);

  const runSearch = useCallback(async () => {
    if (!query || !workspace || !fileBus?.searchInFiles) {
      setResults([]);
      setSearchError(false);
      return;
    }
    setLoading(true);
    const res = await fileBus.searchInFiles(workspace, query, {
      caseSensitive,
      wholeWord,
      regex,
      includeGlob,
      excludeGlob
    });
    setLoading(false);
    if (res?.success) {
      setSearchError(false);
      const list = res.results || [];
      setResults(list);
      setExpandedFiles(new Set(list.map((r) => r.path)));
    } else {
      // A failed search reads exactly like "no matches" otherwise — the user thinks the
      // term is absent rather than that the ask never landed.
      setSearchError(true);
      setResults([]);
    }
  }, [query, workspace, fileBus, caseSensitive, wholeWord, regex, includeGlob, excludeGlob]);

  // Debounced search on query/options change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query) {
      setResults([]);
      setLoading(false);
      return;
    }
    debounceRef.current = setTimeout(runSearch, DEBOUNCE_MS);
    return () => clearTimeout(debounceRef.current);
  }, [query, caseSensitive, wholeWord, regex, includeGlob, excludeGlob, runSearch]);

  const totals = useMemo(() => {
    let matchCount = 0;
    for (const f of results) matchCount += (f.matches || []).length;
    return { files: results.length, matches: matchCount };
  }, [results]);

  const toggleExpand = useCallback((p) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p); else next.add(p);
      return next;
    });
  }, []);

  const handleReplaceAll = useCallback(async () => {
    if (!query || !workspace || !fileBus?.replaceInFiles || !results.length) return;
    const files = results.map((r) => r.path);
    setLoading(true);
    await fileBus.replaceInFiles(
      workspace,
      query,
      replacement,
      { caseSensitive, wholeWord, regex, includeGlob, excludeGlob },
      files
    );
    setLoading(false);
    runSearch();
  }, [query, replacement, workspace, fileBus, results, caseSensitive, wholeWord, regex, includeGlob, excludeGlob, runSearch]);

  return (
    <div className="flex flex-col h-full text-sm text-text">
      <div className="px-3 pt-3 pb-2 space-y-2 border-b border-border">
        <div className="relative">
          <Search size={14} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-subtle" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-full bg-surface-2 border border-border rounded-brand pl-7 pr-7 h-8 text-xs text-text placeholder-text-subtle focus:outline-none focus:border-brand-500"
          />
          {query && (
            <button
              type="button"
              onClick={() => { vibrate(); setQuery(""); }}
              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-text-subtle hover:text-text"
            >
              <X size={12} />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          <ToggleBtn active={caseSensitive} onClick={() => setCaseSensitive(!caseSensitive)} title="Match Case">Aa</ToggleBtn>
          <ToggleBtn active={wholeWord} onClick={() => setWholeWord(!wholeWord)} title="Whole Word">ab</ToggleBtn>
          <ToggleBtn active={regex} onClick={() => setRegex(!regex)} title="Regex">.*</ToggleBtn>
          <span className="flex-1" />
          <ToggleBtn active={showReplace} onClick={() => setShowReplace(!showReplace)} title="Toggle Replace">↔</ToggleBtn>
          <ToggleBtn active={showGlobs} onClick={() => setShowGlobs(!showGlobs)} title="Filters">…</ToggleBtn>
        </div>

        {showReplace && (
          <div className="flex items-center gap-1">
            <input
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
              placeholder="Replace"
              className="flex-1 bg-surface-2 border border-border rounded-brand px-2 h-8 text-xs text-text placeholder-text-subtle focus:outline-none focus:border-brand-500"
            />
            <button
              type="button"
              disabled={!query || !results.length}
              onClick={() => { vibrate(); setConfirmReplaceOpen(true); }}
              className="px-2 h-8 text-xs rounded-brand bg-brand-500 text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Replace All
            </button>
          </div>
        )}

        {showGlobs && (
          <div className="space-y-1">
            <input
              value={includeGlob}
              onChange={(e) => setIncludeGlob(e.target.value)}
              placeholder="files to include"
              className="w-full bg-surface-2 border border-border rounded-brand px-2 h-7 text-xs text-text placeholder-text-subtle focus:outline-none focus:border-brand-500"
            />
            <input
              value={excludeGlob}
              onChange={(e) => setExcludeGlob(e.target.value)}
              placeholder="files to exclude"
              className="w-full bg-surface-2 border border-border rounded-brand px-2 h-7 text-xs text-text placeholder-text-subtle focus:outline-none focus:border-brand-500"
            />
          </div>
        )}

        <div className={`text-[11px] ${searchError ? "text-danger" : "text-text-muted"}`}>
          {loading
            ? "Searching..."
            : searchError
              ? "Search failed — try again"
              : query ? `${totals.matches} results in ${totals.files} files` : "Type to search"}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {results.map((file) => {
          const expanded = expandedFiles.has(file.path);
          const base = basename(file.path);
          const dir = dirname(file.path);
          return (
            <div key={file.path} className="border-b border-border/60">
              <button
                type="button"
                onClick={() => { vibrate(); toggleExpand(file.path); }}
                className="w-full flex items-center gap-1 px-2 py-1 hover:bg-surface-2 text-left"
              >
                {expanded ? <ChevronDown size={12} className="text-text-subtle" /> : <ChevronRight size={12} className="text-text-subtle" />}
                <span className="truncate text-xs text-text" title={file.path}>{base}</span>
                <span className="truncate text-[11px] text-text-muted flex-1" title={dir}>{dir}</span>
                <span className="text-[10px] px-1.5 rounded-brand bg-surface-3 text-text-muted">{file.matches?.length || 0}</span>
              </button>
              {expanded && (
                <div className="pl-5">
                  {(file.matches || []).map((m, idx) => (
                    <button
                      key={`${file.path}-${idx}`}
                      type="button"
                      onClick={() => { vibrate(); onOpenFile?.(file.path, { line: m.line, column: m.column }); }}
                      className="w-full text-left px-2 py-0.5 text-[11px] text-text-muted hover:bg-surface-2 truncate font-mono"
                      title={m.lineText}
                    >
                      <span className="text-text-subtle mr-2">{m.line}</span>
                      {renderHighlighted(m.lineText || "", query, { caseSensitive, wholeWord, regex })}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        isOpen={confirmReplaceOpen}
        onClose={() => setConfirmReplaceOpen(false)}
        onConfirm={handleReplaceAll}
        title="Replace All"
        message={`Replace ${totals.matches} matches in ${totals.files} files?`}
        confirmText="Replace All"
        cancelText="Cancel"
      />
    </div>
  );
}
