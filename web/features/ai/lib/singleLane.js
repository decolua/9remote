// Single-lane scheduling for recovery work: one debounced door, one in-flight op,
// a coalesced pending intent. Triggers never stack rounds and never lose the last
// ask — a request landing mid-run is exactly one follow-up, never two, never zero.
//
// Pure scheduling: the caller owns the timers (schedule/clear are injectable) and
// supplies the runner; the runner MUST call done() exactly once (double settles are
// ignored, as are settles after a reset).

// An intent's right to the pending slot — a stronger ask subsumes a weaker one.
export const LANE_RANK = { recover: 0, gap: 1, hydrate: 2, now: 3 };

export const LANE_DEBOUNCE_MS = 150;

export function createSingleLane({
  run,
  rank = LANE_RANK,
  debounceMs = LANE_DEBOUNCE_MS,
  schedule = setTimeout,
  clear = clearTimeout
}) {
  let timerId = null;
  let timerIntent = null;
  let timerDelayMs = null;
  let inFlight = null;
  let pending = null; // { intent, immediate, delayMs }

  const prio = (intent) => rank[intent] ?? 0;

  const arm = (intent, delayMs) => {
    timerIntent = intent;
    timerDelayMs = delayMs;
    timerId = schedule(() => {
      timerId = null;
      const armed = timerIntent;
      timerIntent = null;
      fire(armed);
    }, delayMs ?? debounceMs);
  };

  const fire = (intent) => {
    inFlight = intent;
    let settled = false;
    run(intent, () => {
      if (settled || inFlight == null) return;
      settled = true;
      inFlight = null;
      if (!pending) return;
      const next = pending;
      pending = null;
      if (next.immediate) fire(next.intent);
      else arm(next.intent, next.delayMs);
    });
  };

  return {
    request(intent, { immediate = false, delayMs = null } = {}) {
      if (inFlight != null) {
        if (!pending || prio(intent) > prio(pending.intent)) pending = { intent, immediate, delayMs };
        else if (immediate) pending = { ...pending, immediate: true };
        return;
      }
      if (timerId != null) {
        // A stronger ask may take the slot, and a fresher ask may pull a long ladder rung
        // earlier — but nothing may ever lengthen the wait. Same time, stronger wins.
        const stronger = prio(intent) > prio(timerIntent);
        const newDelay = delayMs ?? debounceMs;
        const armedDelay = timerDelayMs ?? debounceMs;
        const reArm = stronger ? newDelay <= armedDelay : newDelay < armedDelay;
        if (reArm) {
          clear(timerId);
          timerId = null;
          arm(stronger ? intent : timerIntent, newDelay);
        }
        if (!immediate) return;
        clear(timerId);
        timerId = null;
        const armed = timerIntent;
        timerIntent = null;
        fire(armed);
        return;
      }
      if (immediate) { fire(intent); return; }
      arm(intent, delayMs);
    },

    busy() { return inFlight != null; },

    // Drop the armed ask and/or the pending follow-up. `kind` limits the sweep to one
    // intent (a hydrate ack must not cancel a gap fill that arrived meanwhile).
    clearPending(kind = null) {
      if (kind == null || timerIntent === kind) {
        if (timerId != null) clear(timerId);
        timerId = null;
        timerIntent = null;
        timerDelayMs = null;
      }
      if (kind == null || pending?.intent === kind) pending = null;
    },

    reset() {
      if (timerId != null) clear(timerId);
      timerId = null;
      timerIntent = null;
      timerDelayMs = null;
      pending = null;
      inFlight = null; // a late settle from the abandoned run reads as a no-op
    }
  };
}
