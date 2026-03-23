import { useState, useEffect } from "preact/hooks";
import MainScreen from "./screens/MainScreen";

const defaultState = {
  step: 0,
  tunnelUrl: "",
  oneTimeKey: "",
  qrUrl: "",
  latency: null,
  uptime: null,
};

const defaultPermissions = { screenRecording: false, accessibility: false };
const MAX_LOGS = 200;

export default function App() {
  const [mainState, setMainState] = useState(defaultState);
  const [permissions, setPermissions] = useState(defaultPermissions);
  const [logs, setLogs] = useState([]);
  const [updateVersion, setUpdateVersion] = useState(null);

  useEffect(() => {
    // Fetch permissions
    fetch("/api/permissions")
      .then((r) => r.json())
      .then((data) => setPermissions(data))
      .catch(() => {});

    // SSE for real-time state updates
    const es = new EventSource("/api/ui/events");

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "state") {
          setMainState({
            step: data.step ?? 0,
            tunnelUrl: data.tunnelUrl ?? "",
            oneTimeKey: data.oneTimeKey ?? "",
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
          setPermissions(data);
        }
      } catch { /* ignore parse errors */ }
    };

    es.onerror = () => {
      // SSE auto-reconnects on error — no action needed
    };

    return () => es.close();
  }, []);

  const handleRequestPermission = async (type) => {
    await fetch("/api/permissions/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type }),
    }).catch(() => {});
  };

  const handleRefresh = () => {
    fetch("/api/ui/restart", { method: "POST" }).catch(() => {});
    setMainState(defaultState);
  };

  const handleStop = () => {
    fetch("/api/ui/stop", { method: "POST" }).catch(() => {});
    setMainState(defaultState);
  };

  return (
    <MainScreen
      step={mainState.step}
      tunnelUrl={mainState.tunnelUrl}
      oneTimeKey={mainState.oneTimeKey}
      qrUrl={mainState.qrUrl}
      latency={mainState.latency}
      uptime={mainState.uptime}
      permissions={permissions}
      updateVersion={updateVersion}
      onRequestPermission={handleRequestPermission}
      onRefresh={handleRefresh}
      onStop={handleStop}
      logs={logs}
    />
  );
}
