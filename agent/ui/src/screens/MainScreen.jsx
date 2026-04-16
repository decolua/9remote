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
    <div className="flex items-center gap-3 py-2 border-b last:border-0" style={{ borderColor: "var(--border)" }}>
      <span className={`material-symbols-outlined flex-shrink-0 ${granted ? "text-green-400" : ""}`} style={{ fontSize: 18, color: granted ? undefined : "var(--text-muted)" }}>
        {granted ? "check_circle" : "cancel"}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium" style={{ color: granted ? "var(--text-main)" : "var(--text-muted)" }}>{meta.label}</p>
        <p className="text-[10px] leading-4" style={{ color: "var(--text-muted)" }}>{meta.desc}</p>
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

/** Remote Services card — Terminal (always on) + Desktop (toggleable) */
function ServicesCard({ desktopEnabled, onDesktopToggle, permissions, onRequestPermission }) {
  const permEntries = Object.entries(PERMISSION_META);
  return (
    <div className="glass-card p-4 flex flex-col gap-3">
      {/* Terminal row */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "rgba(255,87,10,0.15)" }}>
          <span className="material-symbols-outlined" style={{ fontSize: 20, color: "var(--brand-400)" }}>terminal</span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--text-main)" }}>Remote Terminal</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Full shell access · always on</p>
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1 rounded-full" style={{ background: "rgba(74,222,128,0.1)" }}>
          <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
          <span className="text-xs text-green-400 font-medium">On</span>
        </div>
      </div>

      {/* Divider */}
      <div className="w-full h-px" style={{ background: "var(--border)" }} />

      {/* Desktop row */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: desktopEnabled ? "rgba(255,87,10,0.15)" : "var(--glass-bg)" }}>
          <span className="material-symbols-outlined" style={{ fontSize: 20, color: desktopEnabled ? "var(--brand-400)" : "var(--text-muted)" }}>
            desktop_windows
          </span>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold" style={{ color: "var(--text-main)" }}>Remote Desktop</p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>Control screen, mouse & keyboard</p>
        </div>
        {/* Toggle */}
        <button
          onClick={onDesktopToggle}
          className="flex-shrink-0 w-11 h-6 rounded-full transition-all relative"
          style={{ background: desktopEnabled ? "var(--brand-500)" : "var(--border)" }}
        >
          <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all"
            style={{ left: desktopEnabled ? "calc(100% - 22px)" : "2px", boxShadow: "0 1px 3px rgba(0,0,0,0.3)" }} />
        </button>
      </div>

      {/* Permissions — only when desktop enabled */}
      {desktopEnabled && (
        <div className="flex flex-col border-t pt-2" style={{ borderColor: "var(--border)" }}>
          <p className="text-[10px] uppercase tracking-wider mb-1" style={{ color: "var(--text-muted)" }}>System Permissions</p>
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
        <h1 className="text-lg font-bold tracking-tight" style={{ color: "var(--text-main)" }}>9Remote</h1>
        <p className="text-xs leading-5 max-w-[220px]" style={{ color: "var(--text-muted)" }}>
          Access your terminal, desktop & files from anywhere
        </p>
      </div>

      {/* Feature cards */}
      <div className="flex gap-2 w-full mt-5">
        {FEATURES.map((f) => (
          <div key={f.label} className="flex-1 dark-card flex flex-col items-center gap-1.5 py-3 px-1">
            <span className="material-symbols-outlined" style={{ fontSize: 22, color: "var(--brand-400)" }}>{f.icon}</span>
            <p className="text-xs font-semibold" style={{ color: "var(--text-main)" }}>{f.label}</p>
            <p className="text-[10px] text-center leading-4" style={{ color: "var(--text-muted)" }}>{f.desc}</p>
          </div>
        ))}
      </div>

      {/* Perks list */}
      <div className="flex flex-col gap-2 w-full mt-4">
        {PERKS.map((p) => (
          <div key={p.text} className="flex items-center gap-2.5">
            <span className="material-symbols-outlined flex-shrink-0" style={{ fontSize: 16, color: "var(--brand-400)" }}>{p.icon}</span>
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>{p.text}</span>
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

/** Merge approved + rejected devices with active connections into 1 client = 1 device list.
 *  Same device may open multiple sockets — use earliest connectedAt. */
function mergeClients(approvedDevices, connections, rejectedDevices = []) {
  const connByDevice = new Map();
  for (const c of connections) {
    if (!c.deviceId) continue;
    const existing = connByDevice.get(c.deviceId);
    if (!existing || (c.connectedAt && c.connectedAt < existing.connectedAt)) {
      connByDevice.set(c.deviceId, c);
    }
  }

  const approved = approvedDevices.map((d) => {
    const conn = connByDevice.get(d.deviceId);
    return {
      deviceId: d.deviceId,
      status: conn ? "online" : "offline",
      ip: conn?.ip || null,
      connectedAt: conn?.connectedAt || null,
      approvedAt: d.approvedAt || null,
    };
  });

  const pending = rejectedDevices.map((r) => ({
    deviceId: r.deviceId,
    status: "pending",
    ip: r.ip || null,
    connectedAt: null,
    approvedAt: null,
    rejectedAt: r.rejectedAt || null,
  }));

  const rank = { online: 0, pending: 1, offline: 2 };
  return [...approved, ...pending].sort((a, b) => rank[a.status] - rank[b.status]);
}

const STATUS_META = {
  online:  { color: "#4ade80", icon: "wifi",          title: "Online" },
  offline: { color: "var(--text-muted)", icon: "wifi_off",      title: "Offline" },
  pending: { color: "#f59e0b", icon: "hourglass_top", title: "Pending approval" },
};

function ClientItem({ client, onRemove, onApprove }) {
  const shortId = `${client.deviceId.slice(0, 8)}...`;
  const meta = STATUS_META[client.status] || STATUS_META.offline;
  const timeLabel =
    client.status === "online"
      ? `Connected · ${client.connectedAt ? new Date(client.connectedAt).toLocaleTimeString() : ""}`
      : client.status === "pending"
        ? `Pending · waiting for approval`
        : client.approvedAt
          ? `Offline · approved ${new Date(client.approvedAt).toLocaleDateString()}`
          : "Offline";
  const actionLabel = client.status === "online" ? "Disconnect" : "Remove";

  return (
    <div className="flex items-center gap-3 py-2 border-b last:border-0" style={{ borderColor: "var(--border)" }}>
      <span
        className="material-symbols-outlined flex-shrink-0"
        style={{ fontSize: 18, color: meta.color }}
        title={meta.title}
      >
        {meta.icon}
      </span>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium font-mono truncate" style={{ color: "var(--text-main)" }}>
          {shortId}{client.ip ? ` · ${client.ip}` : ""}
        </p>
        <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>{timeLabel}</p>
      </div>
      {client.status === "pending" && (
        <button
          onClick={() => onApprove?.(client)}
          className="flex-shrink-0 text-xs px-2 py-1 rounded-lg font-medium"
          style={{ background: "rgba(74,222,128,0.15)", color: "#4ade80" }}
          title="Approve this device"
        >
          Approve
        </button>
      )}
      <button
        onClick={() => onRemove(client)}
        className="flex-shrink-0 text-xs px-2 py-1 rounded-lg font-medium"
        style={{ background: "rgba(220,53,69,0.15)", color: "#dc3545" }}
        title="Disconnect and remove this device"
      >
        {actionLabel}
      </button>
    </div>
  );
}

export default function MainScreen({
  step, tunnelUrl, oneTimeKey, oneTimeKeyExpiresAt, permanentKey, qrUrl,
  permissions, desktopEnabled, updateVersion, connections = [], version = "",
  onRequestPermission, onDesktopToggle, onStop, onStart, onGenerateOneTimeKey, onRegenerateKey, logs = [],
  theme, onToggleTheme,
  pendingDevice, onDeviceApprove, onDeviceReject,
  approvedDevices = [], rejectedDevices = [], onDeviceRemove, onFetchDevices, onDeviceApproveRejected,
}) {
  const [activeTab, setActiveTab] = useState("connect");
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [deviceToRemove, setDeviceToRemove] = useState(null);
  const logEndRef = useRef(null);
  // STEP enum: STOPPED=0, PREPARING=1, CONNECTING=2, TUNNELING=3, VERIFYING=4, READY=5
  const isReady = step === 5;
  const isStopped = step === 0;
  const isConnecting = step > 0 && step < 5;

  // Refresh devices list whenever tab active or state updates (so offline/online stays in sync)
  useEffect(() => {
    if (activeTab === "log") logEndRef.current?.scrollIntoView({ behavior: "smooth" });
    if (activeTab === "connect") onFetchDevices?.();
  }, [logs, activeTab, connections.length]);

  const clients = mergeClients(approvedDevices, connections, rejectedDevices);
  const onlineCount = clients.filter((c) => c.status === "online").length;

  return (
    <div className="h-full flex flex-col relative overflow-hidden" style={{ background: "var(--bg-body)" }}>
      <div className="flex-1 flex flex-col w-full min-h-0 dot-grid-bg overflow-hidden md:max-w-5xl p-3" style={{ margin: "0 auto" }}>
        {/* header */}
        <div className="flex items-center justify-between px-5 py-4" style={{ boxShadow: "var(--header-shadow)", backdropFilter: "blur(10px)" }}>
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "var(--brand-500)" }}>
              <span className="material-symbols-outlined text-white text-base">terminal</span>
            </div>
            <div className="flex flex-col leading-tight">
              <span className="brand-text text-xs">9Remote</span>
              {version && <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>v{version}</span>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleTheme}
              className="glass-btn w-7 h-7 flex items-center justify-center"
              style={{ color: "var(--text-muted)" }}
              title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            >
              <span className="material-symbols-outlined text-sm">
                {theme === "dark" ? "light_mode" : "dark_mode"}
              </span>
            </button>
            <button
              onClick={() => window.open(HELP_URL, "_blank")}
              className="glass-btn w-7 h-7 flex items-center justify-center"
              style={{ color: "var(--text-muted)" }}
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
          <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4 max-w-2xl mx-auto w-full">
            <StepProgress currentStep={step} />
          </div>
        ) : (
          <div className="flex-1 flex flex-col md:flex-row min-h-0">
            {/* Sidebar (QR + Keys) - desktop only visible, mobile in tabs */}
            <div className="hidden md:flex md:flex-col sidebar w-96 flex-shrink-0 overflow-y-auto p-5 gap-4">
              <QRCard
                qrUrl={qrUrl}
                oneTimeKey={oneTimeKey}
                oneTimeKeyExpiresAt={oneTimeKeyExpiresAt}
                permanentKey={permanentKey}
                tunnelUrl={tunnelUrl}
                onGenerateOneTimeKey={onGenerateOneTimeKey}
                onRegenerateKey={onRegenerateKey}
              />
            </div>

            {/* Main content */}
            <div className="flex-1 flex flex-col min-h-0">
              {/* tabs */}
              <div className="flex px-5 pt-3 gap-3" style={{ borderColor: "var(--border)" }}>
                {[
                  { id: "connect", label: "Connection" },
                  { id: "log", label: "Logs" },
                ].map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className="py-2 text-xs font-medium border-b-2 transition-colors"
                    style={activeTab === tab.id
                      ? { borderColor: "var(--brand-500)", color: "var(--brand-500)" }
                      : { borderColor: "transparent", color: "var(--text-muted)" }
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
                    {/* QR Card - mobile only */}
                    <div className="md:hidden">
                      <QRCard
                        qrUrl={qrUrl}
                        oneTimeKey={oneTimeKey}
                        oneTimeKeyExpiresAt={oneTimeKeyExpiresAt}
                        permanentKey={permanentKey}
                        tunnelUrl={tunnelUrl}
                        onGenerateOneTimeKey={onGenerateOneTimeKey}
                        onRegenerateKey={onRegenerateKey}
                      />
                    </div>

                    {/* Feature cards */}
                    <ServicesCard
                      desktopEnabled={desktopEnabled}
                      onDesktopToggle={onDesktopToggle}
                      permissions={permissions}
                      onRequestPermission={onRequestPermission}
                    />

                    {/* Clients (merged devices + live connections) */}
                    <div className="glass-card p-4 flex flex-col gap-1">
                      <p className="text-xs font-medium uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
                        Clients{clients.length > 0 ? ` (${onlineCount}/${clients.length} online)` : ""}
                      </p>
                      {clients.length === 0 ? (
                        <p className="text-xs text-center py-3" style={{ color: "var(--text-muted)" }}>No clients yet</p>
                      ) : (
                        clients.map((c) => (
                          <ClientItem
                            key={c.deviceId}
                            client={c}
                            onRemove={setDeviceToRemove}
                            onApprove={(cl) => onDeviceApproveRejected?.(cl.deviceId)}
                          />
                        ))
                      )}
                    </div>
                  </>
                )}

                {activeTab === "log" && (
                  <div className="flex-1 flex flex-col">
                    {logs.length === 0 ? (
                      <p className="text-xs text-center mt-8" style={{ color: "var(--text-muted)" }}>No logs yet</p>
                    ) : (
                      <div className="flex flex-col gap-0.5">
                        {logs.map((line, i) => (
                          <p key={i} className="text-xs font-mono leading-5 break-all" style={{ color: "var(--text-muted)" }}>{line}</p>
                        ))}
                        <div ref={logEndRef} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
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

      {deviceToRemove && (
        <ConfirmPopup
          message={deviceToRemove.status === "online"
            ? `Disconnect and remove device ${deviceToRemove.deviceId.slice(0, 8)}...? The client will be disconnected and need approval again next time.`
            : deviceToRemove.status === "pending"
              ? `Remove pending device ${deviceToRemove.deviceId.slice(0, 8)}...? It will need a fresh approval request to connect again.`
              : `Remove device ${deviceToRemove.deviceId.slice(0, 8)}...? It will need approval again next time.`}
          confirmLabel={deviceToRemove.status === "online" ? "Disconnect & Remove" : "Remove"}
          confirmDanger
          onConfirm={() => { onDeviceRemove?.(deviceToRemove); setDeviceToRemove(null); }}
          onCancel={() => setDeviceToRemove(null)}
        />
      )}

      {pendingDevice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: "rgba(0,0,0,0.6)" }}>
          <div className="glass-card p-5 flex flex-col gap-4 w-80">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined" style={{ color: "var(--brand-500)", fontSize: 24 }}>devices</span>
              <span className="text-sm font-semibold" style={{ color: "var(--text-main)" }}>New Device Connection</span>
            </div>
            <div className="flex flex-col gap-1 text-xs" style={{ color: "var(--text-muted)" }}>
              <span>Device: <span style={{ color: "var(--text-main)" }}>{pendingDevice.deviceId?.slice(0, 8)}...</span></span>
              <span>IP: <span style={{ color: "var(--text-main)" }}>{pendingDevice.ip}</span></span>
            </div>
            <div className="flex gap-2">
              <button onClick={onDeviceReject} className="glass-btn flex-1 py-2 text-sm" style={{ color: "var(--text-muted)" }}>
                Reject
              </button>
              <button
                onClick={onDeviceApprove}
                className="flex-1 py-2 text-sm font-semibold rounded-xl"
                style={{ background: "var(--brand-500)", color: "#fff" }}
              >
                Approve
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
