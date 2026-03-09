import React, { useState, useRef, useEffect } from "react"
import StepProgress from "../components/StepProgress"
import QRCard from "../components/QRCard"

const STEPS = ["Starting", "Tunneling", "Authenticating", "Ready"]
const HELP_URL = "https://9remote.cc/help"

const PERMISSION_LABELS = {
  screenRecording: "Screen Recording",
  accessibility: "Accessibility",
}

function StatCard({ icon, label, value, accent }) {
  return (
    <div className="glass-card px-3 py-2.5 flex flex-col items-center gap-1 flex-1">
      <span className={`material-symbols-outlined text-base ${accent || "text-white/40"}`}>{icon}</span>
      <p className="text-xs text-white/40">{label}</p>
      <p className="text-sm font-semibold text-white">{value || "—"}</p>
    </div>
  )
}

function PermissionBanner({ permissions, onRequestPermission }) {
  const missing = Object.entries(permissions || {}).filter(([, granted]) => !granted)
  if (missing.length === 0) return null

  return (
    <div className="px-5 py-2 flex gap-2 bg-amber-500/10 border-b border-amber-500/20">
      {missing.map(([type]) => (
        <div key={type} className="flex items-center gap-2 flex-1 min-w-0">
          <span className="material-symbols-outlined text-amber-400 text-sm flex-shrink-0">warning</span>
          <span className="text-xs text-amber-300 truncate">{PERMISSION_LABELS[type]}</span>
          <button
            onClick={() => onRequestPermission(type)}
            className="ml-auto flex-shrink-0 text-xs px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30"
          >
            Grant
          </button>
        </div>
      ))}
    </div>
  )
}

function SettingsModal({ onClose }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="glass-card w-64 p-5 flex flex-col items-center gap-3"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="material-symbols-outlined text-white/40 text-3xl">settings</span>
        <p className="text-sm text-white font-medium">Settings</p>
        <p className="text-xs text-white/40 text-center">Coming soon</p>
        <button
          onClick={onClose}
          className="glass-btn px-4 py-1.5 text-xs text-white/70 hover:text-white mt-1"
        >
          Close
        </button>
      </div>
    </div>
  )
}

export default function MainScreen({
  step,
  tunnelUrl,
  oneTimeKey,
  qrUrl,
  latency,
  uptime,
  permissions,
  onRequestPermission,
  onRefresh,
  onStop,
  logs = [],
}) {
  const [activeTab, setActiveTab] = useState("connect")
  const [showSettings, setShowSettings] = useState(false)
  const logEndRef = useRef(null)

  useEffect(() => {
    if (activeTab === "log") logEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [logs, activeTab])

  const handleCopy = (text) => {
    try {
      navigator.clipboard.writeText(text)
    } catch {
      /* noop */
    }
  }

  const tunnelStatus = step === 3 ? "Online" : step >= 1 ? "Connecting" : "Offline"
  const tunnelAccent = step === 3 ? "text-green-400" : step >= 1 ? "text-amber-400" : "text-white/40"

  return (
    <div className="h-full flex flex-col bg-[#0f1923] relative">
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
          <button
            onClick={() => window.open(HELP_URL, "_blank")}
            className="glass-btn w-7 h-7 flex items-center justify-center text-white/40 hover:text-white"
          >
            <span className="material-symbols-outlined text-sm">help_outline</span>
          </button>
          <button
            onClick={() => setShowSettings(true)}
            className="glass-btn w-7 h-7 flex items-center justify-center text-white/40 hover:text-white"
          >
            <span className="material-symbols-outlined text-sm">settings</span>
          </button>
        </div>
      </div>

      {/* permission banner */}
      <PermissionBanner permissions={permissions} onRequestPermission={onRequestPermission} />

      {/* tabs */}
      <div className="flex px-5 pt-3 gap-3 border-b border-white/5">
        {[
          { id: "connect", label: "Connection" },
          { id: "log", label: "Logs" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`pb-2 text-xs font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-blue-400 text-blue-400"
                : "border-transparent text-white/40 hover:text-white/70"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* content */}
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
        {activeTab === "connect" ? (
          <>
            <StepProgress currentStep={step} steps={STEPS} />
            <QRCard qrUrl={qrUrl} oneTimeKey={oneTimeKey} tunnelUrl={tunnelUrl} onCopy={handleCopy} />
            <div className="flex gap-2">
              <StatCard icon="wifi" label="Tunnel" value={tunnelStatus} accent={tunnelAccent} />
              <StatCard icon="network_ping" label="Latency" value={latency ? `${latency}ms` : null} accent="text-blue-400" />
              <StatCard icon="timer" label="Uptime" value={uptime} accent="text-purple-400" />
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col">
            {logs.length === 0 ? (
              <p className="text-xs text-white/30 text-center mt-8">No logs yet</p>
            ) : (
              <div className="flex flex-col gap-0.5">
                {logs.map((line, i) => (
                  <p key={i} className="text-xs font-mono text-white/50 leading-5 break-all">
                    {line}
                  </p>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* footer */}
      <div className="px-5 pb-5 flex gap-2 border-t border-white/5 pt-4">
        <button
          onClick={onRefresh}
          className="glass-btn flex-1 py-2.5 flex items-center justify-center gap-1.5 text-sm font-medium text-white/70 hover:text-white"
        >
          <span className="material-symbols-outlined text-base">refresh</span>
          Refresh
        </button>
        <button
          onClick={onStop}
          className="btn-danger flex-1 py-2.5 flex items-center justify-center gap-1.5 text-sm font-medium"
        >
          <span className="material-symbols-outlined text-base">stop_circle</span>
          Disconnect
        </button>
      </div>

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
    </div>
  )
}
