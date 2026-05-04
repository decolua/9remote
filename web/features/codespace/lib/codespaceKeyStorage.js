// Map codespace name -> agent apiKey (kept in localStorage)
const STORAGE_KEY = "9remote_codespace_keys";

function read() {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function write(map) {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function saveCodespaceKey(codespaceName, apiKey) {
  const map = read();
  map[codespaceName] = apiKey;
  write(map);
}

export function getCodespaceKey(codespaceName) {
  return read()[codespaceName] || null;
}

export function removeCodespaceKey(codespaceName) {
  const map = read();
  delete map[codespaceName];
  write(map);
}
