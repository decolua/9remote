"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";
import { PREVIEW_NAV_SOURCE } from "../constants/fileExplorer";

// The preview needs a real HTTP origin, same as SitesList: LAN when the app itself
// is plain http, the tunnel otherwise. localIp is stored with the port included.
function resolveAgentBase(auth) {
  const canUseLan = auth?.localIp && typeof window !== "undefined" && window.location.protocol !== "https:";
  if (canUseLan) return `http://${auth.localIp}`;
  return auth?.tunnelUrl || null;
}

// The label an address bar shows: the file, not the /preview/<session-id> prefix in
// front of it. `root` is that prefix, which is noise to everyone but the router.
function displayPathOf(path, root) {
  const rel = root && path.startsWith(root) ? path.slice(root.length) : path;
  return decodeURIComponent(rel || "/").replace(/^\//, "") || "/";
}

// Serves the file from the agent's static preview route so relative assets (css/js/img)
// and links between pages resolve like a real site — hence the browser chrome: the frame
// navigates on its own, and a viewer with no way back would strand the user on page two.
// History is kept here rather than read off the iframe: it runs sandboxed on an opaque
// origin, so its location is unreadable from this side. The agent injects a reporter
// into every served HTML page, and those messages are what move this history along.
export default function HtmlViewer({ filePath, fileBus, reloadKey = 0 }) {
  const { t } = useI18n();
  const { getAuth } = useSessionStorage();
  // origin is the scheme+host the agent answers on; root is the path prefix that names
  // this preview session. Kept apart because the page reports paths that already carry
  // root — treating one of those as relative is what doubles the prefix.
  const [route, setRoute] = useState(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [lastPath, setLastPath] = useState(filePath);
  // Entries are frame-relative paths; index is where in them the frame stands.
  const [history, setHistory] = useState({ entries: [], index: -1 });
  const sessionRef = useRef(null);
  // A programmatic back/forward gets a nav report back from the page; without this
  // the report would be appended as a new entry and the forward stack would vanish.
  const seekingRef = useRef(false);

  // Reset during render (not in an effect) — the sanctioned reset-on-prop pattern.
  if (lastPath !== filePath) {
    setLastPath(filePath);
    setRoute(null);
    setError("");
    setHistory({ entries: [], index: -1 });
  }

  useEffect(() => {
    let cancelled = false;
    fileBus.previewStart(filePath).then((res) => {
      if (cancelled) {
        if (res.success) fileBus.previewEnd(res.sessionId);
        return;
      }
      if (!res.success) { setError(res.error || t("editor.previewFailed")); return; }
      const origin = resolveAgentBase(getAuth());
      if (!origin) {
        fileBus.previewEnd(res.sessionId);
        setError(t("editor.previewNoRoute"));
        return;
      }
      const root = `/preview/${res.sessionId}`;
      sessionRef.current = res.sessionId;
      setRoute({ origin, root });
      setHistory({ entries: [`${root}/${encodeURIComponent(res.entry)}`], index: 0 });
    });
    return () => {
      cancelled = true;
      if (sessionRef.current) fileBus.previewEnd(sessionRef.current);
      sessionRef.current = null;
    };
  // getAuth reads storage on demand; t is stable enough for an error string.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, fileBus]);

  // Where the page says it is now. Same path = a reload, not a new entry.
  const root = route?.root;
  useEffect(() => {
    if (!root) return;
    const onMessage = (e) => {
      if (e.data?.source !== PREVIEW_NAV_SOURCE || typeof e.data.path !== "string") return;
      const path = e.data.path;
      // Only this session's own pages belong in this history. Anything else is either a
      // stale frame from a previous file or a page that navigated out of the preview.
      if (!path.startsWith(root + "/") && path !== root) return;
      if (seekingRef.current) { seekingRef.current = false; return; }
      setHistory((prev) => {
        if (prev.index >= 0 && prev.entries[prev.index] === path) return prev;
        const entries = [...prev.entries.slice(0, prev.index + 1), path];
        return { entries, index: entries.length - 1 };
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [root]);

  const seek = useCallback((delta) => {
    vibrate();
    seekingRef.current = true;
    setHistory((prev) => {
      const index = Math.max(0, Math.min(prev.entries.length - 1, prev.index + delta));
      return index === prev.index ? prev : { ...prev, index };
    });
  }, []);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted text-sm px-6 text-center">
        {error}
      </div>
    );
  }
  if (!route) {
    return <div className="h-full flex items-center justify-center text-text-muted text-sm">{t("common.loading")}</div>;
  }

  // Entries are root-relative (they come from the page's own location), so only the
  // origin is prepended here.
  const current = history.entries[history.index] || route.root;
  const url = `${route.origin}${current}`;
  const canBack = history.index > 0;
  const canForward = history.index < history.entries.length - 1;
  const btn = "p-1 rounded-[3px] text-text-muted hover:text-text hover:bg-surface-2 transition-colors disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div className="h-full w-full flex flex-col bg-white">
      <div className="h-8 flex items-center gap-0.5 px-1.5 shrink-0 border-b border-border-subtle bg-surface">
        <button onClick={() => seek(-1)} disabled={!canBack} title={t("editor.previewBack")} className={btn}>
          <ChevronLeft size={14} />
        </button>
        <button onClick={() => seek(1)} disabled={!canForward} title={t("editor.previewForward")} className={btn}>
          <ChevronRight size={14} />
        </button>
        <button onClick={() => { vibrate(); setNonce((n) => n + 1); }} title={t("editor.reload")} className={btn}>
          <RefreshCw size={13} />
        </button>
        {/* Read-only: the frame owns navigation, and a box that looks typable but is not would lie */}
        <span className="flex-1 min-w-0 truncate px-2 py-0.5 mx-1 rounded-[3px] bg-surface-2 text-[11px] text-text-muted" title={displayPathOf(current, route.root)}>
          {displayPathOf(current, route.root)}
        </span>
        <button
          onClick={() => { vibrate(); window.open(url, "_blank", "noopener"); }}
          title={t("editor.previewOpenTab")}
          className={btn}
        >
          <ExternalLink size={13} />
        </button>
      </div>

      <iframe
        // The url alone would not remount on a repeat visit to the same page, so the
        // history index rides in the key — that is what makes back/forward navigate.
        key={`${url}|${history.index}|${reloadKey}|${nonce}`}
        src={url}
        // Scripts may run, but in an opaque origin: no app cookies/storage, no top navigation.
        sandbox="allow-scripts allow-forms allow-popups"
        className="flex-1 min-h-0 w-full border-0"
        title="HTML preview"
      />
    </div>
  );
}
