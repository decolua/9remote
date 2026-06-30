// WebPush Notification Management
import fs from "fs";
import path from "path";
import webpush from "web-push";
import { PATHS, TOOL_LABELS } from "../../lib/constants.js";

const VAPID_CONFIG_PATH = path.join(PATHS.CONFIG, "vapid.json");
const PUSH_SUBS_PATH = path.join(PATHS.CONFIG, "push-subscriptions.json");
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

// Get unique identifier per subscription type
function getIdentifier(sub) {
  return sub.type === "expo" ? sub.token : sub.endpoint;
}

export function addPushSubscription(subscription, socketId) {
  const id = getIdentifier(subscription);
  pushSubscriptions = pushSubscriptions.filter(s => getIdentifier(s) !== id);
  pushSubscriptions.push({ ...subscription, socketId, lastConnectedAt: Date.now() });
  savePushSubscriptions();
}

export function removePushSubscription(identifier) {
  pushSubscriptions = pushSubscriptions.filter(s => getIdentifier(s) !== identifier);
  savePushSubscriptions();
}

export function markSubscriptionDisconnected(socketId) {
  for (const sub of pushSubscriptions) {
    if (sub.socketId === socketId) sub.disconnectedAt = Date.now();
  }
  savePushSubscriptions();
}

export function markSubscriptionConnected(socketId, identifier) {
  for (const sub of pushSubscriptions) {
    if (getIdentifier(sub) === identifier) {
      sub.socketId = socketId;
      sub.disconnectedAt = null;
      sub.lastConnectedAt = Date.now();
    }
  }
  savePushSubscriptions();
}

async function sendExpoPush(sub, toolName, notification) {
  const message = {
    to: sub.token,
    sound: "default",
    title: notification.type === "stop" ? `${toolName} ✅` : `${toolName} 🔔`,
    body: notification.type === "stop" ? `${toolName} completed the task` : `${toolName} needs your input`,
    data: { url: "/workspace", type: notification.type }
  };
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(message)
  });
  const result = await res.json();
  if (result.data?.status === "error") throw new Error(result.data.message);
  console.log(`  ✅ Expo push sent to ${sub.token.slice(0, 30)}...`);
}

export async function sendPushNotification(notification) {
  const toolName = TOOL_LABELS[notification.tool] || "AI";

  console.log(`🔔 Sending push notification: ${notification.type} ${toolName}`);

  // Push only to the latest connected subscription
  const latest = pushSubscriptions.reduce((a, b) =>
    (a?.lastConnectedAt ?? 0) >= (b?.lastConnectedAt ?? 0) ? a : b
  , null);

  if (!latest) {
    console.log("📤 sendPush: no subscriptions");
    return;
  }

  const id = getIdentifier(latest);
  console.log(`📤 sendPush: total=${pushSubscriptions.length} target=${id.slice(0, 50)}...`);

  try {
    if (latest.type === "expo") {
      await sendExpoPush(latest, toolName, notification);
    } else {
      const payload = JSON.stringify({
        title: notification.type === "stop" ? `${toolName} ✅` : `${toolName} 🔔`,
        body: notification.type === "stop" ? `${toolName} completed the task` : `${toolName} needs your input`,
        data: { url: "/workspace", type: notification.type }
      });
      await webpush.sendNotification({ endpoint: latest.endpoint, keys: latest.keys }, payload);
      console.log(`  ✅ WebPush sent to ${latest.endpoint.slice(0, 50)}...`);
    }
  } catch (error) {
    console.log(`  ❌ Push failed: ${error.statusCode || error.message}`);
    const isExpired = error.statusCode === 410 || error.statusCode === 404 || error.message?.includes("DeviceNotRegistered");
    if (isExpired) {
      pushSubscriptions = pushSubscriptions.filter(s => getIdentifier(s) !== id);
      savePushSubscriptions();
    }
  }
}

// Initialize VAPID keys and load subscriptions on import
const vapidKeys = initVapidKeys();
loadPushSubscriptions();

export function getVapidPublicKey() {
  return vapidKeys.publicKey;
}

// True only when a device is actively connected — gate for sending push (disconnected app shouldn't push)
export function hasPushSubscriptions() {
  return pushSubscriptions.some((s) => !s.disconnectedAt);
}
