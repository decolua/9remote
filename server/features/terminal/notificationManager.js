// Server-side notification badge state manager
// Stores { sessionId -> notification } in memory

let notifications = {};

export function addNotification(sessionId, notification) {
  notifications[sessionId] = notification;
}

export function clearNotification(sessionId) {
  delete notifications[sessionId];
}

export function getNotifications() {
  return { ...notifications };
}
