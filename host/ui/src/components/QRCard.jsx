import { useState, useEffect, useRef } from "preact/hooks";
import QRCode from "qrcode";
import ConfirmPopup from "./ConfirmPopup";
import { useI18n } from "../i18n";

const ENDPOINT = "9remote.cc";
// Release a stuck spinner if the request fails (the value never changes then).
const BUSY_TIMEOUT_MS = 15000;

function formatCountdown(ms) {
  if (ms <= 0) return "Expired";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function IconBtn({ icon, onClick, title, danger, busy }) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={busy}
      className="glass-btn w-7 h-7 flex items-center justify-center flex-shrink-0"
      style={{
        ...(danger ? { color: "rgba(255,100,100,0.7)" } : { color: "var(--text-muted)" }),
        ...(busy ? { opacity: 0.6, cursor: "default" } : null)
      }}
    >
      <span
        className={`material-symbols-outlined${busy ? " qr-spin" : ""}`}
        style={{ fontSize: 15 }}
      >
        {icon}
      </span>
    </button>
  );
}

export default function QRCard({ qrUrl, oneTimeKey, oneTimeKeyExpiresAt, permanentKey, onGenerateOneTimeKey, onRegenerateKey }) {
  const { t } = useI18n();
  const canvasRef = useRef(null);
  const [countdown, setCountdown] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null); // "oneTime" | "permanent"
  const [popup, setPopup] = useState(null); // "oneTime" | "regen" | "stop" | null
  // Which generate button is mid-flight. Cleared when the new value arrives via
  // the state stream (below), so the spinner tracks the real work, not a timer.
  const [busy, setBusy] = useState(null); // "oneTime" | "permanent" | null

  // An expired key is useless — hide it (and its QR) instead of showing a dead value.
  const expired = countdown !== null && countdown <= 0;

  useEffect(() => {
    if (!qrUrl || expired || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, qrUrl, {
      width: 200,
      margin: 1,
      color: { dark: "#0f1923", light: "#ffffff" },
    }).catch(() => {});
  }, [qrUrl, expired]);

  useEffect(() => {
    if (!oneTimeKeyExpiresAt) { setCountdown(null); return; }
    const tick = () => setCountdown(oneTimeKeyExpiresAt - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [oneTimeKeyExpiresAt]);

  // Stop each spinner as soon as ITS value actually arrives — the two buttons
  // are independent, so a regenerate must not clear a one-time key spinner.
  // Keyed on the value itself: the effect re-runs only when it changes.
  useEffect(() => {
    setBusy((b) => (b === "oneTime" ? null : b));
  }, [oneTimeKey]);

  useEffect(() => {
    setBusy((b) => (b === "permanent" ? null : b));
  }, [permanentKey]);

  // Failsafe: a failed request never changes the value, so release the spinner
  // instead of leaving the button disabled forever.
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

  return (
    <>
      {popup === "oneTime" && (
        <ConfirmPopup
          message="Generate a new one-time key? The current one will expire immediately."
          confirmLabel="Generate"
          onConfirm={() => { setPopup(null); setBusy("oneTime"); onGenerateOneTimeKey?.(); }}
          onCancel={() => setPopup(null)}
        />
      )}
      {popup === "regen" && (
        <ConfirmPopup
          message="Regenerate permanent key? All existing sessions will be disconnected."
          confirmLabel="Regenerate"
          confirmDanger
          onConfirm={() => { setPopup(null); setBusy("permanent"); onRegenerateKey?.(); }}
          onCancel={() => setPopup(null)}
        />
      )}
      <div className="relative z-[1] w-full max-w-[380px] flex flex-col items-center">

        {/* QR — white plate with deep drop shadow (the pane's light source) */}
        <div
          className="bg-white p-3.5 rounded-[14px] flex items-center justify-center flex-shrink-0"
          style={{ boxShadow: "var(--qr-plate-shadow)" }}
        >
          {qrUrl && !expired ? (
            <canvas ref={canvasRef} />
          ) : (
            <div className="w-[200px] h-[200px] grid place-items-center">
              <span className="material-symbols-outlined" style={{ fontSize: 72, color: "#d4d4d8" }}>qr_code_2</span>
            </div>
          )}
        </div>

        {/* Endpoint */}
        <div className="flex flex-col items-center gap-1 mt-4 mb-9">
          <span className="text-[11.5px] leading-4" style={{ color: "var(--text-muted)" }}>{t("connection.scanToSignIn")}</span>
          <a
            href={`https://${ENDPOINT}/login`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 hover:underline transition-opacity"
          >
            <span className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
            <span className="text-sm font-bold" style={{ color: "var(--brand-400)" }}>{ENDPOINT}/login</span>
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 14, color: "var(--brand-400)" }}>open_in_new</span>
          </a>
        </div>

        {/* One-Time Key */}
        <div className="w-full flex flex-col gap-1.5">
          <span className="text-xs font-medium px-0.5" style={{ color: "var(--text-muted)" }}>{t("connection.oneTimeKey")}</span>
          <div
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-[10px]"
            style={{ background: "var(--row-bg)", border: "1px solid var(--border-subtle)" }}
          >
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 16, color: "var(--text-muted)" }}>timer</span>
            <span
              className="flex-1 font-mono font-bold tracking-[0.18em] text-base truncate"
              style={{ color: oneTimeKey && !expired ? "var(--brand-400)" : "var(--border)" }}
            >
              {oneTimeKey && !expired ? oneTimeKey : "• • • • • •"}
            </span>
            {countdown !== null && (
              <span className={`text-xs font-mono flex-shrink-0 ${countdown <= 0 ? "text-red-400" : ""}`} style={countdown > 0 ? { color: "var(--text-muted)" } : {}}>
                {formatCountdown(countdown)}
              </span>
            )}
            {oneTimeKey && !expired && (
              <IconBtn
                icon={copiedKey === "oneTime" ? "check" : "content_copy"}
                onClick={() => copy(oneTimeKey, "oneTime")}
                title="Copy one-time key"
              />
            )}
            <IconBtn icon="refresh" onClick={() => setPopup("oneTime")} title="New one-time key" busy={busy === "oneTime"} />
          </div>
        </div>

        {/* Permanent Key */}
        <div className="w-full flex flex-col gap-1.5 mt-2">
          <span className="text-xs font-medium px-0.5" style={{ color: "var(--text-muted)" }}>{t("connection.permanentKey")}</span>
          <div
            className="w-full flex items-center gap-2 px-3 py-2.5 rounded-[10px]"
            style={{ background: "var(--row-bg)", border: "1px solid var(--border-subtle)" }}
          >
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 16, color: "var(--text-muted)" }}>key</span>
            <span className="flex-1 font-mono text-xs truncate" style={{ color: "var(--text-main)" }}>
              {permanentKey || "— not set —"}
            </span>
            {permanentKey && (
              <IconBtn
                icon={copiedKey === "permanent" ? "check" : "content_copy"}
                onClick={() => copy(permanentKey, "permanent")}
                title="Copy permanent key"
              />
            )}
            <IconBtn icon="autorenew" onClick={() => setPopup("regen")} title="Regenerate permanent key" danger busy={busy === "permanent"} />
          </div>
        </div>

      </div>
    </>
  );
}
