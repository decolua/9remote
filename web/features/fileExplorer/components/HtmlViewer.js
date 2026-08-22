"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "@/shared/components/ui/Icon";
import { vibrate } from "@/shared/utils/vibration";
import { useI18n } from "@/shared/i18n";
import { useSessionStorage } from "@/shared/hooks/useSessionStorage";

// The preview needs a real HTTP origin, same as SitesList: LAN when the app itself
// is plain http, the tunnel otherwise. localIp is stored with the port included.
function resolveAgentBase(auth) {
  const canUseLan = auth?.localIp && typeof window !== "undefined" && window.location.protocol !== "https:";
  if (canUseLan) return `http://${auth.localIp}`;
  return auth?.tunnelUrl || null;
}

// Serves the file from the agent's static preview route so relative assets
// (css/js/img) resolve like a real site. reloadKey bumps on save; the iframe
// remounts on key change, which is the reload.
export default function HtmlViewer({ filePath, fileSocket, reloadKey = 0 }) {
  const { t } = useI18n();
  const { getAuth } = useSessionStorage();
  const [url, setUrl] = useState(null);
  const [error, setError] = useState("");
  const [nonce, setNonce] = useState(0);
  const [lastPath, setLastPath] = useState(filePath);
  const sessionRef = useRef(null);

  // Reset during render (not in an effect) — the sanctioned reset-on-prop pattern.
  if (lastPath !== filePath) {
    setLastPath(filePath);
    setUrl(null);
    setError("");
  }

  useEffect(() => {
    let cancelled = false;
    fileSocket.previewStart(filePath).then((res) => {
      if (cancelled) {
        if (res.success) fileSocket.previewEnd(res.sessionId);
        return;
      }
      if (!res.success) { setError(res.error || t("editor.previewFailed")); return; }
      const base = resolveAgentBase(getAuth());
      if (!base) {
        fileSocket.previewEnd(res.sessionId);
        setError(t("editor.previewNoRoute"));
        return;
      }
      sessionRef.current = res.sessionId;
      setUrl(`${base}/preview/${res.sessionId}/${encodeURIComponent(res.entry)}`);
    });
    return () => {
      cancelled = true;
      if (sessionRef.current) fileSocket.previewEnd(sessionRef.current);
      sessionRef.current = null;
    };
  // getAuth reads storage on demand; t is stable enough for an error string.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, fileSocket]);

  if (error) {
    return (
      <div className="h-full flex items-center justify-center text-text-muted text-sm px-6 text-center">
        {error}
      </div>
    );
  }
  if (!url) {
    return <div className="h-full flex items-center justify-center text-text-muted text-sm">{t("common.loading")}</div>;
  }

  return (
    <div className="relative h-full w-full bg-white">
      <iframe
        key={`${url}|${reloadKey}|${nonce}`}
        src={url}
        // Scripts may run, but in an opaque origin: no app cookies/storage, no top navigation.
        sandbox="allow-scripts allow-forms allow-popups"
        className="absolute inset-0 w-full h-full border-0"
        title="HTML preview"
      />
      <button
        onClick={() => { vibrate(); setNonce((n) => n + 1); }}
        title={t("editor.reload")}
        className="absolute top-2 right-2 p-1.5 rounded-[4px] bg-surface-2/90 text-text-muted hover:text-text shadow-sm border border-border-subtle"
      >
        <RefreshCw size={13} />
      </button>
    </div>
  );
}
