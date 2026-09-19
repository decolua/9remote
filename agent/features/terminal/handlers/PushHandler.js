import { getVapidPublicKey, addPushSubscription, removePushSubscription, markSubscriptionConnected, setSubscriptionHidden } from "../pushManager.js";
// enableToolHook/getHookStatus kept for reference (hooks auto-enabled on startup, not toggled by clients)
import { getNotifications, getStatuses, clearStatus, STATES } from "../statusManager.js";
import { getAutoStartStatus, setAutoStart, isCodespaces } from "../codespaceManager.js";
import { writeCmd } from "../../../cli/utils/state.js";
import { scanLocalSites } from "../portScanner.js";
import { startProxySession, endProxySession, setupSiteRequestHandler } from "../../../proxy/index.js";
import { setMcpEnabled, MCP_CLIENTS } from "../../../mcp/mcpConfig.js";
import { readSettings, writeSettings } from "../../../lib/settings.js";
import { broadcast } from "../../../transport/broadcast.js";

export function setupPushHandlers(socket, io) {
  // Full 4-state map (idle/working/blocked/done). New name; UI consumes this.
  socket.on("getStatusState", () => {
    socket.emit("statusState", getStatuses());
  });

  // Legacy: only done/blocked truthy map. Kept for older web clients.
  socket.on("getNotificationState", () => {
    socket.emit("notificationState", getNotifications());
  });

  // Local sites over the socket bus — works on RTC where the tunnel URL may be stale/absent
  socket.on("getLocalSites", async (callback) => {
    if (typeof callback !== "function") return;
    try {
      callback({ sites: await scanLocalSites() });
    } catch (err) {
      callback({ error: err.message });
    }
  });

  // Proxy sessions over the socket bus — the tunnel URL may be stale/absent on RTC or LAN
  socket.on("startProxySession", (port, callback) => {
    if (!port) return;
    const sessionId = startProxySession(port);
    if (typeof callback === "function") callback(sessionId ? { ok: true, sessionId } : { error: "bad-port" });
  });

  socket.on("endProxySession", (port, callback) => {
    if (!port) return;
    endProxySession(port);
    if (typeof callback === "function") callback({ ok: true });
  });

  // HTTP-for-localhost over the bus — feeds the web app's /browse/ service worker
  setupSiteRequestHandler(socket);

  // Trigger agent self-update via socket (authenticated, no HTTP through tunnel)
  socket.on("requestUpdate", () => writeCmd("update"));

  // Restart agent host (no reinstall): kill + relaunch, ptyDaemon survives
  socket.on("requestRestart", () => writeCmd("restart"));

  // Clear on focus/input/switch → idle. Only broadcast when a DONE entry was actually cleared;
  // working/blocked must survive focus so a running agent keeps its spinner.
  socket.on("clearStatus", (sessionId) => {
    if (!sessionId) return;
    const cleared = clearStatus(sessionId);
    if (cleared) {
      broadcast(null, "statusCleared", sessionId);
      broadcast(null, "notificationCleared", sessionId);
    }
  });
  socket.on("clearNotification", (sessionId) => {
    if (!sessionId) return;
    const cleared = clearStatus(sessionId);
    if (cleared) {
      broadcast(null, "notificationCleared", sessionId);
      broadcast(null, "statusCleared", sessionId);
    }
  });

  socket.on("getVapidKey", (callback) => callback(getVapidPublicKey()));

  socket.on("pushSubscribe", (subscription) => {
    const identifier = subscription?.type === "expo" ? subscription.token : subscription?.endpoint;
    if (!identifier) return;
    markSubscriptionConnected(socket.id, identifier);
    // Device identity reads the normalized field first — the handshake is the
    // socket.io spelling of the same thing and stays for real-socket hosts.
    addPushSubscription(subscription, socket.id, socket.data?.auth?.deviceId ?? socket.handshake?.auth?.deviceId);
  });

  socket.on("pushUnsubscribe", (identifier) => {
    if (identifier) removePushSubscription(identifier);
  });

  socket.on("visibilityChange", (hidden) => setSubscriptionHidden(socket.id, hidden));

  // Hooks are always auto-enabled on agent startup (badge in-app source); enable/disable/status not exposed to clients
  // socket.on("enableHook", async ({ tool }, callback) => { try { callback(await enableToolHook(tool)); } catch (e) { callback({ success: false, error: e.message }); } });
  // socket.on("disableHook", async ({ tool }, callback) => { try { callback(await disableToolHook(tool)); } catch (e) { callback({ success: false, error: e.message }); } });
  // socket.on("getHookStatus", (callback) => callback(getHookStatus()));

  // Artifact MCP: one switch that writes the endpoint into every AI CLI's own config.
  // A running CLI reads its config at startup, so the change lands on its next launch.
  socket.on("setArtifactEnabled", async ({ enabled } = {}, callback) => {
    const value = setMcpEnabled(enabled);
    callback?.({ success: true, enabled: value, clients: MCP_CLIENTS });
    // Every other client mirrors this setting — imported lazily because terminalSocket
    // is what mounts these handlers, so a static import would close the cycle.
    const { broadcastServerInfo } = await import("../terminalSocket.js");
    broadcastServerInfo();
  });

  socket.on("getVoiceConfig", (callback) => {
    callback?.({ success: true, voiceConfig: readSettings().voiceConfig || null });
  });

  socket.on("setVoiceConfig", async ({ voiceConfig } = {}, callback) => {
    const next = writeSettings({ voiceConfig });
    callback?.({ success: true, voiceConfig: next?.voiceConfig || null });
    const { broadcastServerInfo } = await import("../terminalSocket.js");
    broadcastServerInfo();
  });

  socket.on("getAutoStartStatus", (callback) => {
    if (!isCodespaces()) return callback({ success: false, error: "Not in Codespaces" });
    const workspacePath = process.env.CODESPACE_VSCODE_FOLDER || process.cwd();
    callback({ success: true, ...getAutoStartStatus(workspacePath) });
  });

  socket.on("setAutoStart", ({ enabled }, callback) => {
    if (!isCodespaces()) return callback({ success: false, error: "Not in Codespaces" });
    const workspacePath = process.env.CODESPACE_VSCODE_FOLDER || process.cwd();
    callback(setAutoStart(workspacePath, enabled));
  });
}
