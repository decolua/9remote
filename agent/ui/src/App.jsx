import { useState, useEffect } from "preact/hooks";
import MainScreen from "./screens/MainScreen";

const defaultState = {
  step: 0,
  stepDesc: "",
  tunnelUrl: "",
  oneTimeKey: "",
  oneTimeKeyExpiresAt: null,
  permanentKey: "",
  qrUrl: "",
  latency: null,
  uptime: null,
};

const defaultPermissions = { screenRecording: false, accessibility: false };
const MAX_LOGS = 200;

export default function App() {
  const [mainState, setMainState] = useState(defaultState);
  const [permissions, setPermissions] = useState(defaultPermissions);
  const [desktopEnabled, setDesktopEnabled] = useState(false);
  const [logs, setLogs] = useState([]);
  const [updateVersion, setUpdateVersion] = useState(null);
  const [connections, setConnections] = useState([]);
  const [pendingDevice, setPendingDevice] = useState(null);
  const [approvedDevices, setApprovedDevices] = useState([]);
  const [rejectedDevices, setRejectedDevices] = useState([]);
  const [version, setVersion] = useState("");
  const [theme, setTheme] = useState(() => {
    // Will be overridden by server state if provided
    const saved = localStorage.getItem("9remote-theme");
    return saved || "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("9remote-theme", theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme(prev => prev === "dark" ? "light" : "dark");
  };

  useEffect(() => {
    fetch("/api/version").then((r) => r.json()).then((d) => setVersion(d.version ?? "")).catch(() => {});
    // Single fetch for all initial state (ui + permissions + desktop + theme)
    fetch("/api/ui/state")
      .then((r) => r.json())
      .then((data) => {
        setMainState({
          step: data.step ?? 0,
          stepDesc: data.stepDesc ?? "",
          tunnelUrl: data.tunnelUrl ?? "",
          oneTimeKey: data.oneTimeKey ?? "",
          oneTimeKeyExpiresAt: data.oneTimeKeyExpiresAt ?? null,
          permanentKey: data.permanentKey ?? "",
          qrUrl: data.qrUrl ?? "",
          latency: data.latency ?? null,
          uptime: data.uptime ?? null,
        });
        setPermissions({
          screenRecording: data.screenRecording ?? false,
          accessibility: data.accessibility ?? false,
        });
        if (data.desktopEnabled !== undefined) setDesktopEnabled(data.desktopEnabled);
        // Override theme if server provides one
        if (data.theme && (data.theme === "light" || data.theme === "dark")) {
          setTheme(data.theme);
        }
      })
      .catch(() => {});

    const es = new EventSource("/api/ui/events");

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "state") {
          setMainState({
            step: data.step ?? 0,
            stepDesc: data.stepDesc ?? "",
            tunnelUrl: data.tunnelUrl ?? "",
            oneTimeKey: data.oneTimeKey ?? "",
            oneTimeKeyExpiresAt: data.oneTimeKeyExpiresAt ?? null,
            permanentKey: data.permanentKey ?? "",
            qrUrl: data.qrUrl ?? "",
            latency: data.latency ?? null,
            uptime: data.uptime ?? null,
          });
        } else if (data.type === "log") {
          setLogs((prev) => {
            const next = [...prev, data.message];
            return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
          });
        } else if (data.type === "updateAvailable") {
          setUpdateVersion(data.version);
        } else if (data.type === "permissions") {
          setPermissions({ screenRecording: data.screenRecording, accessibility: data.accessibility });
          if (data.desktopEnabled !== undefined) setDesktopEnabled(data.desktopEnabled);
        } else if (data.type === "connections") {
          setConnections(data.connections ?? []);
        } else if (data.type === "deviceApproval" && data.action === "pending") {
          setPendingDevice({ socketId: data.socketId, deviceId: data.deviceId, ip: data.ip });
        } else if (data.type === "deviceApproval" && data.action === "refresh") {
          fetchDevices();
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {};

    return () => es.close();
  }, []);

  const handleRequestPermission = async (type) => {
    await fetch("/api/permissions/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    }).catch(() => {});
  };

  const handleStop = () => {
    fetch("/api/ui/stop", { method: "POST" }).catch(() => {});
    setMainState(defaultState);
  };

  const handleStart = () => {
    fetch("/api/ui/start", { method: "POST" }).catch(() => {});
  };

  const handleGenerateOneTimeKey = async () => {
    const res = await fetch("/api/key/one-time", { method: "POST" }).catch(() => null);
    if (!res?.ok) return;
    const data = await res.json().catch(() => null);
    if (data?.oneTimeKey) {
      setMainState((prev) => ({
        ...prev,
        oneTimeKey: data.oneTimeKey,
        oneTimeKeyExpiresAt: data.expiresAt,
        qrUrl: data.qrUrl ?? prev.qrUrl,
      }));
    }
  };

  const handleDesktopToggle = async () => {
    const next = !desktopEnabled;
    setDesktopEnabled(next);
    await fetch("/api/desktop/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    }).catch(() => {});
  };

  const fetchDevices = async () => {
    try {
      const [aRes, rRes] = await Promise.all([
        fetch("/api/device/approved"),
        fetch("/api/device/rejected"),
      ]);
      if (aRes.ok) { const d = await aRes.json(); setApprovedDevices(d.devices || []); }
      if (rRes.ok) { const d = await rRes.json(); setRejectedDevices(d.rejected || []); }
    } catch {}
  };

  const handleDeviceRemove = async (client) => {
    // Pending (rejected) devices → clear from rejected map; approved → remove from disk
    const endpoint = client.status === "pending" ? "/api/device/clear-rejected" : "/api/device/remove";
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId: client.deviceId }),
    }).catch(() => {});
    fetchDevices();
  };

  const handleDeviceApprove = async () => {
    if (!pendingDevice) return;
    await fetch("/api/device/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ socketId: pendingDevice.socketId }),
    }).catch(() => {});
    setPendingDevice(null);
    fetchDevices();
  };

  const handleDeviceReject = async () => {
    if (!pendingDevice) return;
    await fetch("/api/device/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ socketId: pendingDevice.socketId }),
    }).catch(() => {});
    setPendingDevice(null);
    fetchDevices();
  };

  const handleDeviceApproveRejected = async (deviceId) => {
    await fetch("/api/device/approve-rejected", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId }),
    }).catch(() => {});
    fetchDevices();
  };

  const handleRegenerateKey = async () => {
    const res = await fetch("/api/key/regenerate", { method: "POST" }).catch(() => null);
    if (!res?.ok) return;
    const data = await res.json().catch(() => null);
    if (data?.permanentKey) {
      setMainState((prev) => ({ ...prev, permanentKey: data.permanentKey }));
    }
  };

  return (
    <MainScreen
      step={mainState.step}
      stepDesc={mainState.stepDesc}
      tunnelUrl={mainState.tunnelUrl}
      oneTimeKey={mainState.oneTimeKey}
      oneTimeKeyExpiresAt={mainState.oneTimeKeyExpiresAt}
      permanentKey={mainState.permanentKey}
      qrUrl={mainState.qrUrl}
      permissions={permissions}
      desktopEnabled={desktopEnabled}
      updateVersion={updateVersion}
      connections={connections}
      onRequestPermission={handleRequestPermission}
      onDesktopToggle={handleDesktopToggle}
      onStop={handleStop}
      onStart={handleStart}
      onGenerateOneTimeKey={handleGenerateOneTimeKey}
      onRegenerateKey={handleRegenerateKey}
      logs={logs}
      version={version}
      theme={theme}
      onToggleTheme={toggleTheme}
      pendingDevice={pendingDevice}
      onDeviceApprove={handleDeviceApprove}
      onDeviceReject={handleDeviceReject}
      approvedDevices={approvedDevices}
      rejectedDevices={rejectedDevices}
      onDeviceRemove={handleDeviceRemove}
      onFetchDevices={fetchDevices}
      onDeviceApproveRejected={handleDeviceApproveRejected}
    />
  );
}
