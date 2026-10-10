"use client";

// Jev (browserUse) config form — fast native CDP browser automation.
// Model/provider config lives on the host (free preset by default); this form
// only exposes browser mode + attach guidance.
import { useCallback, useEffect, useState } from "react";
import { useBrowserUseStore } from "@/shared/stores/browserUseStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";
import { vibrate } from "@/shared/utils/vibration";
import { Copy, Check } from "@/shared/components/ui/Icon";

export function useBrowserUseInvoke(busRef) {
  return useCallback((action, payload) => new Promise((resolve) => {
    const bus = busRef?.current || useConnectionStore.getState().bus;
    if (!bus?.emit) return resolve({ ok: false, error: "no bus" });
    bus.emit("browserUse:invoke", { action, payload }, (res) => resolve(res || { ok: false, error: "no reply" }));
  }), [busRef]);
}

const ATTACH_GUIDE_URL = "chrome://inspect/#remote-debugging";

const EXAMPLE_PROMPTS = [
  "Find flights from Tokyo to Paris next month and compare prices",
  "Find today's top 3 trending AI repos on GitHub and summarize them",
  "Open Hacker News and check today's 3 top tech stories",
  "Log into the portal, go to Payments and download the latest PDF invoice"
];

function ExtensionStatus({ busRef }) {
  const invoke = useBrowserUseInvoke(busRef);
  const [ext, setExt] = useState(null);
  useEffect(() => {
    let alive = true;
    const poll = () => invoke("ext.status", {}).then((r) => { if (alive) setExt(r); });
    poll();
    const t = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [invoke]);

  const install = async () => {
    vibrate();
    await invoke("ext.install", {});
  };

  return (
    <div className="rounded-brand border border-border-subtle p-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className={`flex items-center gap-1.5 text-xs font-medium ${ext?.connected ? "text-emerald-500" : "text-amber-500"}`}>
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${ext?.connected ? "bg-emerald-500" : "bg-amber-500"}`} />
          {!ext ? "Checking…" : ext.ok === false ? (ext.error || "Unavailable") : ext.connected ? "Extension connected" : "Extension not connected"}
        </span>
        {ext?.ok && (
          <button onClick={install} className="px-2 py-1 bg-brand-500 text-white rounded-brand text-xs">
            {ext.installed ? "Reveal folder" : "Install"}
          </button>
        )}
      </div>
      {ext?.ok && !ext.connected && (
        <ol className="list-decimal ml-4 text-[11px] text-text-muted space-y-0.5">
          {(ext.guide || []).map((step, i) => <li key={i}>{step}</li>)}
        </ol>
      )}
    </div>
  );
}

export default function BrowserUseConfigForm({ busRef }) {
  const store = useBrowserUseStore();
  const invoke = useBrowserUseInvoke(busRef);
  const [attach, setAttach] = useState(null);
  const [checking, setChecking] = useState(false);
  const [copiedAttach, setCopiedAttach] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState(null);

  const save = (patch) => {
    store.setConfig(patch);
    invoke("config.set", patch);
  };

  // Pull the host's live config on mount — it is the source of truth and may
  // have been set from the CLI or another device.
  useEffect(() => {
    invoke("config.get").then((r) => { if (r.ok && r.config) store.syncFromHost(r.config); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const checkAttach = async () => {
    setChecking(true);
    const res = await invoke("attach.status", {});
    if (res.ok) setAttach(res);
    setChecking(false);
  };
  const openGuide = () => invoke("attach.open", {});
  const copyGuideUrl = async () => {
    try {
      await navigator.clipboard.writeText(ATTACH_GUIDE_URL);
      setCopiedAttach(true);
      setTimeout(() => setCopiedAttach(false), 1500);
    } catch {}
  };

  useEffect(() => {
    if (store.mode !== "attach") return;
    const t = setTimeout(checkAttach, 0);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.mode]);

  const copyPrompt = async (text) => {
    vibrate();
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPrompt(text);
      setTimeout(() => setCopiedPrompt(null), 1500);
    } catch {}
  };

  return (
    <div className="space-y-4">
      {/* Browser mode */}
      <label className="block text-xs text-text-muted">
        Browser mode
        <select value={store.mode || "own"} onChange={(e) => save({ mode: e.target.value })}
          className="mt-1 w-full px-2 py-1.5 bg-surface-2 rounded-brand text-sm text-text">
          <option value="own">Own browser — isolated profile (default, safe)</option>
          <option value="attach">Real browser — attach via debug mode</option>
          <option value="extension">Real browser — 9remote extension</option>
        </select>
      </label>

      {store.mode === "attach" && (
        <div className="rounded-brand border border-border-subtle p-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className={`flex items-center gap-1.5 text-xs font-medium ${attach?.available ? "text-emerald-500" : "text-amber-500"}`}>
              <span className={`inline-block h-1.5 w-1.5 rounded-full ${attach?.available ? "bg-emerald-500" : "bg-amber-500"}`} />
              {attach ? (attach.available ? `Attached · port ${attach.port}` : "Not attached") : "Checking…"}
            </span>
            <div className="flex items-center gap-1.5">
              <button onClick={openGuide} title="Open the debug opt-in page in Chrome"
                className="px-2 py-1 bg-brand-500 text-white rounded-brand text-xs">
                Open debug page
              </button>
              <button onClick={checkAttach} disabled={checking}
                className="px-2 py-1 bg-surface-2 rounded-brand text-xs text-text-muted disabled:opacity-40">
                {checking ? "…" : "Recheck"}
              </button>
            </div>
          </div>
          {attach && !attach.available && (
            <>
              <div className="flex items-center gap-1.5">
                <code className="flex-1 min-w-0 px-2 py-1 bg-surface-2 rounded-brand text-[11px] text-text truncate select-all">
                  {ATTACH_GUIDE_URL}
                </code>
                <button onClick={copyGuideUrl}
                  className="shrink-0 px-2 py-1 bg-surface-2 rounded-brand text-xs text-text-muted">
                  {copiedAttach ? "Copied" : "Copy"}
                </button>
              </div>
              <ol className="list-decimal ml-4 text-[11px] text-text-muted space-y-0.5">
                {(attach.guide || []).map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            </>
          )}
        </div>
      )}

      {store.mode === "extension" && <ExtensionStatus busRef={busRef} />}

      {/* Example Prompts */}
      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-text-muted">
          Example prompts (click to copy)
        </span>
        <div className="rounded-brand border border-border-subtle p-1 space-y-0.5 bg-surface-2/30">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              onClick={() => copyPrompt(prompt)}
              className="w-full text-left px-2.5 py-1.5 rounded hover:bg-surface-2/80 flex items-center justify-between gap-2 group transition-colors"
            >
              <span className="text-[11.5px] text-text truncate font-mono">
                {prompt}
              </span>
              <span className="flex-shrink-0 text-text-muted group-hover:text-text">
                {copiedPrompt === prompt ? (
                  <Check size={13} className="text-emerald-500" />
                ) : (
                  <Copy size={13} />
                )}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
