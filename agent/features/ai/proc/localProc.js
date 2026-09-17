// Runs an engine CLI as a direct child of this process — the fallback when no daemon
// is available, for every engine. A chat then behaves like any other in-agent engine:
// it lives only as long as the agent does.
//
// The surface is deliberately the same as DaemonProc's and AgentProc's, so an adapter
// never learns which carrier it got.
import { spawn } from "node:child_process";
import { toLines, startResult } from "./daemonProc.js";

export class LocalProc {
  constructor() {
    this.child = null;
    this.onLine = null;
    this.onExit = null;
    this.tail = "";
  }

  async start({ bin, args = [], cwd, env = {}, keepStdin = false }) {
    const child = spawn(bin, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env });
    this.child = child;
    // The spawn is asynchronous: a missing binary reports through "error", which
    // without a listener would surface as an unhandled event and take the agent down.
    child.on("error", (err) => this.onExit?.({ code: null, signal: null, error: err.message }));
    this._pump(child.stdout);
    this._pump(child.stderr);
    child.on("close", (code, signal) => {
      if (this.tail) { this.onLine?.(this.tail); this.tail = ""; }
      this.onExit?.({ code, signal: signal || null });
    });
    // Same shape every carrier answers start() with: a direct child has no backlog to
    // replay and nothing to hold, but the caller still gets the one `commit` door.
    // `keepStdin` is claude's: its CLI takes every later turn, interrupt and permission
    // answer on this pipe, so ending it would kill the conversation at birth.
    return startResult(keepStdin ? {} : { closeStdin: () => this.closeStdin() });
  }

  // Nothing to adopt: this process dies with the agent, so there is never a live
  // one to re-attach to.
  async attach() {
    return { alive: false, ...startResult() };
  }

  async lines() {
    return startResult();
  }

  _pump(stream) {
    if (!stream) return;
    stream.on("data", (chunk) => {
      const { lines, rest } = toLines(this.tail + chunk.toString());
      this.tail = rest;
      for (const line of lines) this.onLine?.(line);
    });
  }

  // A dead child's stdin is gone; saying so beats a write into the void (see jsonRpcClient._write).
  write(text) { return Boolean(this.child?.stdin?.writable) && (this.child.stdin.write(String(text)), true); }
  closeStdin() { try { this.child?.stdin?.end(); } catch {} }
  signal(sig = "SIGINT") { try { this.child?.kill(sig); } catch {} }
  async stop() { try { this.child?.kill("SIGINT"); } catch {} }
}
