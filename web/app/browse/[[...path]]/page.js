"use client";

import { useEffect, useState } from "react";
import { SITE_SW_URL, SITE_SW_SCOPE } from "@/features/browser/constants/browserConfig";

// Cold-start shim for the site proxy SW. The first load of /browse/<port>/... is
// not yet SW-controlled, so this route registers the worker and reloads — from
// then on the SW serves everything under the scope and this page never runs again.
export default function BrowseBootstrap() {
  // Plain false start — a lazy navigator check would mismatch server/client HTML
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const reg = await navigator.serviceWorker.register(SITE_SW_URL, { scope: SITE_SW_SCOPE });
        const reload = () => { if (!cancelled) window.location.reload(); };
        if (navigator.serviceWorker.controller) return reload();
        const worker = reg.active || reg.waiting || reg.installing;
        if (worker?.state === "activated") return reload();
        worker?.addEventListener("statechange", () => {
          if (worker.state === "activated") reload();
        });
        // Worker never activates (rare) — one retry, never a reload loop
        setTimeout(() => { if (!cancelled && !navigator.serviceWorker.controller) reload(); }, 4000);
      } catch {
        // SW unavailable — stay put; reloading here would loop forever
        setFailed(true);
      }
    })();
    return () => { cancelled = true; };
  }, [failed]);

  return (
    <div style={{ fontFamily: "system-ui", display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", color: "#94a3b8", background: "inherit" }}>
      <p style={{ fontSize: 14 }}>{failed ? "Cannot connect: service worker unavailable" : "Connecting to local site…"}</p>
    </div>
  );
}
