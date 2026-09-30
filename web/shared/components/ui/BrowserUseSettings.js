"use client";

// Jev (browserUse) config form — one component, two mounts: the settings dialog
// section and the agent panel's gear. Same store, same host push, one truth.
import { useCallback, useEffect, useState } from "react";
import { useBrowserUseStore } from "@/shared/stores/browserUseStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";

export function useBrowserUseInvoke(busRef) {
  return useCallback((action, payload) => new Promise((resolve) => {
    const bus = busRef?.current || useConnectionStore.getState().bus;
    if (!bus?.emit) return resolve({ ok: false, error: "no bus" });
    bus.emit("browserUse:invoke", { action, payload }, (res) => resolve(res || { ok: false, error: "no reply" }));
  }), [busRef]);
}

const ATTACH_GUIDE_URL = "chrome://inspect/#remote-debugging";

export default function BrowserUseConfigForm({ busRef }) {
  const store = useBrowserUseStore();
  const invoke = useBrowserUseInvoke(busRef);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [attach, setAttach] = useState(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

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
  const runTest = async () => {
    setTesting(true); setTest(null);
    const res = await invoke("test", {});
    setTest(res.ok ? `OK · ${res.model} · ${res.latencyMs}ms` : res.error);
    setTesting(false);
  };
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
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — the code text is still selectable */ }
  };
  // Auto-check on entry and on switch to attach — status should never wait for a click.
  useEffect(() => {
    if (store.mode !== "attach") return;
    const t = setTimeout(checkAttach, 0); // deferred: setState must not run sync in the effect body
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.mode]);

  return (
    <div className="space-y-4">
      <label className="block text-xs text-text-muted">
        Browser mode
        <select value={store.mode} onChange={(e) => save({ mode: e.target.value })}
          className="mt-1 w-full px-2 py-1.5 bg-surface-2 rounded-brand text-sm text-text">
          <option value="own">Own browser — isolated profile (default, safe)</option>
          <option value="attach">Real browser — attach via debug mode</option>
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
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <ol className="list-decimal ml-4 text-[11px] text-text-muted space-y-0.5">
                {(attach.guide || []).map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            </>
          )}
        </div>
      )}

      <label className="block text-xs text-text-muted">
        Preset
        <select value={store.preset} onChange={(e) => save({ preset: e.target.value })}
          className="mt-1 w-full px-2 py-1.5 bg-surface-2 rounded-brand text-sm text-text">
          <option value="free">Free (opencode lane)</option>
          <option value="openrouter">OpenRouter</option>
          <option value="custom">Custom</option>
        </select>
      </label>

      {(store.preset !== "free" || store.endpoint) && (
        <label className="block text-xs text-text-muted">
          Endpoint
          <input type="text" value={store.endpoint} onChange={(e) => store.setConfig({ endpoint: e.target.value })}
            onBlur={() => save({ endpoint: store.endpoint })}
            placeholder={store.preset === "openrouter" ? "default: https://openrouter.ai/api/v1/systemone" : "https://…/systemone"} spellCheck={false}
            className="mt-1 w-full px-2 py-1.5 bg-surface-2 rounded-brand text-sm text-text" />
        </label>
      )}
      <label className="block text-xs text-text-muted">
        Model {store.preset === "free" && <span className="opacity-60">(default: jev-1.13-free)</span>}
        <input type="text" value={store.model} onChange={(e) => store.setConfig({ model: e.target.value })}
          onBlur={() => save({ model: store.model })} placeholder="default"
          className="mt-1 w-full px-2 py-1.5 bg-surface-2 rounded-brand text-sm text-text" />
      </label>
      {store.preset !== "free" && (
        <label className="block text-xs text-text-muted">
          API key {store.hostKeySet && <span className="text-emerald-500">• saved on host — paste a new one to replace</span>}
            {!store.hostKeySet && <span className="opacity-60"> (empty = reuse the Voice input OpenRouter key)</span>}
          <input type="password" value={store.apiKey} onChange={(e) => store.setConfig({ apiKey: e.target.value })}
            onBlur={() => save({ apiKey: store.apiKey })} placeholder={store.hostKeySet ? "••••••••" : "sk-…"}
            className="mt-1 w-full px-2 py-1.5 bg-surface-2 rounded-brand text-sm text-text" />
        </label>
      )}

      <div className="flex items-center gap-2">
        <button onClick={runTest} disabled={testing}
          className="px-3 py-1.5 bg-brand-500 text-white rounded-brand text-sm disabled:opacity-40">
          {testing ? "Testing…" : "Test"}
        </button>
        <span className={`text-xs ${test?.startsWith("OK") ? "text-emerald-500" : "text-red-500"}`}>{test}</span>
      </div>
    </div>
  );
}
