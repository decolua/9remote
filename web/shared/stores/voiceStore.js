import { create } from "zustand";
import { VOICE_LS_KEYS } from "@/shared/lib/voiceStt";

// Voice input config, per-device. `enabled` gates the mic buttons in every
// composer (default on = previous always-on behavior); `mode` picks the engine:
// "browser" (Web Speech API) or "ai" (custom OpenAI-compatible endpoint).
const save = (key, value) => {
  try { localStorage.setItem(VOICE_LS_KEYS[key], typeof value === "boolean" ? (value ? "1" : "0") : value); } catch {}
};

export const useVoiceStore = create((set) => ({
  enabled: true,
  mode: "browser",
  endpoint: "",
  apiKey: "",
  model: "",
  setEnabled: (v) => { save("enabled", v); set({ enabled: v }); },
  setMode: (m) => { save("mode", m); set({ mode: m }); },
  setField: (k, v) => { save(k, v); set({ [k]: v }); },
}));

// Hydrate once in the browser; every consumer is a client component.
if (typeof window !== "undefined") {
  try {
    const g = (k) => localStorage.getItem(VOICE_LS_KEYS[k]);
    useVoiceStore.setState({
      enabled: g("enabled") !== "0",
      mode: g("mode") === "ai" ? "ai" : "browser",
      endpoint: g("endpoint") || "",
      apiKey: g("apiKey") || "",
      model: g("model") || "",
    });
  } catch {}
}
