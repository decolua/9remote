"use client";

import { useTerminalStore } from "@/shared/stores/terminalStore";
import { TOGGLEABLE_BUTTONS } from "@/features/terminal/constants/terminalConfig";

// One read/write pair for every hideable button, so the settings screen and the
// slide menu render the same list without either knowing where a flag is stored:
// header ids live in a shared array, pane ids in their own boolean.
export function useButtonToggles() {
  const state = useTerminalStore();
  const isOn = (btn) => (btn.group === "header"
    ? !state.hiddenHeaderButtons.includes(btn.id)
    : !!state[btn.storeKey]);
  const toggle = (btn) => (btn.group === "header"
    ? state.toggleHeaderButton(btn.id)
    : state[btn.setterKey](!state[btn.storeKey]));
  return { buttons: TOGGLEABLE_BUTTONS, isOn, toggle };
}
