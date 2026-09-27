// Driver for daemon-managed CLI processes across agent restarts.
import * as daemonClient from "../../terminal/ptyDaemonClient.js";

export function toLines(text) {
  const parts = String(text).split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

export class DaemonProc {
  constructor({ procId, client = daemonClient }) {
    this.procId = procId;
    this.client = client;
    this.onLine = null;
    this.onExit = null;
    this.onRefused = null;
    this.dead = false;
    this.attached = false;
    this._lastLine = 0;
    this._epoch = null;
    this._hold = null;
    this._handleLine = ({ procId: id, epoch, n, data }) => {
      if (id !== this.procId) return;
      if (epoch != null && epoch !== this._epoch) return;
      if (n <= this._lastLine) return;
      if (this._hold) this._hold.push({ n, data });
      else {
        this._lastLine = n;
        this.onLine?.(decodeLine(data), n);
      }
    };
    this._handleExit = ({ procId: id, epoch, code, signal, error }) => {
      if (id !== this.procId || this.dead) return;
      if (epoch != null && epoch !== this._epoch) return;
      this.dead = true;
      this._unsubscribe();
      this.onExit?.({ code, signal, error });
    };
  }

  _subscribe() {
    if (this.attached) return;
    this.client.on("procLine", this._handleLine);
    this.client.on("procExit", this._handleExit);
    this.attached = true;
  }

  _unsubscribe() {
    if (!this.attached) return;
    this.client.off("procLine", this._handleLine);
    this.client.off("procExit", this._handleExit);
    this.attached = false;
  }

  _openHold() {
    if (!this._hold) this._hold = [];
    return this._hold;
  }

  _result(total, lines, oldest) {
    const first = lines[0]?.n ?? oldest ?? null;
    const missed = first == null ? 0 : Math.max(0, first - (this._lastLine + 1));
    this._lastLine = Math.max(this._lastLine, total ?? 0);
    const after = this._openHold();
    let released = false;
    return {
      lines,
      after,
      missed,
      release: () => {
        if (released) return;
        released = true;
        this._hold = null;
        for (const held of after) {
          if (held.n <= this._lastLine) continue;
          this._lastLine = held.n;
          this.onLine?.(decodeLine(held.data), held.n);
        }
      }
    };
  }

  /** Start CLI under daemon; returns initial buffered lines. */
  async start({ bin, args = [], cwd, env = {}, from = 0, keepStdin = false }) {
    this._lastLine = from;
    this._hold = null;
    this.dead = false;
    this._subscribe();
    this._openHold();
    try {
      const res = await this.client.procStart(this.procId, { bin, args, cwd, env });
      if (!res.success) throw new Error(res.error || "Failed to start process");
      this._epoch = res.epoch ?? null;
      const fetched = await this.client.procLines(this.procId, from);
      const result = this._result(fetched.total, fetched.lines || [], fetched.oldest);
      return startResult(keepStdin ? result : { ...result, closeStdin: () => this.closeStdin() });
    } catch (e) {
      this._unsubscribe();
      throw e;
    }
  }

  /** Re-attach to a running daemon process. */
  async attach(from = 0, epoch = null) {
    if (typeof from === "object" && from !== null) {
      epoch = from.epoch ?? null;
      from = from.from ?? 0;
    }
    from = Number(from) || 0;
    this._lastLine = from;
    this._subscribe();
    this._openHold();
    const res = await this.client.procAttach(this.procId, from);
    if (!res.success) {
      this._unsubscribe();
      return { alive: false, ...startResult() };
    }
    this._epoch = res.epoch ?? null;
    this.dead = !res.alive;
    if (this.dead) this._unsubscribe();
    if (epoch != null && res.epoch !== epoch) this._lastLine = 0;
    return { alive: res.alive, ...startResult(this._result(res.total, res.lines || [], res.oldest)) };
  }

  get lineNo() {
    return this._lastLine;
  }

  get epoch() {
    return this._epoch;
  }

  async lines(from = 0) {
    this._openHold();
    const res = await this.client.procLines(this.procId, from);
    if (!res.success) return startResult();
    return startResult(this._result(res.total, res.lines || [], res.oldest));
  }

  /** Write text to process stdin via daemon. */
  write(text) {
    if (this.dead) return false;
    const onRefused = this.onRefused;
    this.client.procWrite(this.procId, Buffer.from(String(text)).toString("base64"))
      .then((res) => {
        if (res?.success) return;
        this.dead = true;
        this._unsubscribe();
        onRefused?.({ code: null, error: res?.error || "Process not writable" });
      })
      .catch(() => {});
    return true;
  }

  /** Close stdin for non-interactive engines. */
  closeStdin() {
    return this.client.procEndInput(this.procId);
  }

  /** Send signal to process. */
  signal(signal = "SIGINT") {
    return this.client.procSignal(this.procId, signal);
  }

  async stop() {
    this._unsubscribe();
    return await this.client.procStop(this.procId);
  }
}

export function decodeLine(line) {
  if (typeof line === "string") return line;
  if (!line?.data) return "";
  return line.enc === "b64" ? Buffer.from(line.data, "base64").toString("utf8") : line.data;
}

/** Standard return shape for start/attach calls. */
export function startResult({ lines = [], after = [], missed = 0, release = () => {}, closeStdin = null } = {}) {
  return {
    lines,
    after,
    missed,
    release,
    commit: (feed) => {
      for (const line of lines) feed(decodeLine(line));
      release();
      closeStdin?.();
    }
  };
}
