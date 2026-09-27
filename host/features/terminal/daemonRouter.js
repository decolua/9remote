// The daemon's dispatcher: a domain route table plus a single-threaded queue.
//
// One daemon serves every terminal and every chat, so a message may not be handled
// while another handler is still working — two handlers interleaving on one session is
// exactly how a resize lands in the middle of a write. Everything goes through one
// queue and runs to completion in order.
//
// Coalescing is the other half: a drag sends dozens of resizes per second and only the
// last matters, so a marked route keeps one pending slot per session and overwrites it.
// Only idempotent routes may declare it (see daemonRoutes).
import { ROUTES, resolveRoute } from "./daemonRoutes.js";

const DEFAULT_TIMEOUT_MS = 5000;

// Sentinel for "the handler did not finish in time". A distinct object, not an error
// value a handler could legitimately return.
const TIMED_OUT = Symbol("handler-timeout");

export function createRouter({ deps = {}, send } = {}) {
  const routes = new Map();      // route key -> handler
  const specs = new Map();       // route key -> { reply, coalesce }
  const queue = [];
  let draining = false;
  // Keys whose handler is STILL running past its timeout. JavaScript cannot cancel a
  // running async function, so a timeout cannot undo the work in flight — the honest
  // guarantee is that a wedged handler never gets a second one running beside it on
  // the same session, which is what would break single-threading.
  const stuck = new Map();
  // Pending coalesced message per `${route}:${sessionId}` — last one wins, and its
  // position in the queue is the position of the FIRST of the burst, so ordering
  // against other routes (e.g. input typed after a resize) is preserved.
  const coalesced = new Map();

  function register(domain, handlers) {
    for (const [action, fn] of Object.entries(handlers)) {
      const key = `${domain}.${action}`;
      routes.set(key, fn);
      specs.set(key, ROUTES[key] || { reply: null, coalesce: null });
    }
  }

  // Every route the table promises must have a handler, or an agent waits out its
  // timeout for an answer that can never come. Asserted at boot, not on first use.
  function assertComplete() {
    const missing = Object.keys(ROUTES).filter((key) => !routes.has(key));
    if (missing.length) throw new Error(`Routes without a handler: ${missing.join(", ")}`);
  }

  // The thing a stuck handler is holding. It is the SESSION (or the process), not the
  // route: two handlers interleaving on one session is the hazard, whichever routes
  // they came in on.
  const resourceOf = (m) => m.sessionId || m.procId || "";

  function enqueue({ client, message }) {
    // The registered handlers decide what exists; the table only supplies the reply
    // shape, the alias and the coalescing rule. A name nobody registered is answered
    // at once — an unknown route has no queue position to hold.
    const name = message?.type;
    const key = resolveRoute(name) || name;
    if (!key || !routes.has(key)) {
      send(client, {
        type: "error",
        error: `Unknown route: ${name}`,
        requestId: message?.requestId
      });
      return;
    }
    const spec = specs.get(key) || { reply: null, coalesce: null };
    const slot = `${key}:${message.sessionId ?? ""}`;
    const resource = resourceOf(message);
    // A handler on this session is still running past its timeout. Refusing is the only
    // safe answer: queueing it would put two handlers on one session.
    if (resource && stuck.has(resource)) {
      send(client, {
        type: spec.reply || "error",
        success: false,
        error: "Previous request on this session is still running",
        requestId: message.requestId
      });
      return;
    }
    if (spec?.coalesce) {
      const pending = coalesced.get(slot);
      if (pending) {
        // Still queued — replace the payload in place, keeping the original position.
        pending.message = message;
        return;
      }
      const entry = { client, message, key, spec };
      coalesced.set(slot, entry);
      queue.push(entry);
    } else {
      queue.push({ client, message, key, spec });
    }
    drain();
  }

  async function drain() {
    if (draining) return;
    draining = true;
    // A microtask before the first message: enqueue is called from the socket's data
    // handler, and draining inline would let a handler re-enter that reader.
    await Promise.resolve();
    try {
      while (queue.length) {
        const entry = queue.shift();
        if (entry.spec?.coalesce) coalesced.delete(`${entry.key}:${entry.message.sessionId ?? ""}`);
        // Awaited: an async handler holds the queue, which is the whole point — a
        // resize must not run while the write before it is still in flight.
        await run(entry);
      }
    } finally {
      draining = false;
      // A message enqueued while draining (from a handler) starts a new pass.
      if (queue.length) drain();
    }
  }

  async function run({ client, message, key, spec }) {
    const handler = routes.get(key);
    const slot = `${key}:${message.sessionId ?? ""}`;
    const answer = (fields) => {
      if (!client) return;   // the caller is gone; there is nothing to answer into
      const failed = Boolean(fields?.error);
      // A fire-and-forget route stays silent on success — an ack per keystroke is pure
      // overhead. A FAILURE is different: the caller would otherwise watch its input
      // vanish with no reason given, so a failure is always reported.
      if (!spec?.reply && !failed) return;
      send(client, { type: spec?.reply || "error", ...fields, requestId: message.requestId });
    };
    let timer;
    // A wedged handler must not stall the daemon for good; the queue moves on and the
    // caller gets an answer it can act on instead of waiting out its own timeout.
    const expired = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), message.timeout || DEFAULT_TIMEOUT_MS);
      timer.unref?.();
    });
    // Wrapped so a synchronous throw becomes a rejection and takes the same path.
    const call = Promise.resolve().then(() => handler(message, deps, { client, answer }));
    try {
      const result = await Promise.race([call, expired]);
      if (result === TIMED_OUT) {
        // The handler keeps running — nothing can stop it. Keep the session locked until
        // it actually settles, and let it fail quietly rather than as an unhandled
        // rejection.
        const resource = resourceOf(message);
        if (resource) {
          stuck.set(resource, true);
          call.catch(() => {}).then(() => stuck.delete(resource));
        }
        answer({ success: false, error: "Handler timeout" });
        return;
      }
      answer(result || {});
    } catch (e) {
      answer({ success: false, error: e?.message || String(e) });
    } finally {
      clearTimeout(timer);
    }
  }

  return { register, assertComplete, enqueue };
}
