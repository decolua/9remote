"use client";

import { useTerminalStore } from "@/shared/stores/terminalStore";
import { useShallow } from "zustand/react/shallow";
import { TOGGLEABLE_BUTTONS } from "@/features/terminal/constants/terminalConfig";

// One read/write pair for every hideable button, so the settings screen and the
// slide menu render the same list without either knowing where a flag is stored:
// header ids live in a shared array, pane ids in their own boolean.
// Subscribes to just those flags — the bare-store form re-rendered on every
// unrelated set() (mobile drafts, status ticks) while a menu or dialog is open.
const BUTTON_SLICE = (s) => {
  const slice = { hiddenHeaderButtons: s.hiddenHeaderButtons, toggleHeaderButton: s.toggleHeaderButton };
  for (const btn of TOGGLEABLE_BUTTONS) {
    if (btn.group === "pane") {
      slice[btn.storeKey] = s[btn.storeKey];
      slice[btn.setterKey] = s[btn.setterKey];
    }
  }
  return slice;
};

export function useButtonToggles() {
  const state = useTerminalStore(useShallow(BUTTON_SLICE));
  const isOn = (btn) => (btn.group === "header"
    ? !state.hiddenHeaderButtons.includes(btn.id)
    : !!state[btn.storeKey]);
  const toggle = (btn) => (btn.group === "header"
    ? state.toggleHeaderButton(btn.id)
    : state[btn.setterKey](!state[btn.storeKey]));
  return { buttons: TOGGLEABLE_BUTTONS, isOn, toggle };
}
