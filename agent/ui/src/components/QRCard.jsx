import { useState, useEffect, useRef } from "preact/hooks";
import QRCode from "qrcode";

export default function QRCard({ qrUrl, oneTimeKey, tunnelUrl }) {
  const canvasRef = useRef(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!qrUrl || !canvasRef.current) return;
    QRCode.toCanvas(canvasRef.current, qrUrl, {
      width: 128,
      margin: 1,
      color: { dark: "#0f1923", light: "#ffffff" },
    }).catch(() => {});
  }, [qrUrl]);

  const handleCopy = () => {
    navigator.clipboard.writeText(tunnelUrl).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="glass-card p-5 flex flex-col items-center gap-4">
      {/* QR code */}
      <div className="w-36 h-36 rounded-xl overflow-hidden bg-white p-2 flex items-center justify-center">
        {qrUrl ? (
          <canvas ref={canvasRef} />
        ) : (
          <span className="material-symbols-outlined text-gray-400 text-5xl">qr_code_2</span>
        )}
      </div>

      {/* title */}
      <div className="text-center">
        <p className="text-sm font-semibold text-white">QR Connection Code</p>
        <p className="text-xs text-white/40 mt-0.5">Scan to connect from your mobile device</p>
      </div>

      {/* one-time key */}
      <div className="w-full glass-card p-3 text-center">
        <p className="text-xs text-white/40 mb-1">One-Time Key</p>
        {oneTimeKey ? (
          <p className="font-mono text-lg font-bold tracking-widest" style={{ color: "var(--brand-500)" }}>{oneTimeKey}</p>
        ) : (
          <p className="font-mono text-lg font-bold text-white/20 tracking-widest">• • • • • • • •</p>
        )}
      </div>

      {/* connection url */}
      {tunnelUrl && (
        <div className="w-full flex items-center gap-2">
          <div className="flex-1 glass-card px-3 py-2 min-w-0">
            <p className="text-xs text-white/50 truncate">{tunnelUrl}</p>
          </div>
          <button
            onClick={handleCopy}
            className="glass-btn px-3 py-2 flex items-center gap-1 text-xs text-white/70 hover:text-white shrink-0"
          >
            <span className="material-symbols-outlined text-sm">
              {copied ? "check" : "content_copy"}
            </span>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}
    </div>
  );
}
