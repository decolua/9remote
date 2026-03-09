import React from "react"
import StepProgress from "../components/StepProgress"
import QRCard from "../components/QRCard"

const STEPS = ["Khởi động", "Tunneling", "Xác thực", "Sẵn sàng"]

function StatCard({ icon, label, value, accent }) {
  return (
    <div className="glass-card px-3 py-2.5 flex flex-col items-center gap-1 flex-1">
      <span className={`material-symbols-outlined text-base ${accent || "text-white/40"}`}>{icon}</span>
      <p className="text-xs text-white/40">{label}</p>
      <p className="text-sm font-semibold text-white">{value || "—"}</p>
    </div>
  )
}

export default function MainScreen({ step, tunnelUrl, oneTimeKey, qrUrl, latency, uptime, onRefresh, onStop }) {
  const handleCopy = (text) => {
    try {
      navigator.clipboard.writeText(text)
    } catch {
      /* noop */
    }
  }

  const tunnelStatus = step === 3 ? "Online" : step >= 1 ? "Đang kết nối" : "Offline"
  const tunnelAccent = step === 3 ? "text-green-400" : step >= 1 ? "text-amber-400" : "text-white/40"

  return (
    <div className="h-full flex flex-col bg-[#0f1923]">
      {/* header */}
      <div
        className="flex items-center justify-between px-5 py-4 border-b border-white/5"
        data-tauri-drag-region
      >
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-blue-500 flex items-center justify-center">
            <span className="material-symbols-outlined text-white text-base">terminal</span>
          </div>
          <span className="font-semibold text-sm text-white">9Remote</span>
        </div>
        <div className="flex items-center gap-2">
          <button className="glass-btn w-7 h-7 flex items-center justify-center text-white/40 hover:text-white">
            <span className="material-symbols-outlined text-sm">help_outline</span>
          </button>
          <button className="glass-btn w-7 h-7 flex items-center justify-center text-white/40 hover:text-white">
            <span className="material-symbols-outlined text-sm">settings</span>
          </button>
        </div>
      </div>

      {/* content */}
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
        <StepProgress currentStep={step} steps={STEPS} />

        <QRCard
          qrUrl={qrUrl}
          oneTimeKey={oneTimeKey}
          tunnelUrl={tunnelUrl}
          onCopy={handleCopy}
        />

        {/* stats */}
        <div className="flex gap-2">
          <StatCard icon="wifi" label="Tunnel" value={tunnelStatus} accent={tunnelAccent} />
          <StatCard icon="network_ping" label="Độ trễ" value={latency ? `${latency}ms` : null} accent="text-blue-400" />
          <StatCard icon="timer" label="Uptime" value={uptime} accent="text-purple-400" />
        </div>
      </div>

      {/* footer */}
      <div className="px-5 pb-5 flex gap-2 border-t border-white/5 pt-4">
        <button
          onClick={onRefresh}
          className="glass-btn flex-1 py-2.5 flex items-center justify-center gap-1.5 text-sm font-medium text-white/70 hover:text-white"
        >
          <span className="material-symbols-outlined text-base">refresh</span>
          Làm mới
        </button>
        <button
          onClick={onStop}
          className="btn-danger flex-1 py-2.5 flex items-center justify-center gap-1.5 text-sm font-medium"
        >
          <span className="material-symbols-outlined text-base">stop_circle</span>
          Dừng kết nối
        </button>
      </div>
    </div>
  )
}
