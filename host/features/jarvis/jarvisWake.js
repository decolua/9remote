// Waking the conductor when a worker finishes. Two event sources feed the same
// door: the CLI Stop hooks posted to /api/notify (workers in terminals — the
// ones create_session spawns) and the AI manager's turn_complete (chat-pane
// workers). On each: fold the board immediately (cards go truthful now, not on
// the next poll) and, after a debounce, hand the idle chat agent one turn.
import { globalAiManager } from "../ai/aiManager.js";
import { fleetSnapshot } from "./fleetRunner.js";
import { foldFleetIntoBoard } from "./jarvisState.js";
import { jarvisWakeTurn } from "./jarvisAgent.js";

const WAKE_DEBOUNCE_MS = 3000;

export function createJarvisWake({
  wake = jarvisWakeTurn,
  refreshBoard = async () => { await foldFleetIntoBoard(await fleetSnapshot()); },
  debounceMs = WAKE_DEBOUNCE_MS,
  enabled = true
} = {}) {
  let isEnabled = enabled;
  let pending = [];
  let timer = null;

  return {
    setWakeEnabled(value) { isEnabled = !!value; },

    onWorkerDone(sessionId) {
      if (!isEnabled || !sessionId) return;
      if (!pending.includes(sessionId)) pending.push(sessionId);
      void refreshBoard();
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void this._flush(); }, debounceMs);
    },

    async _flush() {
      const done = pending;
      pending = [];
      if (!done.length) return;
      // The standalone agent guards itself (no key / mid-turn → skipped); the
      // board fold above already carries the truth either way.
      const who = done.length === 1 ? `Worker ${done[0]}` : `Workers ${done.join(", ")}`;
      try {
        await wake(
          `[9remote] ${who} changed state (finished or awaiting approval) — check with list_fleet, ` +
          "update the kanban board if needed, and only report back briefly when something matters."
        );
      } catch { /* a failed wake is logged by the agent; the board is still right */ }
    }
  };
}

// The one live instance. Parking brake: disabled while Jarvis is under development.
const live = createJarvisWake({ enabled: false });
let subscribed = false;

export function setWakeEnabled(value) { live.setWakeEnabled(value); }

export function onWorkerDone(sessionId) { live.onWorkerDone(sessionId); }

export function initJarvisWakeListener() {
  if (subscribed) return;
  subscribed = true;
  globalAiManager.onEvent((sessionId, event) => {
    if (event === "turn_complete") onWorkerDone(sessionId);
  });
}
