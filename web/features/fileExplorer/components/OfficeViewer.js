"use client";

import { useState, useEffect, useRef } from "react";
import { Loader2 } from "@/shared/components/ui/Icon";
import { isDocxFile } from "../constants/fileExplorer.js";

// Office doc preview: docx via docx-preview, sheets (xlsx/xls/csv/tsv) via SheetJS.
// Streamed over the FILE channel, parsed client-side; libs are dynamic-imported
// so they only land in bundle when a user opens such a file.
export default function OfficeViewer({ filePath, fileSocket }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [sheets, setSheets] = useState([]);
  const [active, setActive] = useState(0);
  const [sheetHtml, setSheetHtml] = useState("");
  const docxRef = useRef(null);
  const wbRef = useRef(null);
  const XLSXRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let cancel = null;
    const chunks = [];
    const isDocx = isDocxFile(filePath);

    setLoading(true);
    setError("");
    setSheets([]);
    setActive(0);
    setSheetHtml("");
    wbRef.current = null;
    if (docxRef.current) docxRef.current.innerHTML = "";

    const renderSheet = (idx) => {
      const wb = wbRef.current;
      const XLSX = XLSXRef.current;
      if (!wb || !XLSX) return;
      const name = wb.SheetNames[idx];
      if (!name) return;
      setSheetHtml(XLSX.utils.sheet_to_html(wb.Sheets[name]));
      setLoading(false);
    };

    const render = async (buf) => {
      try {
        if (isDocx) {
          const { renderAsync } = await import("docx-preview");
          if (cancelled || !docxRef.current) return;
          await renderAsync(new Blob([buf]), docxRef.current, undefined, { inWrapper: true });
          if (!cancelled) setLoading(false);
        } else {
          const XLSX = await import("xlsx");
          if (cancelled) return;
          XLSXRef.current = XLSX;
          wbRef.current = XLSX.read(buf, { type: "array" });
          setSheets(wbRef.current.SheetNames);
          setActive(0);
          renderSheet(0);
        }
      } catch (e) {
        if (!cancelled) { setError(e.message || "Failed to render"); setLoading(false); }
      }
    };

    cancel = fileSocket.streamMedia(filePath, {
      onChunk: (payload) => { if (!cancelled) chunks.push(payload); },
      onDone: () => {
        if (cancelled) return;
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const buf = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
        render(buf);
      },
      onError: (e) => { if (!cancelled) { setError(e.message || "Failed to load"); setLoading(false); } }
    });

    return () => { cancelled = true; cancel?.(); };
  }, [filePath, fileSocket]);

  // Re-render when the active sheet tab changes.
  useEffect(() => {
    const wb = wbRef.current;
    const XLSX = XLSXRef.current;
    if (!wb || !XLSX) return;
    const name = wb.SheetNames[active];
    if (name) setSheetHtml(XLSX.utils.sheet_to_html(wb.Sheets[name]));
  }, [active]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted gap-2">
        <Loader2 className="animate-spin" size={20} />
        <span>Loading document...</span>
      </div>
    );
  }
  if (error) {
    return <div className="h-full flex items-center justify-center text-red-400 text-sm">{error}</div>;
  }

  const isDocx = isDocxFile(filePath);

  return (
    <div className="h-full flex flex-col">
      {!isDocx && sheets.length > 1 && (
        <div className="flex gap-1 overflow-x-auto bg-surface border-b border-border px-2 py-1 flex-shrink-0">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              className={`px-2 py-1 text-xs rounded whitespace-nowrap transition-colors ${
                i === active ? "bg-brand-500 text-white" : "bg-surface-2 text-text-muted hover:text-text"
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
      {/* Documents render on white (inherently light content) for readability. */}
      <div className="flex-1 min-h-0 overflow-auto bg-white text-black">
        {isDocx ? (
          <div ref={docxRef} className="p-4" />
        ) : (
          <div className="p-2 [&_table]:border-collapse [&_td]:border [&_td]:border-gray-300 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-gray-300 [&_th]:px-2 [&_th]:py-1" dangerouslySetInnerHTML={{ __html: sheetHtml }} />
        )}
      </div>
    </div>
  );
}
