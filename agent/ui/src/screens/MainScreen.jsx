import { useState, useRef, useEffect } from "preact/hooks";
import StepProgress from "../components/StepProgress";
import QRCard from "../components/QRCard";

const STEPS = ["Starting", "Tunneling", "Authenticating", "Ready"];
const HELP_URL = "https://9remote.cc/help";

const PERMISSION_LABELS = {
  screenRecording: "Screen Recording",
  accessibility: "Accessibility",
};

function StatCard({ icon, label, value, accent }) {
  return (
    <div className="dark-card px-3 py-2.5 flex flex-col items-center gap-1 flex-1">
      <span className={`material-symbols-outlined text-base ${accent || "text-white/40"}`}>{icon}</span>
      <p className="text-xs text-white/40">{label}</p>
      <p className="text-sm font-semibold text-white">{value || "—"}</p>
    </div>
  );
}

function PermissionBanner({ permissions, onRequestPermission }) {
  const missing = Object.entries(permissions || {}).filter(([, granted]) => !granted);
  if (missing.length === 0) return null;

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
  );
}

function UpdateBanner({ version }) {
  if (!version) return null;
  const handleUpdate = () => {
    fetch("/api/update", { method: "POST" }).catch(() => {});
  };
  return (
    <div className="px-5 py-2 flex items-center gap-2 border-b" style={{ background: "rgba(255,87,10,0.08)", borderColor: "rgba(255,87,10,0.2)" }}>
      <span className="material-symbols-outlined text-sm flex-shrink-0" style={{ color: "var(--brand-400)" }}>system_update</span>
      <span className="text-xs flex-1" style={{ color: "var(--brand-400)" }}>Version {version} available</span>
      <button
        onClick={handleUpdate}
        className="flex-shrink-0 text-xs px-2 py-0.5 rounded font-medium"
        style={{ background: "rgba(255,87,10,0.15)", color: "var(--brand-400)" }}
      >
        Update
      </button>
    </div>
  );
}

export default function MainScreen({
  step, tunnelUrl, oneTimeKey, qrUrl,
  latency, uptime, permissions, updateVersion,
  onRequestPermission, onRefresh, onStop, logs = [],
}) {
  const [activeTab, setActiveTab] = useState("connect");
  const logEndRef = useRef(null);

  useEffect(() => {
    if (activeTab === "log") logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, activeTab]);

  const tunnelAccent = step === 3 ? "text-green-400" : step >= 1 ? "text-orange-400" : "text-white/40";

  return (
    <div className="h-full flex flex-col dot-grid-bg relative">
      {/* header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "var(--brand-500)" }}>
            <span className="material-symbols-outlined text-white text-base">terminal</span>
          </div>
          <span className="brand-text text-xs">9Remote</span>
        </div>
        <button
          onClick={() => window.open(HELP_URL, "_blank")}
          className="glass-btn w-7 h-7 flex items-center justify-center text-white/40 hover:text-white"
        >
          <span className="material-symbols-outlined text-sm">help_outline</span>
        </button>
      </div>

      {/* banners */}
      <UpdateBanner version={updateVersion} />
      <PermissionBanner permissions={permissions} onRequestPermission={onRequestPermission} />

      {/* tabs */}
      <div className="flex px-5 pt-3 gap-3 border-b border-white/5">
        {[{ id: "connect", label: "Connection" }, { id: "log", label: "Logs" }].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className="pb-2 text-xs font-medium border-b-2 transition-colors"
            style={activeTab === tab.id
              ? { borderColor: "var(--brand-500)", color: "var(--brand-500)" }
              : { borderColor: "transparent", color: "rgba(255,255,255,0.4)" }
            }
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
            <QRCard qrUrl={qrUrl} oneTimeKey={oneTimeKey} tunnelUrl={tunnelUrl} />
            <div className="flex gap-2">
              <StatCard icon="wifi" label="Tunnel" value={step === 3 ? "Online" : step >= 1 ? "Connecting" : "Offline"} accent={tunnelAccent} />
              <StatCard icon="network_ping" label="Latency" value={latency ? `${latency}ms` : null} accent="text-orange-400" />
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
                  <p key={i} className="text-xs font-mono text-white/50 leading-5 break-all">{line}</p>
                ))}
                <div ref={logEndRef} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* footer */}
      <div className="px-5 pb-5 pt-4 flex gap-2 border-t border-white/5">
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
    </div>
  );
}
