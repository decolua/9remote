"use client";

import { useState, useEffect, useRef } from "react";
import Spinner from "./Spinner";
import { useI18n } from "@/shared/i18n";
import { BEHAVIOR } from "@/shared/constants/features";

const { installingAt, restartingAt, timeoutSec } = BEHAVIOR.update;

// Phase labels per mode. Restart skips "installing" (no npm install).
const UPDATE_LABELS = {
  starting: "menu.updateStarting",
  installing: "menu.updateInstalling",
  restarting: "menu.updateRestarting",
  done: "menu.updateDone",
  timeout: "menu.updateTimeout",
};
const RESTART_LABELS = {
  starting: "menu.restartStarting",
  restarting: "menu.restartRestarting",
  done: "menu.restartDone",
  timeout: "menu.restartTimeout",
};

// Update progress overlay. Web only observes socket connect/disconnect (the update runs
// in a detached script), so phases are time-estimated. Agent restart = connected true→false→true.
export default function UpdateModal({ open, connected, mode = "update" }) {
  const { t } = useI18n();
  const labels = mode === "restart" ? RESTART_LABELS : UPDATE_LABELS;
  const [seconds, setSeconds] = useState(0);
  const [timedOut, setTimedOut] = useState(false);
  const diedRef = useRef(false);

  useEffect(() => {
    if (!open) { setSeconds(0); setTimedOut(false); diedRef.current = false; return; }
    const startedAt = Date.now();
    const tick = setInterval(() => {
      const s = Math.floor((Date.now() - startedAt) / 1000);
      setSeconds(s);
      if (s >= timeoutSec) setTimedOut(true);
    }, 1000);
    return () => clearInterval(tick);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!connected) { diedRef.current = true; return; }
    if (diedRef.current) setTimeout(() => window.location.reload(), 600);
  }, [open, connected]);

  if (!open) return null;

  const reconnected = diedRef.current && connected;
  let phase;
  if (timedOut && !reconnected) phase = "timeout";
  else if (reconnected) phase = "done";
  else if (!connected) phase = "restarting";
  else if (mode === "restart") phase = seconds < restartingAt ? "starting" : "restarting";
  else if (seconds < installingAt) phase = "starting";
  else if (seconds < restartingAt) phase = "installing";
  else phase = "restarting";

  const label = t(labels[phase]);
  const timeoutHint = mode === "restart" ? t("menu.restartTimeoutHint") : t("menu.updateTimeoutHint");

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="card-elev p-6 max-w-sm w-full mx-4 text-center">
        {phase === "timeout" ? (
          <>
            <div className="w-14 h-14 mx-auto bg-yellow-500/20 rounded-full flex items-center justify-center text-2xl">⚠️</div>
            <h3 className="text-text text-lg font-semibold mt-4">{label}</h3>
            <p className="text-text-muted text-sm mt-2">{timeoutHint}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-4 w-full py-2 bg-brand-500 hover:bg-brand-600 text-white font-medium rounded-brand transition-colors"
              type="button"
            >
              {t("menu.reloadWeb")}
            </button>
          </>
        ) : (
          <>
            <Spinner size="lg" />
            <h3 className="text-text text-base font-semibold mt-4">
              {label} <span className="text-text-muted font-normal">· {seconds}s</span>
            </h3>
            {/* Time-estimated progress (update runs detached → no real %) */}
            <div className="mt-4 h-1.5 w-full bg-white/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-500 rounded-full transition-all duration-1000 ease-linear"
                style={{ width: `${phase === "done" ? 100 : Math.min((seconds / timeoutSec) * 100, 95)}%` }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
