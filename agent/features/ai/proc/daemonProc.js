// The agent's side of a daemon-managed CLI process (see ptyDaemon's "Managed child
// processes"). The daemon owns the process so a running turn survives an agent
// restart; this module is how an adapter drives it — and it is deliberately dumb:
// lines in, lines out. Every engine's dialect stays in its own adapter.
import * as daemonClient from "../../terminal/ptyDaemonClient.js";

// A line is the unit both sides agree on, so a stream that never emits a newline
// still makes progress instead of growing one unbounded buffer.
export function toLines(text) {
  const parts = String(text).split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

export class DaemonProc {
  constructor({ procId, client = daemonClient }) {
    this.procId = procId;
    // Injected so a test (or a future carrier) can drive this without a live daemon.
    this.client = client;
    this.onLine = null;
    this.onExit = null;
    this.dead = false;
    this.attached = false;
    this._lastLine = 0;
    // Which process this reader is attached to; set from every start/attach answer.
    this._epoch = null;
    this._hold = null;
    this._handleLine = ({ procId: id, epoch, n, data }) => {
      if (id !== this.procId) return;
      // Output from a process this reader has already let go of: a restart kills the
      // old CLI and its last lines can land after the new one is running.
      if (epoch != null && epoch !== this._epoch) return;
      // Already fetched. The daemon only broadcasts lines it has just accepted, so
      // this is a double delivery rather than a gap.
      if (n <= this._lastLine) return;
      // Held with its number: a line that arrives during a fetch is very likely IN
      // that fetch, and only the number can tell the duplicate from the next one.
      if (this._hold) this._hold.push({ n, data });
      else {
        this._lastLine = n;
        this.onLine?.(data, n);
      }
    };
    this._handleExit = ({ procId: id, epoch, code, signal, error }) => {
      if (id !== this.procId || this.dead) return;
      // The exit of the process we deliberately replaced is not our exit. Acting on it
      // would unsubscribe the NEW process and leave the chat silent for good — the
      // exact failure a mode/model change produced.
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

  // A hold has to be open BEFORE the request goes out, not after it comes back: a line
  // the daemon broadcasts while the fetch is in flight is also in the response, and
  // only the numbers can tell that duplicate from the next line.
  _openHold() {
    if (!this._hold) this._hold = [];
    return this._hold;
  }

  // Hands the fetched lines over and lets the held ones through after them, in line
  // order, skipping whatever the fetch already carried.
  _result(total, lines, oldest) {
    // What is missing is measured from the FIRST line the daemon actually hands back:
    // anything between the reader's watermark and that line is gone for good. `oldest`
    // is only the fallback for an empty answer (a ring that dropped everything the
    // reader asked for). Measuring from the ring's floor instead would cry wolf on a
    // restart — the floor sits far below a returning reader's own watermark, and those
    // lines are already in the snapshot.
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
          // A line the fetch already carried is in both places; delivering it again
          // would duplicate a message in the conversation.
          if (held.n <= this._lastLine) continue;
          this._lastLine = held.n;
          this.onLine?.(held.data, held.n);
        }
      }
    };
  }

  /**
   * Start the CLI under the daemon. Returns the lines it emitted before the handlers
   * were in place, for the caller to parse before live output.
   */
  async start({ bin, args = [], cwd, env = {}, from = 0 }) {
    // A new process numbers its lines from 1, so the watermark restarts with it. Keeping
    // the old one would make every new line look already-consumed and be dropped — the
    // chat would sit silent until the agent restarted again.
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
      return this._result(fetched.total, fetched.lines || [], fetched.oldest);
    } catch (e) {
      this._unsubscribe();
      throw e;
    }
  }

  /**
   * Re-attach to a process that is already running (the agent restarted mid-turn).
   * `alive: false` means the turn ended while no agent was watching.
   */
  async attach(from = 0, epoch = null) {
    // The reader's watermark is the baseline the gap is measured against, so it has to
    // be set before the answer is interpreted — the same rule `start` follows.
    this._lastLine = from;
    this._subscribe();
    this._openHold();
    const res = await this.client.procAttach(this.procId, from);
    if (!res.success) {
      this._unsubscribe();
      return { alive: false, lines: [], after: [], release: () => {}, missed: 0 };
    }
    this._epoch = res.epoch ?? null;
    this.dead = !res.alive;
    // A dead process has no exit event left to send, so there is nothing to wait for.
    if (this.dead) this._unsubscribe();
    // Line numbers belong to a process, so a stored watermark only means something
    // against the one it was taken from. Claude keeps one process for a whole
    // conversation and holds its watermark across turns, so on a different process the
    // watermark has to go — otherwise the resumed conversation's head is skipped as
    // "already consumed". Turn-per-CLI engines hand `from = 0` and never notice.
    if (epoch != null && res.epoch !== epoch) this._lastLine = 0;
    return { alive: res.alive, ...this._result(res.total, res.lines || [], res.oldest) };
  }

  /** Highest line number this reader has consumed, for a restart to resume from.
   *  Named like AgentProc's, so a session reads its watermark the same way whichever
   *  carrier an engine got. */
  get lineNo() {
    return this._lastLine;
  }

  /** The process these line numbers belong to, for the same reason. */
  get epoch() {
    return this._epoch;
  }

  /** Everything after the line the caller last consumed. */
  async lines(from = 0) {
    this._openHold();
    const res = await this.client.procLines(this.procId, from);
    if (!res.success) return { lines: [], after: [], release: () => {}, missed: 0 };
    return this._result(res.total, res.lines || [], res.oldest);
  }

  write(text) {
    return this.client.procWrite(this.procId, Buffer.from(String(text)).toString("base64"));
  }

  /** An engine whose CLI reads no stdin still gets it closed: a piped stdin that never
   *  ends is how `codex exec` blocks instead of running the turn. */
  closeStdin() {
    return this.client.procEndInput(this.procId);
  }

  /** SIGINT — an engine's chance to interrupt its own turn and flush state. */
  signal(signal = "SIGINT") {
    return this.client.procSignal(this.procId, signal);
  }

  async stop() {
    this._unsubscribe();
    return await this.client.procStop(this.procId);
  }
}

// A fetched line travels base64-encoded (the daemon counts bytes, not characters);
// a live one is already text by the time the client emits it.
export function decodeLine(line) {
  if (typeof line === "string") return line;
  if (!line?.data) return "";
  return line.enc === "b64" ? Buffer.from(line.data, "base64").toString("utf8") : line.data;
}
