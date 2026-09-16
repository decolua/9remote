// The agent's side of a daemon-managed CLI that runs ONE TURN per process (codex,
// opencode, antigravity). Claude spawns once per conversation and lets its adapter
// drive the process for its whole life; these three are turn-per-CLI, so the adapter
// still decides when a process is born — it just asks the daemon instead of spawning.
//
// Same shape as claudeAdapter's LocalProc, so an adapter never learns which carrier
// it got. The daemon owns the process, which is the whole point: an agent restart
// mid-turn can adopt it instead of losing it.
import * as daemonClient from "../../terminal/ptyDaemonClient.js";
import { startResult } from "./daemonProc.js";

export class AgentProc {
  constructor({ procId, client = daemonClient }) {
    this.procId = procId;
    // Injected so a test (or a future carrier) can drive this without a live daemon.
    this.client = client;
    this.onLine = null;
    this.onExit = null;
    this.exitNotified = false;
    this.killed = false;
    // Lines of the turn this proc is attached to. `spawn` numbers them from 1, so the
    // watermark belongs to the process; a new turn resets it with the new process.
    this.lineNo = 0;
    // Identifies the process these line numbers belong to, so a watermark stored under
    // one turn is never applied to the next.
    this.epoch = null;
    // Lines that arrive while a fetch is in flight. The fetch already carries them, so
    // letting them through live would deliver a turn's output out of order.
    this._hold = null;
    this._handleLine = ({ procId, epoch, n, data }) => {
      if (procId !== this.procId) return;
      // Output from a process this reader has already let go of: the previous turn's
      // CLI is dead, and its last lines can land after the next turn has started.
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
      // The exit of the turn we deliberately replaced is not this turn's exit.
      if (epoch != null && this.epoch != null && epoch !== this.epoch) return;
      this._notifyExit({ code, signal, error });
    };
  }

  // A dead process has no line left to send and no exit event left to wait for.
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

  /**
   * Start one turn's CLI. The turn ends when the process does, so this returns nothing
   * to replay — the handlers are already live.
   *
   * `keepStdin` matters, and this carrier used to swallow it: an engine that takes every
   * later turn on the same pipe (claude, codex app-server) dies at birth if the pipe is
   * closed after the handshake, and the failure looks like a server that never answers —
   * `initialize` went into a closed stdin and timed out 15s later. The daemon carrier
   * already honoured the flag; this one has to as well or the two disagree on what the
   * same call means. A turn-per-CLI engine keeps the default: closing stdin is what stops
   * `codex exec` blocking on a pipe nobody will write to again.
   */
  async start({ bin, args = [], cwd, env = {}, keepStdin = false }) {
    // A new process numbers its lines from 1, so the watermark restarts with it.
    this.lineNo = 0;
    this._hold = null;
    this.exitNotified = false;
    this.killed = false;
    this._subscribe();
    try {
      const res = await this.client.procStart(this.procId, { bin, args, cwd, env });
      if (!res.success) throw new Error(res.error || "Failed to start process");
      this.epoch = res.epoch ?? null;
      // Nothing was missed and nothing has to be replayed: this process was born with
      // the handlers already live, so every line it prints is delivered as it arrives.
      // Holding them for a release() the caller never calls would mute the whole turn.
      return startResult(keepStdin ? {} : { closeStdin: () => this.closeStdin() });
    } catch (e) {
      this._unsubscribe();
      throw e;
    }
  }

  /**
   * Re-attach to the turn the daemon is still running. `alive: false` means it ended
   * while no agent was watching — which is not a loss: every line it printed is in the
   * daemon's buffer, so the turn is replayed whole.
   */
  async attach({ from = 0, epoch = null } = {}) {
    this.exitNotified = false;
    this.killed = false;
    this._subscribe();
    this._openHold();
    const res = await this.client.procAttach(this.procId, from);
    if (!res.success) {
      this._unsubscribe();
      return { alive: false, ...startResult() };
    }
    this.epoch = res.epoch ?? null;
    // Line numbers belong to the PROCESS, not the chat. A stored watermark only means
    // anything against the process it was taken from — a later turn is a new process
    // numbering from 1 again, and skipping its head would cut the answer in half.
    const same = epoch != null && res.epoch === epoch;
    const all = res.lines || [];
    const lines = same ? all.filter((l) => l.n > from) : all;
    const first = lines[0]?.n ?? res.oldest ?? null;
    const missed = same || first == null ? 0 : Math.max(0, first - 1);
    this.lineNo = all.at(-1)?.n ?? res.total ?? 0;
    if (!res.alive) this._notifyExit({ code: res.exitCode ?? 0, signal: null });
    // The same `commit` door as start(): the adopted turn is non-interactive, so its
    // stdin is already closed or never needed. Handing the caller a bare fetch here
    // left the replay with nothing to call and the adopted turn silently empty.
    // `alive` spreads OUTSIDE startResult: it only carries the fetch fields, so one
    // passed inside is dropped and a live turn reads as ended.
    return { alive: Boolean(res.alive), ...startResult({ lines, after: this._hold, missed, release: () => this._release() }) };
  }

  _openHold() {
    if (!this._hold) this._hold = [];
  }

  // Held lines go out after the fetch has been parsed, in line order, skipping whatever
  // the fetch already carried.
  _release() {
    const held = this._hold;
    this._hold = null;
    for (const { n, data } of held || []) {
      if (n <= this.lineNo) continue;
      this.lineNo = n;
      this.onLine?.(data, n);
    }
  }

  /** A turn's CLI is not interactive — an open stdin only risks it waiting on one. */
  closeStdin() {
    return this.client.procEndInput(this.procId);
  }

  async stop() {
    this.killed = true;
    this._unsubscribe();
    return await this.client.procStop(this.procId);
  }
}
