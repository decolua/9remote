import { REMOTE_CONFIG } from "@/features/remote/constants/REMOTE_CONFIG";

export function debugLog(flag, ...args) {
  if (REMOTE_CONFIG.debug?.[flag]) console.log(...args);
}
