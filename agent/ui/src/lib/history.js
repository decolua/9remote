// Command history persisted in localStorage (agent UI has no Zustand store).
import { HISTORY_KEY, HISTORY_MAX } from "./constants";

export function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function save(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch {}
  return list;
}

// Most-recent-first, de-duplicated, capped.
export function addHistory(cmd) {
  const c = cmd.trim();
  if (!c) return loadHistory();
  return save([c, ...loadHistory().filter((x) => x !== c)].slice(0, HISTORY_MAX));
}

export function removeHistory(cmd) {
  return save(loadHistory().filter((x) => x !== cmd));
}

export function clearHistory() {
  return save([]);
}
