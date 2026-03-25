import { useState, useEffect } from "preact/hooks";
import MainScreen from "./screens/MainScreen";

const defaultState = {
  step: 0,
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

  useEffect(() => {
    // Single fetch for all initial state (ui + permissions + desktop)
    fetch("/api/ui/state")
      .then((r) => r.json())
      .then((data) => {
        setMainState({
          step: data.step ?? 0,
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
      })
      .catch(() => {});

    const es = new EventSource("/api/ui/events");

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "state") {
          setMainState({
            step: data.step ?? 0,
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
    />
  );
}
