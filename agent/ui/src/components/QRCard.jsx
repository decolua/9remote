import { useState, useEffect, useRef } from "preact/hooks";
import QRCode from "qrcode";
import ConfirmPopup from "./ConfirmPopup";

const ENDPOINT = "9remote.cc";

function formatCountdown(ms) {
  if (ms <= 0) return "Expired";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function IconBtn({ icon, onClick, title, danger }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="glass-btn w-7 h-7 flex items-center justify-center flex-shrink-0 text-white/50 hover:text-white"
      style={danger ? { color: "rgba(255,100,100,0.7)" } : {}}
    >
      <span className="material-symbols-outlined" style={{ fontSize: 15 }}>{icon}</span>
    </button>
  );
}

export default function QRCard({ qrUrl, oneTimeKey, oneTimeKeyExpiresAt, permanentKey, onGenerateOneTimeKey, onRegenerateKey }) {
  const canvasRef = useRef(null);
  const [countdown, setCountdown] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null); // "oneTime" | "permanent"
  const [popup, setPopup] = useState(null); // "oneTime" | "regen" | null

  useEffect(() => {
    if (!qrUrl || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, qrUrl, {
      width: 160,
      margin: 1,
      color: { dark: "#0f1923", light: "#ffffff" },
    }).catch(() => {});
  }, [qrUrl]);

  useEffect(() => {
    if (!oneTimeKeyExpiresAt) { setCountdown(null); return; }
    const tick = () => setCountdown(oneTimeKeyExpiresAt - Date.now());
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [oneTimeKeyExpiresAt]);

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
          onConfirm={() => { setPopup(null); onGenerateOneTimeKey?.(); }}
          onCancel={() => setPopup(null)}
        />
      )}
      {popup === "regen" && (
        <ConfirmPopup
          message="Regenerate permanent key? All existing sessions will be disconnected."
          confirmLabel="Regenerate"
          confirmDanger
          onConfirm={() => { setPopup(null); onRegenerateKey?.(); }}
          onCancel={() => setPopup(null)}
        />
      )}

      <div className="glass-card p-5 flex flex-col items-center gap-4">

        {/* QR */}
        <div className="w-44 h-44 rounded-xl overflow-hidden bg-white p-2 flex items-center justify-center flex-shrink-0">
          {qrUrl ? (
            <canvas ref={canvasRef} />
          ) : (
            <span className="material-symbols-outlined text-gray-300 text-6xl">qr_code_2</span>
          )}
        </div>

        {/* Endpoint row */}
        <a
          href={`https://${ENDPOINT}/login`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
          <span className="text-xs text-white/60 font-medium">{ENDPOINT}/login</span>
        </a>

        <div className="w-full h-px bg-white/5" />

        {/* One-Time Key row */}
        <div className="w-full flex flex-col gap-1.5">
          <div className="flex items-center justify-between px-0.5">
            <span className="text-xs font-medium text-white/50">One-Time Key</span>
            <span className="text-xs text-white/30">Single use · expires</span>
          </div>
        <div className="w-full flex items-center gap-2 dark-card px-3 py-2.5">
          <span className="material-symbols-outlined text-white/30 flex-shrink-0" style={{ fontSize: 16 }}>timer</span>
          <span
            className="flex-1 font-mono font-bold tracking-[0.18em] text-base truncate"
            style={{ color: oneTimeKey ? "var(--brand-500)" : "rgba(255,255,255,0.15)" }}
          >
            {oneTimeKey || "• • • • • •"}
          </span>
          {countdown !== null && (
            <span className={`text-xs font-mono flex-shrink-0 ${countdown <= 0 ? "text-red-400" : "text-white/40"}`}>
              {formatCountdown(countdown)}
            </span>
          )}
          {oneTimeKey && (
            <IconBtn
              icon={copiedKey === "oneTime" ? "check" : "content_copy"}
              onClick={() => copy(oneTimeKey, "oneTime")}
              title="Copy one-time key"
            />
          )}
          <IconBtn icon="refresh" onClick={() => setPopup("oneTime")} title="New one-time key" />
        </div>
        </div>

        {/* Permanent Key row */}
        <div className="w-full flex flex-col gap-1.5">
          <div className="flex items-center justify-between px-0.5">
            <span className="text-xs font-medium text-white/50">Permanent Key</span>
            <span className="text-xs text-white/30">Reusable · no expiry</span>
          </div>
        <div className="w-full flex items-center gap-2 dark-card px-3 py-2.5">
          <span className="material-symbols-outlined text-white/30 flex-shrink-0" style={{ fontSize: 16 }}>key</span>
          <span className="flex-1 font-mono text-xs text-white/50 truncate">
            {permanentKey || "— not set —"}
          </span>
          {permanentKey && (
            <IconBtn
              icon={copiedKey === "permanent" ? "check" : "content_copy"}
              onClick={() => copy(permanentKey, "permanent")}
              title="Copy permanent key"
            />
          )}
          <IconBtn icon="autorenew" onClick={() => setPopup("regen")} title="Regenerate permanent key" danger />
        </div>
        </div>

      </div>
    </>
  );
}
