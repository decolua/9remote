// Format timestamp to relative time (e.g. "2 hours ago")
export function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);
  
  if (years > 0) return `${years} year${years > 1 ? "s" : ""} ago`;
  if (months > 0) return `${months} month${months > 1 ? "s" : ""} ago`;
  if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
  if (seconds > 0) return `${seconds} second${seconds > 1 ? "s" : ""} ago`;
  
  return "just now";
}

// Mask API key for security (show prefix and suffix only)
export function maskApiKey(apiKey) {
  if (!apiKey) return "";
  
  const prefixLength = 8;
  const suffixLength = 6;
  
  if (apiKey.length <= prefixLength + suffixLength) {
    return apiKey;
  }
  
  const prefix = apiKey.substring(0, prefixLength);
  const suffix = apiKey.substring(apiKey.length - suffixLength);
  const maskedPart = "•".repeat(12);
  
  return `${prefix}${maskedPart}${suffix}`;
}
