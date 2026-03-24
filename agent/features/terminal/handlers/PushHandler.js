import { getVapidPublicKey, addPushSubscription, removePushSubscription, markSubscriptionConnected } from "../pushManager.js";
import { enableToolHook, disableToolHook, getHookStatus } from "../hookManager.js";
import { addNotification, clearNotification, getNotifications } from "../notificationManager.js";
import { getAutoStartStatus, setAutoStart, isCodespaces } from "../codespaceManager.js";

export function setupPushHandlers(socket) {
  socket.on("getNotificationState", () => {
    socket.emit("notificationState", getNotifications());
  });

  socket.on("clearNotification", (sessionId) => {
    if (sessionId) {
      clearNotification(sessionId);
      socket.broadcast.emit("notificationCleared", sessionId);
    }
  });

  socket.on("getVapidKey", (callback) => callback(getVapidPublicKey()));

  socket.on("pushSubscribe", (subscription) => {
    const identifier = subscription?.type === "expo" ? subscription.token : subscription?.endpoint;
    if (!identifier) return;
    markSubscriptionConnected(socket.id, identifier);
    addPushSubscription(subscription, socket.id);
  });

  socket.on("pushUnsubscribe", (identifier) => {
    if (identifier) removePushSubscription(identifier);
  });

  socket.on("enableHook", async ({ tool }, callback) => {
    try { callback(await enableToolHook(tool)); } catch (e) { callback({ success: false, error: e.message }); }
  });

  socket.on("disableHook", async ({ tool }, callback) => {
    try { callback(await disableToolHook(tool)); } catch (e) { callback({ success: false, error: e.message }); }
  });

  socket.on("getHookStatus", (callback) => callback(getHookStatus()));

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
