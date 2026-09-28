import { create } from "zustand";
import { VOICE_LS_KEYS, VOICE_ENDPOINT_DEFAULT } from "@/shared/lib/voiceStt";
import { useConnectionStore } from "@/shared/stores/connectionStore";

// Voice input config, per-device with host persistence. `enabled` gates the
// mic buttons in every composer; `mode` picks the engine ("browser" Web Speech
// or "ai"); `preset` picks the AI provider (gemini, openrouter, custom).
const save = (key, value) => {
  try {
    const raw = Array.isArray(value) ? JSON.stringify(value)
      : typeof value === "boolean" ? (value ? "1" : "0") : value;
    localStorage.setItem(VOICE_LS_KEYS[key], raw);
  } catch {}
};

function pushToHost(s) {
  try {
    const bus = useConnectionStore.getState().bus;
    if (!bus || typeof bus.emit !== "function") return;
    bus.emit("setVoiceConfig", {
      voiceConfig: {
        enabled: s.enabled,
        mode: s.mode,
        preset: s.preset,
        geminiKeys: s.geminiKeys,
        geminiModel: s.geminiModel,
        openrouterKey: s.openrouterKey,
        openrouterModel: s.openrouterModel,
        customEndpoint: s.customEndpoint,
        customModel: s.customModel,
        customKey: s.customKey,
        opencodeModel: s.opencodeModel,
      }
    });
  } catch {}
}
const pushToAgent = pushToHost;

export const useVoiceStore = create((set, get) => ({
  enabled: true,
  mode: "browser",
  preset: "gemini",
  geminiKeys: [],
  geminiModel: "",
  openrouterKey: "",
  openrouterModel: "",
  customEndpoint: "",
  customModel: "",
  customKey: "",
  opencodeModel: "",
  setEnabled: (v) => { if (get().enabled === v) return; save("enabled", v); set({ enabled: v }); pushToHost(get()); },
  setMode: (m) => { if (get().mode === m) return; save("mode", m); set({ mode: m }); pushToHost(get()); },
  setPreset: (p) => { if (get().preset === p) return; save("preset", p); set({ preset: p }); pushToHost(get()); },
  setField: (k, v) => { if (get()[k] === v) return; save(k, v); set({ [k]: v }); pushToHost(get()); },
  // One write + one push for the engine chips — setMode+setPreset together
  // double-render the provider block below them.
  setEngine: (m, p) => {
    const s = get();
    if (s.mode === m && s.preset === p) return;
    save("mode", m); save("preset", p);
    set({ mode: m, preset: p });
    pushToHost(get());
  },
  syncFromHost: (remote) => {
    if (!remote || typeof remote !== "object") return;
    // serverInfo echoes arrive after every local pushToHost — an unchanged echo
    // must keep state identity or every full-store subscriber re-renders (the
    // voice form "flickers" on each engine/preset switch).
    const same = (a, b) => Array.isArray(a) && Array.isArray(b)
      ? a.length === b.length && a.every((v, i) => v === b[i])
      : a === b;
    set((prev) => {
      const next = { ...prev };
      let changed = false;
      const apply = (cond, key, value) => {
        if (!cond || same(next[key], value)) return;
        next[key] = value;
        changed = true;
        save(key, value);
      };
      apply(typeof remote.enabled === "boolean", "enabled", remote.enabled);
      apply(!!remote.mode, "mode", remote.mode);
      apply(!!remote.preset, "preset", remote.preset);
      apply(Array.isArray(remote.geminiKeys), "geminiKeys", remote.geminiKeys);
      for (const k of ["geminiModel", "openrouterKey", "openrouterModel", "customEndpoint", "customModel", "customKey", "opencodeModel"]) {
        apply(typeof remote[k] === "string", k, remote[k]);
      }
      return changed ? next : prev;
    });
  },
  syncFromAgent: (remote) => get().syncFromHost(remote),
  pushToHost: () => pushToHost(get()),
  pushToAgent: () => pushToHost(get()),
}));

// Hydrate once in the browser; every consumer is a client component.
if (typeof window !== "undefined") {
  try {
    const g = (k) => localStorage.getItem(VOICE_LS_KEYS[k]);
    const loadList = (raw) => { try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; } };
    const state = {
      enabled: g("enabled") !== "0",
      mode: g("mode") === "ai" ? "ai" : "browser",
      preset: ["gemini", "openrouter", "opencode", "custom"].includes(g("preset")) ? g("preset") : null,
      geminiKeys: loadList(g("geminiKeys")),
      geminiModel: g("geminiModel") || "",
      openrouterKey: g("openrouterKey") || "",
      openrouterModel: g("openrouterModel") || "",
      customEndpoint: g("customEndpoint") || "",
      customModel: g("customModel") || "",
      customKey: g("customKey") || "",
      opencodeModel: g("opencodeModel") || "",
    };
    // One-time migration of the legacy flat endpoint/apiKey/model config.
    if (!state.preset) {
      const ep = g("endpoint") || "", key = g("apiKey") || "", model = g("model") || "";
      if (ep.includes("generativelanguage")) {
        state.preset = "gemini";
        if (key) state.geminiKeys = [key];
      } else if (ep && ep !== VOICE_ENDPOINT_DEFAULT) {
        state.preset = "custom";
        state.customEndpoint = ep; state.customKey = key; state.customModel = model;
      } else if (key || model) {
        state.preset = "openrouter";
        state.openrouterKey = key;
      } else {
        state.preset = "gemini";
      }
      // Persist the migrated fields too, or a reload would hydrate them empty.
      save("preset", state.preset);
      if (model && state.preset !== "custom") state[`${state.preset}Model`] = model;
      if (state.geminiModel) save("geminiModel", state.geminiModel);
      if (state.openrouterModel) save("openrouterModel", state.openrouterModel);
      if (state.geminiKeys.length) save("geminiKeys", state.geminiKeys);
      if (state.openrouterKey) save("openrouterKey", state.openrouterKey);
      if (state.customEndpoint) save("customEndpoint", state.customEndpoint);
      if (state.customModel) save("customModel", state.customModel);
      if (state.customKey) save("customKey", state.customKey);
    }
    useVoiceStore.setState(state);
  } catch {}
}
