// Persistence for the local-sites list: user-added ports and their custom labels.
// Every read is SSR-safe and tolerates corrupted JSON — a bad entry must not blank
// the sites panel.
// Extracted verbatim from SitesList.

const CUSTOM_PORTS_KEY = "custom_ports";
const SITE_LABELS_KEY = "site_labels";

function readJson(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, value) {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, JSON.stringify(value));
}

export const getCustomPorts = () => readJson(CUSTOM_PORTS_KEY, []);
export const saveCustomPorts = (ports) => writeJson(CUSTOM_PORTS_KEY, ports);
export const getSiteLabels = () => readJson(SITE_LABELS_KEY, {});
export const saveSiteLabels = (labels) => writeJson(SITE_LABELS_KEY, labels);
