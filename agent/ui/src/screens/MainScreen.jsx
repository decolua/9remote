import { useState, useRef, useEffect } from "preact/hooks";
import StepProgress from "../components/StepProgress";
import QRCard from "../components/QRCard";
import ConfirmPopup from "../components/ConfirmPopup";

const HELP_URL = "https://docs.9remote.cc/";

const PERMISSION_META = {
  screenRecording: { label: "Screen Recording", icon: "screenshot_monitor", desc: "Capture screen content" },
  accessibility:   { label: "Accessibility",    icon: "accessibility_new",  desc: "Control mouse & keyboard" },
};

/** Single permission row */
function PermissionRow({ type, granted, onRequest }) {
  const meta = PERMISSION_META[type] || { label: type, icon: "security", desc: "" };
  return (
    <div className="flex items-center gap-3 py-2 border-b border-white/5 last:border-0">
      <span className={`material-symbols-outlined flex-shrink-0 ${granted ? "text-green-400" : "text-white/30"}`} style={{ fontSize: 18 }}>
        {granted ? "check_circle" : "cancel"}
      </span>
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-medium ${granted ? "text-white/80" : "text-white/50"}`}>{meta.label}</p>
        <p className="text-[10px] text-white/30 leading-4">{meta.desc}</p>
      </div>
      {!granted && (
        <button
          onClick={() => onRequest(type)}
          className="flex-shrink-0 text-xs px-2.5 py-1 rounded-lg font-medium"
          style={{ background: "rgba(255,87,10,0.15)", color: "var(--brand-400)" }}
        >
          Grant
        </button>
      )}
    </div>
  );
}

/** Remote Terminal card — always on */
function TerminalCard() {
  return (
    <div className="glass-card p-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "rgba(255,87,10,0.15)" }}>
        <span className="material-symbols-outlined" style={{ fontSize: 20, color: "var(--brand-400)" }}>terminal</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-white">Remote Terminal</p>
        <p className="text-xs text-white/40">Full shell access · always on</p>
      </div>
      <div className="flex items-center gap-1.5 px-2 py-1 rounded-full" style={{ background: "rgba(74,222,128,0.1)" }}>
        <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
        <span className="text-xs text-green-400 font-medium">On</span>
      </div>
    </div>
  );
}

/** Remote Desktop card — toggleable + permissions */
function DesktopCard({ enabled, onToggle, permissions, onRequestPermission }) {
  const permEntries = Object.entries(PERMISSION_META);
  return (
    <div className="glass-card p-4 flex flex-col gap-3">
      {/* header row */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: enabled ? "rgba(255,87,10,0.15)" : "rgba(255,255,255,0.05)" }}>
          <span className="material-symbols-outlined" style={{ fontSize: 20, color: enabled ? "var(--brand-400)" : "rgba(255,255,255,0.25)" }}>
            desktop_windows
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-white">Remote Desktop</p>
          <p className="text-xs text-white/40">Control screen, mouse & keyboard</p>
        </div>
        {/* Toggle */}
        <button
          onClick={onToggle}
          className="flex-shrink-0 w-11 h-6 rounded-full transition-all relative"
          style={{ background: enabled ? "var(--brand-500)" : "rgba(255,255,255,0.1)" }}
        >
          <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
            style={{ left: enabled ? "calc(100% - 22px)" : "2px", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
        </button>
      </div>

      {/* Permissions — only when enabled */}
      {enabled && (
        <div className="flex flex-col border-t border-white/5 pt-2">
          <p className="text-[10px] text-white/30 uppercase tracking-wider mb-1">System Permissions</p>
          {permEntries.map(([type]) => (
            <PermissionRow
              key={type}
              type={type}
              granted={permissions?.[type] ?? false}
              onRequest={onRequestPermission}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function UpdateBanner({ version }) {
  if (!version) return null;
  const handleUpdate = () => fetch("/api/update", { method: "POST" }).catch(() => {});
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

const FEATURES = [
  { icon: "terminal", label: "Terminal", desc: "Full shell access" },
  { icon: "desktop_windows", label: "Desktop", desc: "Remote screen control" },
  { icon: "folder_open", label: "Files", desc: "Browse & edit files" },
];

const PERKS = [
  { icon: "qr_code_scanner", text: "Scan QR to connect instantly" },
  { icon: "wifi_off", text: "No port forwarding needed" },
  { icon: "devices", text: "Works on any device" },
];

function WelcomeScreen({ onStart }) {
  const [connecting, setConnecting] = useState(false);
  const handleConnect = () => {
    setConnecting(true);
    onStart();
  };
  return (
    <div className="flex-1 flex flex-col items-center justify-between px-6 py-6 overflow-y-auto">
      {/* Hero */}
      <div className="flex flex-col items-center gap-2 text-center mt-2">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-1" style={{ background: "var(--brand-500)", boxShadow: "0 8px 32px rgba(255,87,10,0.35)" }}>
          <span className="material-symbols-outlined text-white" style={{ fontSize: 30 }}>terminal</span>
        </div>
        <h1 className="text-lg font-bold text-white tracking-tight">9Remote</h1>
        <p className="text-xs text-white/50 leading-5 max-w-[220px]">
          Access your terminal, desktop & files from anywhere
        </p>
      </div>

      {/* Feature cards */}
      <div className="flex gap-2 w-full mt-5">
        {FEATURES.map((f) => (
          <div key={f.label} className="flex-1 dark-card flex flex-col items-center gap-1.5 py-3 px-1">
            <span className="material-symbols-outlined text-white/70" style={{ fontSize: 22, color: "var(--brand-400)" }}>{f.icon}</span>
            <p className="text-xs font-semibold text-white">{f.label}</p>
            <p className="text-[10px] text-white/40 text-center leading-4">{f.desc}</p>
          </div>
        ))}
      </div>

      {/* Perks list */}
      <div className="flex flex-col gap-2 w-full mt-4">
        {PERKS.map((p) => (
          <div key={p.text} className="flex items-center gap-2.5">
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 16, color: "var(--brand-400)" }}>{p.icon}</span>
            <span className="text-xs text-white/60">{p.text}</span>
          </div>
        ))}
      </div>

      {/* CTA */}
      <button
        onClick={!connecting ? handleConnect : undefined}
        disabled={connecting}
        className="btn-primary w-full py-3.5 flex items-center justify-center gap-2 text-sm font-semibold mt-6"
        style={{ borderRadius: "var(--radius-brand)", opacity: connecting ? 0.7 : 1 }}
      >
        {connecting ? (
          <>
            <span className="flex gap-0.5 items-center">
              {[0, 1, 2].map((d) => (
                <span key={d} className="w-1.5 h-1.5 rounded-full bg-white dot-bounce"
                  style={{ animationDelay: `${d * 0.18}s` }} />
              ))}
            </span>
            Connecting...
          </>
        ) : (
          <>
            <span className="material-symbols-outlined text-base">play_arrow</span>
            Connect
          </>
        )}
      </button>
    </div>
  );
}

function ConnectionItem({ conn }) {
  return (
    <div className="flex items-center gap-3 py-2 border-b border-white/5 last:border-0">
      <div className="w-2 h-2 rounded-full bg-green-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs text-white font-medium truncate">{conn.ip || "Unknown"}</p>
        <p className="text-xs text-white/30">{conn.connectedAt ? new Date(conn.connectedAt).toLocaleTimeString() : ""}</p>
      </div>
      <span className="text-xs text-white/30">{conn.type || "ws"}</span>
    </div>
  );
}

export default function MainScreen({
  step, tunnelUrl, oneTimeKey, oneTimeKeyExpiresAt, permanentKey, qrUrl,
  permissions, desktopEnabled, updateVersion, connections = [],
  onRequestPermission, onDesktopToggle, onStop, onStart, onGenerateOneTimeKey, onRegenerateKey, logs = [],
}) {
  const [activeTab, setActiveTab] = useState("connect");
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const logEndRef = useRef(null);
  const isReady = step === 4;
  const isStopped = step === 0;
  const isConnecting = step > 0 && step < 4;

  useEffect(() => {
    if (activeTab === "log") logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs, activeTab]);

  return (
    <div className="h-full flex flex-col relative overflow-hidden" style={{ background: "#333" }}>
      <div className="flex-1 flex flex-col w-full max-w-sm mx-auto min-h-0 dot-grid-bg overflow-hidden">
        {/* header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "var(--brand-500)" }}>
              <span className="material-symbols-outlined text-white text-base">terminal</span>
            </div>
            <span className="brand-text text-xs">9Remote</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => window.open(HELP_URL, "_blank")}
              className="glass-btn w-7 h-7 flex items-center justify-center text-white/40 hover:text-white"
            >
              <span className="material-symbols-outlined text-sm">help_outline</span>
            </button>
            {!isStopped && (
              <button
                onClick={() => setShowDisconnectConfirm(true)}
                className="btn-danger px-3 h-7 flex items-center gap-1.5 text-xs font-medium"
              >
                <span className="material-symbols-outlined text-sm">stop_circle</span>
                Disconnect
              </button>
            )}
          </div>
        </div>

        {/* banners */}
        <UpdateBanner version={updateVersion} />

        {/* welcome / progress / main */}
        {isStopped ? (
          <WelcomeScreen onStart={onStart} connecting={false} />
        ) : isConnecting ? (
          <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
            <StepProgress currentStep={step} />
          </div>
        ) : (
          <>
            {/* tabs */}
            <div className="flex px-5 gap-3 border-b border-white/5">
              {[
                { id: "connect", label: "Connection" },
                { id: "log", label: "Logs" },
              ].map((tab) => (
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
              {activeTab === "connect" && (
                <>
                  <QRCard
                    qrUrl={qrUrl}
                    oneTimeKey={oneTimeKey}
                    oneTimeKeyExpiresAt={oneTimeKeyExpiresAt}
                    permanentKey={permanentKey}
                    tunnelUrl={tunnelUrl}
                    onGenerateOneTimeKey={onGenerateOneTimeKey}
                    onRegenerateKey={onRegenerateKey}
                  />
                  {/* Feature cards */}
                  <TerminalCard />
                  <DesktopCard
                    enabled={desktopEnabled}
                    onToggle={onDesktopToggle}
                    permissions={permissions}
                    onRequestPermission={onRequestPermission}
                  />

                  {/* Clients inline */}
                  <div className="glass-card p-4 flex flex-col gap-1">
                    <p className="text-xs text-white/60 font-medium uppercase tracking-wider mb-2">
                      Clients{connections.length > 0 ? ` (${connections.length})` : ""}
                    </p>
                    {connections.length === 0 ? (
                      <p className="text-xs text-white/30 text-center py-3">No active connections</p>
                    ) : (
                      connections.map((conn, i) => <ConnectionItem key={i} conn={conn} />)
                    )}
                  </div>
                </>
              )}

              {activeTab === "log" && (
                <div className="flex-1 flex flex-col">
                  {logs.length === 0 ? (
                    <p className="text-xs text-white/30 text-center mt-8">No logs yet</p>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {logs.map((line, i) => (
                        <p key={i} className="text-xs font-mono text-white/60 leading-5 break-all">{line}</p>
                      ))}
                      <div ref={logEndRef} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {showDisconnectConfirm && (
        <ConfirmPopup
          message="Disconnect and stop the tunnel? Remote clients will be disconnected."
          confirmLabel="Disconnect"
          confirmDanger
          onConfirm={() => { setShowDisconnectConfirm(false); onStop?.(); }}
          onCancel={() => setShowDisconnectConfirm(false)}
        />
      )}
    </div>
  );
}
