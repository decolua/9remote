import { create } from "zustand";
import { VOICE_LS_KEYS, VOICE_ENDPOINT_DEFAULT } from "@/shared/lib/voiceStt";
import { useConnectionStore } from "@/shared/stores/connectionStore";

// Voice input config, per-device with agent persistence. `enabled` gates the
// mic buttons in every composer; `mode` picks the engine ("browser" Web Speech
// or "ai"); `preset` picks the AI provider (gemini, openrouter, custom).
const save = (key, value) => {
  try {
    const raw = Array.isArray(value) ? JSON.stringify(value)
      : typeof value === "boolean" ? (value ? "1" : "0") : value;
    localStorage.setItem(VOICE_LS_KEYS[key], raw);
  } catch {}
};

function pushToAgent(s) {
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
  setEnabled: (v) => { save("enabled", v); set({ enabled: v }); pushToAgent(get()); },
  setMode: (m) => { save("mode", m); set({ mode: m }); pushToAgent(get()); },
  setPreset: (p) => { save("preset", p); set({ preset: p }); pushToAgent(get()); },
  setField: (k, v) => { save(k, v); set({ [k]: v }); pushToAgent(get()); },
  syncFromAgent: (remote) => {
    if (!remote || typeof remote !== "object") return;
    set((prev) => {
      const next = { ...prev };
      if (typeof remote.enabled === "boolean") { next.enabled = remote.enabled; save("enabled", next.enabled); }
      if (remote.mode) { next.mode = remote.mode; save("mode", next.mode); }
      if (remote.preset) { next.preset = remote.preset; save("preset", next.preset); }
      if (Array.isArray(remote.geminiKeys)) { next.geminiKeys = remote.geminiKeys; save("geminiKeys", next.geminiKeys); }
      if (typeof remote.geminiModel === "string") { next.geminiModel = remote.geminiModel; save("geminiModel", next.geminiModel); }
      if (typeof remote.openrouterKey === "string") { next.openrouterKey = remote.openrouterKey; save("openrouterKey", next.openrouterKey); }
      if (typeof remote.openrouterModel === "string") { next.openrouterModel = remote.openrouterModel; save("openrouterModel", next.openrouterModel); }
      if (typeof remote.customEndpoint === "string") { next.customEndpoint = remote.customEndpoint; save("customEndpoint", next.customEndpoint); }
      if (typeof remote.customModel === "string") { next.customModel = remote.customModel; save("customModel", next.customModel); }
      if (typeof remote.customKey === "string") { next.customKey = remote.customKey; save("customKey", next.customKey); }
      if (typeof remote.opencodeModel === "string") { next.opencodeModel = remote.opencodeModel; save("opencodeModel", next.opencodeModel); }
      return next;
    });
  },
  pushToAgent: () => pushToAgent(get()),
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
