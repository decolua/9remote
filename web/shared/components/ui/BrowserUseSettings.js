"use client";

// Jev (browserUse) config form — one component, two mounts: the settings dialog
// section and the agent panel's gear. Same store, same host push, one truth.
import { useCallback, useState } from "react";
import { useBrowserUseStore } from "@/shared/stores/browserUseStore";
import { useConnectionStore } from "@/shared/stores/connectionStore";

export function useBrowserUseInvoke(busRef) {
  return useCallback((action, payload) => new Promise((resolve) => {
    const bus = busRef?.current || useConnectionStore.getState().bus;
    if (!bus?.emit) return resolve({ ok: false, error: "no bus" });
    bus.emit("browserUse:invoke", { action, payload }, (res) => resolve(res || { ok: false, error: "no reply" }));
  }), [busRef]);
}

export default function BrowserUseConfigForm({ busRef }) {
  const store = useBrowserUseStore();
  const invoke = useBrowserUseInvoke(busRef);
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);
  const [attach, setAttach] = useState(null);
  const [checking, setChecking] = useState(false);

  const save = (patch) => {
    store.setConfig(patch);
    invoke("config.set", patch);
  };
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

  return (
    <div className="space-y-4">
      {store.enabled && (
        <p className="text-xs text-amber-500">
          Page text of allowed sites is sent to the Jev endpoint ({store.preset === "free" ? "opencode.ai" : "your configured provider"}) for decisions.
        </p>
      )}

      <label className="block text-xs text-text-muted">
        browser mode
        <select value={store.mode} onChange={(e) => save({ mode: e.target.value })}
          className="mt-1 w-full px-2 py-1.5 bg-surface-2 rounded-brand text-sm text-text">
          <option value="own">Own browser — isolated profile (default, safe)</option>
          <option value="attach">Real browser — attach via debug mode</option>
        </select>
      </label>

      {store.mode === "attach" && (
        <div className="p-2 rounded-brand bg-surface-2 text-xs space-y-1">
          <div className="flex items-center gap-2">
            <button onClick={checkAttach} disabled={checking}
              className="px-2 py-1 bg-brand-500 text-white rounded-brand text-xs disabled:opacity-40">
              {checking ? "checking…" : "Check"}
            </button>
            {attach && (
              <span className={attach.available ? "text-emerald-500" : "text-amber-500"}>
                {attach.available ? `attached (port ${attach.port})` : "not attached"}
              </span>
            )}
          </div>
          {attach && !attach.available && (
            <ol className="list-decimal ml-4 text-text-muted space-y-0.5">
              {(attach.guide || []).map((step, i) => <li key={i}>{step}</li>)}
            </ol>
          )}
        </div>
      )}

      <label className="block text-xs text-text-muted">
        preset
        <select value={store.preset} onChange={(e) => save({ preset: e.target.value })}
          className="mt-1 w-full px-2 py-1.5 bg-surface-2 rounded-brand text-sm text-text">
          <option value="free">Free (opencode lane)</option>
          <option value="openrouter">OpenRouter</option>
          <option value="custom">Custom</option>
        </select>
      </label>

      {(store.preset !== "free" || store.endpoint) && (
        <label className="block text-xs text-text-muted">
          endpoint
          <input type="text" value={store.endpoint} onChange={(e) => store.setConfig({ endpoint: e.target.value })}
            onBlur={() => save({ endpoint: store.endpoint })}
            placeholder="https://…/systemone" spellCheck={false}
            className="mt-1 w-full px-2 py-1.5 bg-surface-2 rounded-brand text-sm text-text" />
        </label>
      )}
      <label className="block text-xs text-text-muted">
        model {store.preset === "free" && <span className="opacity-60">(default: jev-1.13-free)</span>}
        <input type="text" value={store.model} onChange={(e) => store.setConfig({ model: e.target.value })}
          onBlur={() => save({ model: store.model })} placeholder="default"
          className="mt-1 w-full px-2 py-1.5 bg-surface-2 rounded-brand text-sm text-text" />
      </label>
      {store.preset !== "free" && (
        <label className="block text-xs text-text-muted">
          api key
          <input type="password" value={store.apiKey} onChange={(e) => store.setConfig({ apiKey: e.target.value })}
            onBlur={() => save({ apiKey: store.apiKey })} placeholder="sk-…"
            className="mt-1 w-full px-2 py-1.5 bg-surface-2 rounded-brand text-sm text-text" />
        </label>
      )}

      <div className="flex items-center gap-6">
        <label className="flex items-center gap-2 text-xs text-text-muted">
          min confidence
          <input
            type="range" min="0.3" max="0.9" step="0.05" value={store.minConfidence}
            onChange={(e) => save({ minConfidence: Number(e.target.value) })}
            className="accent-brand-500" />
          <span className="text-text font-mono">{store.minConfidence}</span>
        </label>
        <label className="flex items-center gap-2 text-xs text-text-muted">
          <input
            type="checkbox" checked={store.headless} onChange={(e) => save({ headless: e.target.checked })}
            className="accent-brand-500" />
          headless (own browser)
        </label>
      </div>

      <div className="flex items-center gap-2">
        <button onClick={runTest} disabled={testing}
          className="px-3 py-1.5 bg-brand-500 text-white rounded-brand text-sm disabled:opacity-40">
          {testing ? "testing…" : "Test"}
        </button>
        <span className={`text-xs ${test?.startsWith("OK") ? "text-emerald-500" : "text-red-500"}`}>{test}</span>
      </div>
    </div>
  );
}
