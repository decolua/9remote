// Agent-side client for daemon-managed turn-per-process CLIs.
import * as daemonClient from "../../terminal/ptyDaemonClient.js";
import { startResult } from "./daemonProc.js";

export class AgentProc {
  constructor({ procId, client = daemonClient }) {
    this.procId = procId;
    this.client = client;
    this.onLine = null;
    this.onExit = null;
    this.exitNotified = false;
    this.killed = false;
    this.lineNo = 0;
    this.epoch = null;
    // Buffer lines arriving during an in-flight fetch to preserve order.
    this._hold = null;
    this._handleLine = ({ procId, epoch, n, data }) => {
      if (procId !== this.procId) return;
      if (epoch != null && this.epoch != null && epoch !== this.epoch) return;
      if (n <= this.lineNo) return;
      if (this._hold) this._hold.push({ n, data });
      else {
        this.lineNo = n;
        this.onLine?.(data, n);
      }
    };
    this._handleExit = ({ procId, epoch, code, signal, error }) => {
      if (procId !== this.procId) return;
      if (epoch != null && this.epoch != null && epoch !== this.epoch) return;
      this._notifyExit({ code, signal, error });
    };
  }

  _notifyExit(info) {
    if (this.exitNotified) return;
    this.exitNotified = true;
    this._unsubscribe();
    this.onExit?.(info);
  }

  _subscribe() {
    this.client.on("procLine", this._handleLine);
    this.client.on("procExit", this._handleExit);
  }

  _unsubscribe() {
    this.client.off("procLine", this._handleLine);
    this.client.off("procExit", this._handleExit);
  }

  // Start one turn CLI process via daemon, optionally keeping stdin open.
  async start({ bin, args = [], cwd, env = {}, keepStdin = false }) {
    this.lineNo = 0;
    this._hold = null;
    this.exitNotified = false;
    this.killed = false;
    this._subscribe();
    try {
      const res = await this.client.procStart(this.procId, { bin, args, cwd, env });
      if (!res.success) throw new Error(res.error || "Failed to start process");
      this.epoch = res.epoch ?? null;
      return startResult(keepStdin ? {} : { closeStdin: () => this.closeStdin() });
    } catch (e) {
      this._unsubscribe();
      throw e;
    }
  }

  // Re-attach to a turn still running or buffered in the daemon.
  async attach(from = 0, epoch = null) {
    const f = typeof from === "object" && from !== null ? from.from ?? 0 : Number(from) || 0;
    const ep = typeof from === "object" && from !== null ? from.epoch ?? null : epoch ?? null;
    this.exitNotified = false;
    this.killed = false;
    this._subscribe();
    this._openHold();
    const res = await this.client.procAttach(this.procId, f);
    if (!res.success) {
      this._unsubscribe();
      return { alive: false, ...startResult() };
    }
    this.epoch = res.epoch ?? null;
    const same = ep != null && res.epoch === ep;
    const all = res.lines || [];
    const lines = same ? all.filter((l) => l.n > f) : all;
    const first = lines[0]?.n ?? res.oldest ?? null;
    const missed = same || first == null ? 0 : Math.max(0, first - 1);
    this.lineNo = all.at(-1)?.n ?? res.total ?? 0;
    if (!res.alive) this._notifyExit({ code: res.exitCode ?? 0, signal: null });
    return { alive: Boolean(res.alive), ...startResult({ lines, after: this._hold, missed, release: () => this._release() }) };
  }

  _openHold() {
    if (!this._hold) this._hold = [];
  }

  _release() {
    const held = this._hold;
    this._hold = null;
    for (const { n, data } of held || []) {
      if (n <= this.lineNo) continue;
      this.lineNo = n;
      this.onLine?.(data, n);
    }
  }

  closeStdin() {
    return this.client.procEndInput(this.procId);
  }

  async stop() {
    this.killed = true;
    this._unsubscribe();
    return await this.client.procStop(this.procId);
  }
}
