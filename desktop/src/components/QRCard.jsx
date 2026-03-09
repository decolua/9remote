import React, { useState } from "react"

export default function QRCard({ qrUrl, oneTimeKey, tunnelUrl, onCopy }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    onCopy(tunnelUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="glass-card p-5 flex flex-col items-center gap-4">
      {/* QR code */}
      <div className="w-36 h-36 rounded-xl overflow-hidden bg-white p-2 flex items-center justify-center">
        {qrUrl ? (
          <img src={qrUrl} alt="QR Code" className="w-full h-full object-contain" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="material-symbols-outlined text-gray-400 text-5xl">qr_code_2</span>
          </div>
        )}
      </div>

      {/* title */}
      <div className="text-center">
        <p className="text-sm font-semibold text-white">Mã QR Kết nối</p>
        <p className="text-xs text-white/40 mt-0.5">Quét để kết nối từ thiết bị di động</p>
      </div>

      {/* one-time key */}
      {oneTimeKey && (
        <div className="w-full glass-card p-3 text-center">
          <p className="text-xs text-white/40 mb-1">One-Time Key</p>
          <p className="font-mono text-lg font-bold text-blue-400 tracking-widest">{oneTimeKey}</p>
        </div>
      )}

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
            {copied ? "Đã sao" : "Sao chép"}
          </button>
        </div>
      )}
    </div>
  )
}
