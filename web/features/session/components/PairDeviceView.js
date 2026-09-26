"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronLeft, Copy, KeyRound, QrCode, RefreshCw } from "@/shared/components/ui/Icon";
import ConfirmDialog from "@/shared/components/ui/ConfirmDialog";
import { useI18n } from "@/shared/i18n";
import { vibrate } from "@/shared/utils/vibration";
import { isAgentEnvironment } from "@/shared/utils/localOrigin";
import { HOMEPAGE_URL } from "@/shared/constants/API";

// Web port of agent/ui QRCard — served by the agent itself, so the localhost-only
// key APIs are same-origin here. The whole view hides outside that context.
const LOGIN_URL = `${HOMEPAGE_URL}login`;
// Release a stuck spinner if the request fails (the value never changes then).
const BUSY_TIMEOUT_MS = 15000;
// Agent server step that means "actually serving" — mirrors agent/ui App.jsx.
const STEP_READY = 5;

function formatCountdown(ms) {
  if (ms <= 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function FieldBtn({ icon, onClick, title, danger, busy }) {
  const Icon = icon;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={busy}
      className={`p-1.5 rounded-brand transition-colors shrink-0
        ${danger ? "text-danger/70 hover:text-danger" : "text-text-muted hover:text-text"}
        hover:bg-surface-3 ${busy ? "opacity-60 cursor-default" : ""}`}
    >
      <Icon size={14} className={busy ? "animate-spin" : ""} />
    </button>
  );
}

export default function PairDeviceView({ onClose }) {
  const { t } = useI18n();
  const canvasRef = useRef(null);
  const [pair, setPair] = useState({ qrUrl: "", oneTimeKey: "", oneTimeKeyExpiresAt: null, permanentKey: "", step: 0, pairingUsed: false });
  const [reachable, setReachable] = useState(true);
  const [copiedKey, setCopiedKey] = useState(null); // "oneTime" | "permanent"
  const [confirm, setConfirm] = useState(null); // "oneTime" | "regen" | null
  // Which action is mid-flight; cleared when the new value arrives via the state stream.
  const [busy, setBusy] = useState(null);

  const { qrUrl, oneTimeKey, oneTimeKeyExpiresAt, permanentKey, step, pairingUsed } = pair;

  // Countdown is derived from a ticking clock, so a cleared expiry needs no reset effect.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!oneTimeKeyExpiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [oneTimeKeyExpiresAt]);
  const countdown = oneTimeKeyExpiresAt != null ? oneTimeKeyExpiresAt - now : null;
  // An expired key is useless — hide it (and its QR) instead of showing a dead value.
  const expired = countdown !== null && countdown <= 0;

  // Initial state + live updates from the agent's local SSE stream.
  useEffect(() => {
    // No key APIs on this origin — skip the doomed connections entirely.
    if (!isAgentEnvironment()) return;
    let alive = true;
    fetch("/api/ui/state", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!alive || !data) return;
        setReachable(true);
        setPair({
          qrUrl: data.qrUrl ?? "",
          oneTimeKey: data.oneTimeKey ?? "",
          oneTimeKeyExpiresAt: data.oneTimeKeyExpiresAt ?? null,
          permanentKey: data.permanentKey ?? "",
          step: data.step ?? 0,
          pairingUsed: data.pairingUsed ?? false
        });
      })
      .catch(() => alive && setReachable(false));

    const es = new EventSource("/api/ui/events");
    es.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      setReachable(true);
      if (data.type !== "state") return;
      setPair({
        qrUrl: data.qrUrl ?? "",
        oneTimeKey: data.oneTimeKey ?? "",
        oneTimeKeyExpiresAt: data.oneTimeKeyExpiresAt ?? null,
        permanentKey: data.permanentKey ?? "",
        step: data.step ?? 0,
        pairingUsed: data.pairingUsed ?? false
      });
    };
    es.onerror = () => setReachable(false);
    return () => { alive = false; es.close(); };
  }, []);

  // Same auto-mint as the agent dashboard: with a permanent key, no live code and
  // no pairing in flight, mint one so the QR is usable the moment the tab opens.
  // Once per mount — after that the user mints explicitly (a paired code must not
  // silently reopen a pairing window).
  const autoMinted = useRef(false);
  useEffect(() => {
    if (autoMinted.current) return;
    if (!permanentKey || oneTimeKey || qrUrl || pairingUsed) return;
    if (step !== STEP_READY) return; // server must actually be serving
    autoMinted.current = true;
    fetch("/api/key/one-time", { method: "POST" }).catch(() => {});
  }, [permanentKey, oneTimeKey, qrUrl, pairingUsed, step]);

  // Dynamic import keeps the QR renderer out of the public web bundle.
  useEffect(() => {
    if (!qrUrl || expired || !canvasRef.current) return;
    let cancelled = false;
    import("qrcode")
      .then(({ default: QRCode }) => !cancelled && QRCode.toCanvas(canvasRef.current, qrUrl, {
        width: 200,
        margin: 1,
        color: { dark: "#0f1723", light: "#ffffff" }
      }))
      .catch(() => {});
    return () => { cancelled = true; };
  }, [qrUrl, expired]);

  // Stop each spinner as soon as ITS value actually arrives (independent buttons) —
  // adjusted during render, the React-endorsed pattern for syncing to a prop change.
  const [prevOneTime, setPrevOneTime] = useState(oneTimeKey);
  const [prevPermanent, setPrevPermanent] = useState(permanentKey);
  if (prevOneTime !== oneTimeKey) {
    setPrevOneTime(oneTimeKey);
    setBusy((b) => (b === "oneTime" ? null : b));
  }
  if (prevPermanent !== permanentKey) {
    setPrevPermanent(permanentKey);
    setBusy((b) => (b === "permanent" ? null : b));
  }

  // Failsafe: a failed request never changes the value, so release the spinner.
  useEffect(() => {
    if (!busy) return;
    const id = setTimeout(() => setBusy(null), BUSY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [busy]);

  const copy = (text, which) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedKey(which);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const act = (path, which) => {
    setBusy(which);
    fetch(path, { method: "POST" }).catch(() => setBusy(null));
  };

  // Public web (or any non-agent origin) has no key APIs — the tab is agent-only.
  if (!isAgentEnvironment()) {
    return (
      <div className="h-full bg-bg flex flex-col">
        <div className="bg-surface px-4 py-3 flex items-center gap-3 flex-shrink-0 border-b border-border-subtle">
          <button
            onClick={() => { vibrate(); onClose(); }}
            className="p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
          >
            <ChevronLeft size={20} />
          </button>
          <h1 className="text-text text-lg font-semibold">{t("connection.pairTab")}</h1>
        </div>
        <div className="flex-1 grid place-items-center p-6">
          <p className="text-sm text-text-muted text-center">{t("connection.pairUnavailable")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full bg-bg flex flex-col">
      <div className="bg-surface px-4 py-3 flex items-center gap-3 flex-shrink-0 border-b border-border-subtle">
        <button
          onClick={() => { vibrate(); onClose(); }}
          className="p-2 bg-surface-2 hover:bg-surface-3 text-text rounded-brand transition-all duration-150 ease-out active:scale-[0.96]"
        >
          <ChevronLeft size={20} />
        </button>
        <h1 className="text-text text-lg font-semibold">{t("connection.pairTab")}</h1>
        <span className={`w-2 h-2 rounded-full ml-auto flex-shrink-0 ${reachable ? "bg-green-500" : "bg-red-500 animate-pulse"}`} />
      </div>

      <div className="flex-1 overflow-auto modal-scrollable flex flex-col items-center p-6">
        <div className="w-full max-w-[380px] flex flex-col items-center">

          {/* QR — white plate, same look as the agent dashboard */}
          <div className="bg-white p-3.5 rounded-[14px] shadow-lg flex items-center justify-center flex-shrink-0">
            {qrUrl && !expired ? (
              <canvas ref={canvasRef} />
            ) : (
              <div className="w-[200px] h-[200px] grid place-items-center">
                <QrCode size={72} className="text-zinc-300" />
              </div>
            )}
          </div>

          {/* Endpoint */}
          <div className="flex flex-col items-center gap-1 mt-4 mb-9">
            <span className="text-[11.5px] leading-4 text-text-muted">{t("connection.pairScanToSignIn")}</span>
            <a href={LOGIN_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:underline">
              <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
              <span className="text-sm font-bold text-brand-500">{LOGIN_URL.replace(/^https?:\/\//, "")}</span>
            </a>
          </div>

          {/* One-Time Key */}
          <div className="w-full flex flex-col gap-1.5">
            <span className="text-xs font-medium px-0.5 text-text-muted">{t("connection.pairOneTimeKey")}</span>
            <div className="w-full flex items-center gap-2 px-3 py-2.5 rounded-[10px] bg-surface-2 border border-border-subtle">
              <span
                className={`flex-1 font-mono font-bold tracking-[0.18em] text-base truncate
                  ${oneTimeKey && !expired ? "text-brand-500" : "text-border"}`}
              >
                {oneTimeKey && !expired ? oneTimeKey : "• • • • • •"}
              </span>
              {countdown !== null && (
                <span className={`text-xs font-mono flex-shrink-0 ${expired ? "text-danger" : "text-text-muted"}`}>
                  {expired ? t("connection.pairExpired") : formatCountdown(countdown)}
                </span>
              )}
              {oneTimeKey && !expired && (
                <FieldBtn
                  icon={copiedKey === "oneTime" ? Check : Copy}
                  onClick={() => copy(oneTimeKey, "oneTime")}
                  title={t("common.copy")}
                />
              )}
              <FieldBtn icon={RefreshCw} onClick={() => setConfirm("oneTime")} title={t("common.refresh")} busy={busy === "oneTime"} />
            </div>
          </div>

          {/* Permanent Key */}
          <div className="w-full flex flex-col gap-1.5 mt-2">
            <span className="text-xs font-medium px-0.5 text-text-muted">{t("connection.pairPermanentKey")}</span>
            <div className="w-full flex items-center gap-2 px-3 py-2.5 rounded-[10px] bg-surface-2 border border-border-subtle">
              <KeyRound size={16} className="text-text-muted shrink-0" />
              <span className="flex-1 font-mono text-xs truncate text-text">
                {permanentKey || t("connection.pairKeyNotSet")}
              </span>
              {permanentKey && (
                <FieldBtn
                  icon={copiedKey === "permanent" ? Check : Copy}
                  onClick={() => copy(permanentKey, "permanent")}
                  title={t("common.copy")}
                />
              )}
              <FieldBtn icon={RefreshCw} onClick={() => setConfirm("regen")} title={t("common.refresh")} danger busy={busy === "permanent"} />
            </div>
          </div>

        </div>
      </div>

      <ConfirmDialog
        isOpen={confirm === "oneTime"}
        onClose={() => setConfirm(null)}
        onConfirm={() => { setConfirm(null); act("/api/key/one-time", "oneTime"); }}
        title={t("connection.pairGenOneTimeTitle")}
        message={t("connection.pairGenOneTimeMsg")}
      />
      <ConfirmDialog
        isOpen={confirm === "regen"}
        onClose={() => setConfirm(null)}
        onConfirm={() => { setConfirm(null); act("/api/key/regenerate", "permanent"); }}
        title={t("connection.pairRegenTitle")}
        message={t("connection.pairRegenMsg")}
      />
    </div>
  );
}
