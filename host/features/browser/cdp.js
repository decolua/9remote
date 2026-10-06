import { CDP_CALL_TIMEOUT_MS } from "./constants.js";

export class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
    return () => this.handlers.get(method)?.delete(fn);
  }

  static async connect(wsUrl, timeoutMs = 10000) {
    const client = new CdpClient(wsUrl);
    await client._open(timeoutMs);
    return client;
  }

  _open(timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP connect timeout: ${this.wsUrl}`));
      }, timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`CDP connect failed: ${this.wsUrl}`));
      });
      ws.addEventListener("message", (ev) => this._onMessage(ev.data));
      ws.addEventListener("close", () => this._failAll("CDP connection closed"));
      this.ws = ws;
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg.id) {
      const subs = this.handlers.get(msg.method);
      if (subs) {
        for (const fn of subs) {
          try { fn(msg.params || {}, msg.sessionId); } catch { /* ignore subscriber error */ }
        }
      }
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message || "CDP error"));
    else entry.resolve(msg.result);
  }

  _failAll(reason) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  get closed() { return !this.ws || this.ws.readyState === WebSocket.CLOSED; }

  call(method, params = {}, sessionId = null, timeoutMs = CDP_CALL_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const frame = { id, method, params };
      if (sessionId) frame.sessionId = sessionId;
      this.ws.send(JSON.stringify(frame));
    });
  }

  close() {
    this._failAll("CDP connection closed");
    try { this.ws?.close(); } catch { /* already closed */ }
  }
}

export async function waitForDevTools(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const base = `http://127.0.0.1:${port}`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return await res.json();
    } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`DevTools endpoint did not respond on port ${port}`);
}
