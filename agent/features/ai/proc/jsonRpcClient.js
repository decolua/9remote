// The request/response half of a JSON-RPC stdio CLI, in ONE place.
//
// `codex exec --json` prints one-way JSONL: a process is born per turn and nothing ever
// answers back. The app-server (and Claude's `--input-format=stream-json`) keeps one
// process for the whole chat and talks both ways, which is what makes a turn a *request*
// rather than a line in the void — and what allows the server to ask a question mid-turn
// (a permission gate) and wait for the answer.
//
// The envelope differs per CLI (codex: `{jsonrpc,id,method}`; Claude: `{type,request_id}`)
// so the two shape-reading hooks are injectable, and everything above them — correlating
// answers, routing notifications, surviving a dead process — is shared.
//
// This runs on whatever proc the adapter already has (daemon-backed AgentProc, or a
// direct child), so it owns no transport of its own.
export class JsonRpcClient {
  /**
   * @param {object} proc  Anything with write(text), and onLine/onExit to assign.
   * @param {object} [opts]
   * @param {function} [opts.extractId]      Message → request id, or null/undefined.
   * @param {function} [opts.extractMethod]  Message → method name, or null/undefined.
   * @param {function} [opts.encodeResponse] (id, result) → the answer object to write.
   * @param {function} [opts.encodeError]    (id, message) → the refusal object to write.
   * @param {function} [opts.onMessage]      Anything that is none of the three kinds.
   * @param {function} [opts.encodeNotification] (method, params) → the object to write.
   * @param {function} [opts.encodeRequest]  (id, method, params) → the object to write.
   * @param {function} [opts.decodeResponse] Message → { id, error, result }, for a CLI
   *   whose answer does not put them where JSON-RPC does.
   */
  constructor(proc, {
    extractId = defaultId, extractMethod = defaultMethod,
    encodeResponse = defaultEncodeResponse, encodeError = defaultEncodeError,
    encodeNotification = defaultEncodeNotification, encodeRequest = defaultEncodeRequest,
    decodeResponse = defaultDecodeResponse, onMessage = null
  } = {}) {
    this.proc = proc;
    this._extractId = extractId;
    this._extractMethod = extractMethod;
    this._encodeResponse = encodeResponse;
    this._encodeError = encodeError;
    this._encodeNotification = encodeNotification;
    this._encodeRequest = encodeRequest;
    this._decodeResponse = decodeResponse;
    this._onMessage = onMessage;

    this._nextId = 1;
    this._pending = new Map();   // id → { resolve, reject }
    this._handlers = new Map();  // method → fn(params)
    this._exitHandlers = [];
    this.closed = false;
    this.dead = false;
    // Answers that arrived before the request that asks for them; see feed().
    this._early = [];
    // Bound at construction: a line can arrive while the caller is still awaiting the
    // first request, and a hook attached afterwards would drop it — a turn that stalls
    // with its own answer already on the pipe.
    this.attach();
  }

  /** Take over the proc's line and exit hooks. */
  attach() {
    this.proc.onLine = (line) => this._receive(line);
    this.proc.onExit = (info) => this._handleExit(info);
    return this;
  }

  /**
   * A call that expects an answer. Resolves with the result, rejects on an error.
   *
   * `timeoutMs` is opt-in and defaults to none: whether an unanswered request is a
   * failure depends on the CALL, not on the transport. A handshake that never comes back
   * is a dead server and must fail; `turn/start`'s answer is an ack that a long turn may
   * legitimately delay, and timing that out would mark a live turn dead — see
   * codexAppServer.js, which sets the window per request.
   */
  request(method, params = {}, { timeoutMs = 0 } = {}) {
    if (this.dead || this.closed) {
      return Promise.reject(new Error("Codex app-server has exited or been closed"));
    }
    const id = this._nextId++;
    let timer = null;
    const answer = new Promise((resolve, reject) => {
      this._pending.set(id, {
        resolve,
        reject,
        // Clearing the timer on the way out, or a chat that asked a thousand questions
        // leaves a thousand timers behind — each one holding its promise alive.
        settle: (fn, arg) => { if (timer) clearTimeout(timer); timer = null; this._pending.delete(id); fn(arg); }
      });
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const pending = this._pending.get(id);
        if (!pending) return;
        pending.settle(pending.reject, new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
    this.proc.write(JSON.stringify(this._encodeRequest(id, method, params)) + "\n");
    // An answer that was already waiting for this request was held; hand it over now.
    this._drainEarly();
    return answer;
  }

  /**
   * A message that expects nothing back, in this CLI's own envelope.
   *
   * `onRefused` is for the one failure a notification CAN have: a carrier that reports the
   * write was turned away (the process is gone). Without it the caller had no way to learn
   * its message reached nobody — a prompt written into a dead pipe looked exactly like one
   * that landed, and the chat spun on a turn no process was running. Only refusals: a write
   * that went out is never reported, since whether the turn succeeds is the CLI's business.
   */
  notify(method, params = {}, onRefused = null) {
    if (this.dead || this.closed) {
      onRefused?.();
      return false;
    }
    return this._write(JSON.stringify(this._encodeNotification(method, params)) + "\n", onRefused);
  }

  /** Answer a request the SERVER sent, by its own id, in this CLI's own envelope. */
  respond(id, result) {
    if (this.dead || this.closed) return false;
    return this._write(JSON.stringify(this._encodeResponse(id, result)) + "\n");
  }

  /**
   * The ONE place a line leaves this client, so the write's own outcome is read in one
   * place. A carrier states a refusal either way: synchronously (`false` — a local child
   * whose stdin is gone) or afterwards through `onRefused` (the daemon, which only learns
   * the child has exited when it tries).
   *
   * `onRefused` is ASSIGNED, not merged: left over from an earlier message it would fire
   * for a later one, and a permission answer refused on a dead pipe would re-send the
   * prompt that had nothing to do with it.
   */
  _write(text, onRefused = null) {
    this.proc.onRefused = onRefused;
    const ok = this.proc.write(text) !== false;
    if (!ok) onRefused?.();
    return ok;
  }

  /** A handler, keyed by method. Its return value answers a server request, if any. */
  on(method, fn) {
    this._handlers.set(method, fn);
    return this;
  }

  onExit(fn) {
    this._exitHandlers.push(fn);
    return this;
  }

  /**
   * Feed one line that arrived before the handlers could be attached.
   *
   * A daemon-backed carrier buffers the process's first lines and hands them over on
   * `commit(feed)`. The feed can run BEFORE the first request is written — the caller
   * commits as soon as the spawn returns, and only then sends `initialize` — so an
   * answer that was already waiting has no request to resolve yet. Dropping it left the
   * handshake to time out on a server that had replied, which is the same silent stall
   * the hold itself used to cause, one layer up.
   *
   * A response with no waiting id is therefore held, not discarded. Only responses:
   * a notification carries no id and is safe to route at once.
   */
  feed(line) {
    this._feedEarly(line);
  }

  _feedEarly(line) {
    const text = typeof line === "string" ? line.trim() : "";
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    const { id } = this._decodeResponse(msg);
    const method = this._extractMethod(msg);
    // A response is one with an id and no method (JSON-RPC's own rule, same as _receive).
    if (method == null && id != null && !this._pending.has(id)) {
      this._early.push(msg);
      return;
    }
    this._receive(text);
  }

  /** Hand over anything that arrived before its request existed. */
  _drainEarly() {
    if (!this._early.length) return;
    const queued = this._early;
    this._early = [];
    for (const msg of queued) this._receive(JSON.stringify(msg));
  }

  _receive(line) {
    const text = typeof line === "string" ? line.trim() : "";
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); } catch { return; }  // a warning on stdout is not a message
    if (!msg || typeof msg !== "object") return;

    const id = this._extractId(msg);
    const method = this._extractMethod(msg);

    // A response to something we asked. An id nobody is waiting on is dropped: it can
    // only be a late answer to a request that already timed out or was cancelled.
    if (method == null) {
      // Claude states the id inside the answer, not on the envelope, so the id above is
      // not the one to look up — see decodeResponse. Both hooks are read here so a
      // caller that only overrides one still gets the correlation right.
      const answer = this._decodeResponse(msg);
      const pending = answer.id != null ? this._pending.get(answer.id) : (id != null ? this._pending.get(id) : null);
      if (!pending) {
        // Not a response we asked for — and, for a CLI that does not speak JSON-RPC, not a
        // response at all. Claude's records are `{type:"assistant"|"stream_event"|…}` with
        // no method, so every one of them lands here; without this seam they were dropped
        // one by one, silently. The whole conversation is what would be lost.
        this._onMessage?.(msg);
        return;
      }
      if (answer.error) pending.settle(pending.reject, new Error(answer.error.message || answer.error || "request failed"));
      else pending.settle(pending.resolve, answer.result);
      return;
    }

    const handler = this._handlers.get(method);

    // A request FROM the server — it is waiting, so silence would hang the turn. The id
    // is what makes it a request (that is the whole of JSON-RPC's rule): a notification
    // has a method and no id, a response has an id and no method.
    if (id != null) {
      if (!handler) {
        // Refuse rather than ignore: the CLI stays blocked until it hears something, and
        // an unregistered method is exactly the case a newer server would introduce.
        // Its own encoder, not the answer's: JSON-RPC states a failure in `error`, and a
        // CLI that reads that field would take a refusal sent as `result` for a success.
        this.proc.write(JSON.stringify(
          this._encodeError(id, `unhandled server request: ${method}`)
        ) + "\n");
        return;
      }
      const answer = handler(msg.params || {}, id);
      // A handler may return nothing and answer later — a permission gate waits on the
      // user, and answering here would approve on their behalf.
      if (answer && typeof answer.then === "function") answer.then((r) => r !== undefined && this.respond(id, r));
      else if (answer !== undefined) this.respond(id, answer);
      return;
    }

    // A plain notification. An unknown method is handed to the caller rather than
    // ignored: the server's protocol is larger than what this client registers, and a
    // record nobody routed used to vanish without a log or an error — the same silent
    // hole Claude had, where 33 of its 39 record shapes were being dropped. A newer
    // server cannot crash us either way; the handler is still optional.
    if (handler) handler(msg.params || {});
    else this._onMessage?.(msg);
  }

  _handleExit(info) {
    if (this.dead) return;
    this.dead = true;
    this.isTurnRunning = false;
    const err = new Error(`Codex app-server exited (code ${info?.code ?? "?"})`);
    // The real error beats any deadline: a process that died must report as dead, not
    // as slow. `settle` clears each timer on the way through.
    for (const pending of [...this._pending.values()]) pending.settle(pending.reject, err);
    this._pending.clear();
    for (const fn of this._exitHandlers) fn(info);
  }

  close() {
    this.closed = true;
  }

  /**
   * Stop listening without treating the process's exit as ours.
   *
   * A restart swaps the server under a session that is staying: the old process's exit
   * IS the restart. Left wired, it would reject every in-flight request and fire the
   * exit handlers — reporting a death that did not happen.
   */
  detach() {
    this.closed = true;
    this.proc.onLine = null;
    this.proc.onExit = null;
    const err = new Error("Codex app-server was replaced");
    for (const pending of [...this._pending.values()]) pending.settle(pending.reject, err);
    this._pending.clear();
  }
}

const defaultEncodeResponse = (id, result) => ({ jsonrpc: "2.0", id, result });
const defaultEncodeError = (id, message) => ({ jsonrpc: "2.0", id, error: { code: -32601, message } });
const defaultEncodeNotification = (method, params) => ({ jsonrpc: "2.0", method, params });
const defaultEncodeRequest = (id, method, params) => ({ jsonrpc: "2.0", id, method, params });
const defaultDecodeResponse = (msg) => ({ id: msg.id ?? null, error: msg.error, result: msg.result });
const defaultId = (msg) => (msg.id === undefined ? null : msg.id);
const defaultMethod = (msg) => (typeof msg.method === "string" ? msg.method : null);
