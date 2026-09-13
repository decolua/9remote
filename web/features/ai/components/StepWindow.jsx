"use client";

import { useState } from "react";
import { hiddenCount, revealStep, collapseStep } from "../lib/turnRows";

// How many steps of a run stay visible before the rest go behind "N more", and how many
// one press of the bar adds or takes back.
export const WINDOW_STEPS = 3;
export const CHUNK = 12;

/**
 * The "N more steps" bar — one control, two states.
 *
 * A long run of steps shows its tail. The line above it is itself the button: pressed
 * while steps are hidden it pages a chunk in, and once anything has been paged in the
 * same line reads "show less" and gives that chunk back. A separate button beside it
 * would be a second thing to aim at for an action the line already names.
 *
 * Renders the bar row only; the caller paints `children` for the count it gets back, so
 * this cannot drift from the list it is describing.
 */
export function StepWindow({ total, windowSize = WINDOW_STEPS, children }) {
  const [revealed, setRevealed] = useState(0);
  const hidden = hiddenCount(total, windowSize, revealed);
  const shown = total - hidden;

  const less = () => setRevealed((r) => r - collapseStep(r, CHUNK));

  return (
    <>
      {revealed > 0 ? (
        <button
          type="button"
          onClick={less}
          className="py-0.5 text-left font-mono text-[10.5px] text-text-subtle hover:text-text"
        >
          ▼ show less
        </button>
      ) : hidden > 0 ? (
        <button
          type="button"
          onClick={() => setRevealed((r) => r + revealStep(hidden, CHUNK))}
          className="py-0.5 text-left font-mono text-[10.5px] text-text-subtle hover:text-text"
        >
          ▲ {hidden} more {hidden === 1 ? "step" : "steps"}
        </button>
      ) : null}
      {children(hidden)}
    </>
  );
}

export default StepWindow;
