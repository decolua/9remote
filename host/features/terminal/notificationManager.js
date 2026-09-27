// Back-compat shim — logic moved to statusManager.js (4-state: idle/working/blocked/done).
// Existing imports (addNotification, clearNotification, getNotifications) keep working.
export {
  addNotification,
  clearNotification,
  getNotifications,
  applyEvent,
  getStatuses,
  clearStatus,
  getStatus,
  setStatus,
  onClearStatus,
  STATES,
  TYPE_TO_STATE,
} from "./statusManager.js";
