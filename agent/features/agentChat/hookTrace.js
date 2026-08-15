// Ring buffer of the most recent hook calls, exposed at /api/notify/debug.
//
// The chat GUI is driven entirely by hooks fired by another process. When something is
// missing from the transcript the first question is always "did the hook even arrive, and
// what did it carry?" — this answers it without reading log files or attaching a proxy.
const MAX_ENTRIES = 50;
const MAX_BODY_CHARS = 2_000;

const entries = [];
let seq = 0;

const clip = (s) => (typeof s === "string" && s.length > MAX_BODY_CHARS ? `${s.slice(0, MAX_BODY_CHARS)}…[${s.length}]` : s);

/** Record one inbound hook call, plus what we decided to do with it. */
export function traceHook({ method, query, rawBody, parsed, outcome, detail }) {
  entries.push({
    n: ++seq,
    at: new Date().toISOString(),
    method,
    query: query || null,
    // Raw body first: an empty body here is the single most common failure, and it is
    // invisible once the payload has been parsed away.
    rawBodyLength: typeof rawBody === "string" ? rawBody.length : 0,
    rawBody: clip(rawBody),
    parsed: parsed
      ? {
          event: parsed.event,
          sessionId: parsed.sessionId,
          tool: parsed.tool,
          type: parsed.type,
          launchToken: parsed.launchToken,
          toolName: parsed.payload?.tool_name ?? null,
          promptChars: typeof parsed.payload?.prompt === "string" ? parsed.payload.prompt.length : null,
          payloadKeys: parsed.payload ? Object.keys(parsed.payload) : null,
        }
      : null,
    outcome,
    detail: detail || null,
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function getHookTrace() {
  return entries.slice().reverse(); // newest first — that is what you are looking for
}

export function clearHookTrace() {
  entries.length = 0;
}
