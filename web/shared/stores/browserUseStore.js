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
  profile: "default",
  hostKeySet: false // runtime flag: the host holds a saved (masked) api key
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
  // Host KV is the source of truth (it may be changed via CLI/other devices).
  // The masked apiKey "__SET__" means a key exists on the host — keep the local one.
  syncFromHost: (host) => {
    const next = {
      ...get(),
      enabled: host.enabled ?? get().enabled,
      preset: host.preset ?? get().preset,
      endpoint: host.endpoint ?? "",
      model: host.model ?? "",
      minConfidence: typeof host.minConfidence === "number" ? host.minConfidence : get().minConfidence,
      headless: host.headless ?? get().headless,
      mode: host.mode ?? get().mode,
      apiKey: host.apiKey === "__SET__" ? get().apiKey : (host.apiKey || ""),
      hostKeySet: host.apiKey === "__SET__"
    };
    set(next);
    persist(next);
  },
  setProfile: (profile) => get().setConfig({ profile })
}));
