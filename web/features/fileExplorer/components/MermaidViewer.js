"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/shared/i18n";
import { useTheme } from "@/shared/theme/ThemeProvider";

// Mermaid is ~800KB — loaded on first use and kept for the rest of the session, so a
// second diagram renders immediately and someone who never opens one pays nothing.
let mermaidPromise = null;
function loadMermaid() {
  if (!mermaidPromise) mermaidPromise = import("mermaid").then((m) => m.default);
  return mermaidPromise;
}

// Strips the ```mermaid fence a model often leaves around the diagram — mermaid itself
// treats the backticks as syntax and refuses the whole thing.
function unfence(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/^```(?:mermaid)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

let renderSeq = 0;

// Renders a .mmd file as the diagram it describes. The source is already in hand (the
// panel loaded it to show as text), so nothing is fetched here.
export default function MermaidViewer({ content, reloadKey = 0 }) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");
  const hostRef = useRef(null);
  const source = unfence(content);

  // Clear the previous diagram the moment the source changes, without waiting for the
  // async render — adjusted during render, the sanctioned reset-on-prop pattern.
  const [lastSource, setLastSource] = useState(source);
  if (lastSource !== source) {
    setLastSource(source);
    setSvg("");
    setError("");
  }

  useEffect(() => {
    let cancelled = false;
    if (!source) return;

    loadMermaid().then(async (mermaid) => {
      if (cancelled) return;
      mermaid.initialize({
        startOnLoad: false,
        theme: theme === "dark" ? "dark" : "default",
        // The diagram is our own file, not third-party input, and strict mode drops
        // the HTML labels people routinely write.
        securityLevel: "loose",
      });
      try {
        // A fresh id each render: mermaid keys internal state off it and reusing one
        // leaves the previous diagram's definitions behind.
        const { svg: out } = await mermaid.render(`mmd-${++renderSeq}`, source);
        if (cancelled) return;
        setSvg(out);
        setError("");
      } catch (e) {
        if (cancelled) return;
        setSvg("");
        setError(e?.message || String(e));
      }
    }).catch((e) => {
      if (!cancelled) setError(e?.message || String(e));
    });

    return () => { cancelled = true; };
  }, [source, theme, reloadKey]);

  if (error) {
    return (
      <div className="h-full overflow-auto p-3">
        <p className="text-[11px] text-red-500 mb-2 break-words">{error}</p>
        {/* The source beside the error is what makes a syntax mistake findable */}
        <pre className="text-[11px] text-text-muted whitespace-pre-wrap break-words">{source}</pre>
      </div>
    );
  }
  if (!source) {
    return <div className="h-full flex items-center justify-center text-text-muted text-xs">{t("editor.mermaidEmpty")}</div>;
  }
  if (!svg) {
    return <div className="h-full flex items-center justify-center text-text-muted text-xs">{t("common.loading")}</div>;
  }

  return (
    <div
      ref={hostRef}
      className="h-full overflow-auto p-3 flex items-start justify-center [&_svg]:max-w-full [&_svg]:h-auto"
      // mermaid returns SVG it built from our own file; there is no other way to mount it
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
