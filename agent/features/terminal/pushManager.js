// WebPush Notification Management
import os from "os";
import fs from "fs";
import path from "path";
import webpush from "web-push";

const VAPID_CONFIG_PATH = path.join(os.homedir(), ".9remote", "vapid.json");
const PUSH_SUBS_PATH = path.join(os.homedir(), ".9remote", "push-subscriptions.json");
const PUSH_OFFLINE_LIMIT_MS = 30 * 60 * 1000; // 30 minutes

// Push subscriptions: { endpoint, keys, socketId, disconnectedAt }
let pushSubscriptions = [];

function loadVapidKeys() {
  try {
    if (fs.existsSync(VAPID_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(VAPID_CONFIG_PATH, "utf8"));
    }
  } catch (e) {
    // Ignore
  }
  return null;
}

function saveVapidKeys(keys) {
  const dir = path.dirname(VAPID_CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VAPID_CONFIG_PATH, JSON.stringify(keys, null, 2), "utf8");
}

function initVapidKeys() {
  let keys = loadVapidKeys();
  if (!keys) {
    const generated = webpush.generateVAPIDKeys();
    keys = { publicKey: generated.publicKey, privateKey: generated.privateKey };
    saveVapidKeys(keys);
  }
  webpush.setVapidDetails("mailto:admin@9remote.cc", keys.publicKey, keys.privateKey);
  return keys;
}

function loadPushSubscriptions() {
  try {
    if (fs.existsSync(PUSH_SUBS_PATH)) {
      pushSubscriptions = JSON.parse(fs.readFileSync(PUSH_SUBS_PATH, "utf8"));
    }
  } catch (e) {
    pushSubscriptions = [];
  }
}

function savePushSubscriptions() {
  try {
    const dir = path.dirname(PUSH_SUBS_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PUSH_SUBS_PATH, JSON.stringify(pushSubscriptions, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save push subscriptions:", e.message);
  }
}

export function addPushSubscription(subscription, socketId) {
  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== subscription.endpoint);
  pushSubscriptions.push({ ...subscription, socketId, lastConnectedAt: Date.now() });
  savePushSubscriptions();
}

export function removePushSubscription(endpoint) {
  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
  savePushSubscriptions();
}

export function markSubscriptionDisconnected(socketId) {
  for (const sub of pushSubscriptions) {
    if (sub.socketId === socketId) sub.disconnectedAt = Date.now();
  }
  savePushSubscriptions();
}

export function markSubscriptionConnected(socketId, endpoint) {
  for (const sub of pushSubscriptions) {
    if (sub.endpoint === endpoint) {
      sub.socketId = socketId;
      sub.disconnectedAt = null;
      sub.lastConnectedAt = Date.now();
    }
  }
  savePushSubscriptions();
}

export async function sendPushNotification(notification) {
  const toolNames = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
  const toolName = toolNames[notification.tool] || "AI";

  console.log(`🔔 Sending push notification: ${notification.type} ${toolName}`);

  const payload = JSON.stringify({
    title: notification.type === "stop" ? `${toolName} ✅` : `${toolName} 🔔`,
    body: notification.type === "stop" ? `${toolName} completed the task` : `${toolName} needs your input`,
    data: { url: "/workspace", type: notification.type }
  });

  const expiredEndpoints = [];

  // Push only to the latest connected subscription
  const latest = pushSubscriptions.reduce((a, b) =>
    (a?.lastConnectedAt ?? 0) >= (b?.lastConnectedAt ?? 0) ? a : b
  , null);
  const targets = latest ? [latest] : [];

  console.log(`📤 sendPush: total=${pushSubscriptions.length} target=${targets.length > 0 ? latest.endpoint.slice(0, 50) + "..." : "none"}`);

  for (const sub of targets) {
    try {
      await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
      console.log(`  ✅ Push sent to ${sub.endpoint.slice(0, 50)}...`);
    } catch (error) {
      console.log(`  ❌ Push failed: ${error.statusCode} ${error.message}`);
      if (error.statusCode === 410 || error.statusCode === 404) {
        expiredEndpoints.push(sub.endpoint);
      }
    }
  }

  // Cleanup expired
  if (expiredEndpoints.length > 0) {
    pushSubscriptions = pushSubscriptions.filter(s => !expiredEndpoints.includes(s.endpoint));
    savePushSubscriptions();
  }
}

// Initialize VAPID keys and load subscriptions on import
const vapidKeys = initVapidKeys();
loadPushSubscriptions();

export function getVapidPublicKey() {
  return vapidKeys.publicKey;
}
