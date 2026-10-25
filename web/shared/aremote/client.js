export const AREMOTE = process.env.NEXT_PUBLIC_AREMOTE === "1";
const KEY = "aremote.device";
export function readDevice() {
  if (typeof window === "undefined") return null;
  try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; }
}
export function saveDevice(device) { localStorage.setItem(KEY, JSON.stringify(device)); }
export function clearDevice() { localStorage.removeItem(KEY); }
export function normalizeServer(address, port) {
  const url = new URL(address);
  if (port) url.port = port;
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("请输入完整的 HTTPS Server 地址");
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("远程 Server 必须使用 HTTPS");
  return url.origin;
}
export async function relayApi(path, data, device = readDevice()) {
  if (!device?.server) throw new Error("请先配置 Server");
  const r = await fetch(device.server + path, { method: data ? "POST" : "GET", headers: { "Content-Type": "application/json", ...(device.token ? { Authorization: `Bearer ${device.token}` } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}), signal: AbortSignal.timeout(10000) });
  const result = await r.json();
  if (!r.ok) throw Object.assign(new Error(result.error || `HTTP ${r.status}`), { status: r.status });
  return result;
}
