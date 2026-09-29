// browserUse config, per-device with host persistence — the voice-input store
// pattern (voiceStore.js): zustand + localStorage, pushToHost on every change.
import { create } from "zustand";
import { useConnectionStore } from "@/shared/stores/connectionStore";

const LS_KEY = "browserUseConfig";

const defaults = {
  enabled: false,
  preset: "free",
  endpoint: "",
  model: "",
  apiKey: "",
  minConfidence: 0.55,
  headless: true,
  mode: "own",
  profile: "default"
};

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults };
  } catch {
    return { ...defaults };
  }
}

function persist(state) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ ...state, apiKey: "" })); } catch {}
}

function pushToHost(state) {
  try {
    const bus = useConnectionStore.getState().bus;
    bus?.emit?.("setBrowserUseConfig", {
      browserUseConfig: {
        enabled: state.enabled,
        preset: state.preset,
        endpoint: state.endpoint,
        model: state.model,
        apiKey: state.apiKey,
        minConfidence: state.minConfidence,
        headless: state.headless,
        mode: state.mode
      }
    });
  } catch {}
}

export const useBrowserUseStore = create((set, get) => ({
  ...load(),
  setConfig: (patch) => {
    const next = { ...get(), ...patch };
    set(next);
    persist(next);
    pushToHost(next);
  },
  setProfile: (profile) => get().setConfig({ profile })
}));
