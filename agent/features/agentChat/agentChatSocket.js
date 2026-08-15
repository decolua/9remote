// Socket surface for the terminal chat GUI: replay what the AI CLI is waiting on, and
// turn a button press back into keystrokes for the TUI.
//
// The TUI stays the only runtime. Nothing here starts, stops, or drives the AI CLI —
// it observes hook telemetry and types on the user's behalf.
import * as daemonClient from "../terminal/ptyDaemonClient.js";
import { readScreen as readMirror } from "../terminal/screenMirror.js";
import { getSnapshot, getPrompt, clearPrompt } from "./promptStore.js";
import { getMapping } from "../terminal/agentSessionMap.js";
import { planKeystrokes, screenMatchesPrompt, promptStillPresent, countVisibleOptions } from "./responder.js";
import { readTranscript } from "./transcriptReader.js";
import { EVENTS, KEYS, KEYSTROKE_GAP_MS, VERIFY_DELAY_MS, MAX_MESSAGE_LENGTH } from "./constants.js";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("agentChat");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Answering takes several awaits (read the screen, then space the keystrokes out). Two
// clients — or one impatient double-tap — could interleave and type two answers into one
// selector, so a pane admits a single answer at a time.
const answering = new Set();

// The PTY reaches us through the daemon in production; tests substitute their own pair.
const defaultIo = {
  write(sessions, sessionId, data) {
    const session = sessions.get(sessionId);
    if (!session) return false;
    if (session.daemon && daemonClient.isConnected()) {
      daemonClient.sendInput(sessionId, data);
      return true;
    }
    if (session.pty) {
      session.pty.write(data);
      return true;
    }
    return false;
  },
  // Read from the agent's own mirror of recent output, not from the daemon: querying the
  // daemon would need a new message type, and that bumps DAEMON_VERSION — which restarts
  // the daemon and kills every running terminal.
  readScreen: (sessionId) => readMirror(sessionId),
};

export function setupAgentChatHandlers(socket, sessions, io = defaultIo) {
  const writeToPty = (sessionId, data) => io.write(sessions, sessionId, data);
  const readScreen = (sessionId) => io.readScreen(sessionId);

  socket.on(EVENTS.SUBSCRIBE, async ({ sessionId } = {}, ack) => {
    if (!sessionId) return ack?.({ success: false, error: "no session" });
    const snapshot = getSnapshot(sessionId);
    const mapping = getMapping(sessionId);

    // How many options the menu really shows right now. The GUI builds its buttons from
    // this instead of assuming a fixed count — the plan menu differs between CLI builds.
    let optionCount = 0;
    if (snapshot.prompt) {
      const screen = await readScreen(sessionId);
      optionCount = countVisibleOptions(screen);
    }

    // The transcript is the real conversation — hooks carry tool calls but never the
    // assistant's prose. Fall back to the hook timeline while the file does not exist yet
    // (a fresh session takes seconds to flush its first line).
    const { rows } = readTranscript(mapping?.transcriptPath);
    const activity = rows.length ? rows : snapshot.activity;
    const source = rows.length ? "transcript" : "hooks";

    const kinds = activity.reduce((acc, e) => {
      const k = e.kind === "tool" ? `tool:${e.status}` : e.kind;
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    logger.debug(
      `subscribe ${sessionId} hasAgent=${!!mapping} source=${source} rows=${activity.length} ` +
      `${JSON.stringify(kinds)} prompt=${snapshot.prompt?.kind || "-"} options=${optionCount} ` +
      `transcript=${mapping?.transcriptPath || "-"}`
    );

    // hasAgent drives whether the pane even offers the GUI toggle.
    ack?.({
      success: true,
      hasAgent: !!mapping,
      tool: mapping?.tool || null,
      prompt: snapshot.prompt,
      activity,
      source,
      optionCount,
    });
  });

  socket.on(EVENTS.RESPOND, async ({ sessionId, promptId, choice } = {}, ack) => {
    if (!sessionId || !promptId || !choice) return ack?.({ success: false, error: "invalid request" });

    const prompt = getPrompt(sessionId);
    if (!prompt) return ack?.({ success: false, error: "no pending prompt" });
    // Two clients can hold the same card; only the one answering the CURRENT prompt wins.
    if (prompt.promptId !== promptId) return ack?.({ success: false, error: "prompt is out of date" });

    if (answering.has(sessionId)) return ack?.({ success: false, error: "another answer is in flight" });
    answering.add(sessionId);
    try {
      // Strict gate: the screen must still show the prompt we think we are answering.
      // Anything unclear refuses — a keystroke into a waiting CLI cannot be taken back.
      // Read first: a typed answer's row number is derived from what is actually on screen.
      const screen = await readScreen(sessionId);
      const gate = screenMatchesPrompt(screen, prompt, choice);

      const keys = planKeystrokes({
        kind: prompt.kind, choice, toolInput: prompt.toolInput, optionCount: gate.optionCount,
      });
      if (!keys) return ack?.({ success: false, error: "cannot map this choice to keystrokes" });
      if (!gate.ok) {
        // The screen wording is what the gate matches on, and it varies by CLI build —
        // log the tail so a refusal can be traced to the exact text that failed to match.
        const tail = String(screen || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").slice(-300);
        logger.debug(`respond REFUSED ${sessionId} kind=${prompt.kind} reason="${gate.reason}" options=${gate.optionCount}\n--- screen tail ---\n${tail}\n---`);
        return ack?.({ success: false, error: gate.reason || "screen changed", screenChanged: true });
      }
      logger.debug(`respond ok ${sessionId} kind=${prompt.kind} keys=${JSON.stringify(keys)} options=${gate.optionCount}`);

      // A nav key batched with Enter commits before the selector applies it — space them out.
      for (let i = 0; i < keys.length; i++) {
        // Re-check between keys: a multi-question answer takes a second to walk, and the
        // user can settle it in the TUI mid-sequence. The remaining keys would then land
        // in a shell prompt and run as commands.
        if (i > 0) {
          const still = await readScreen(sessionId);
          if (!promptStillPresent(still, prompt)) {
            logger.debug(`respond ABORTED ${sessionId} after ${i}/${keys.length} keys — selector left the screen`);
            return ack?.({ success: false, error: "the prompt was answered elsewhere", screenChanged: true });
          }
        }
        if (!writeToPty(sessionId, keys[i])) {
          return ack?.({ success: false, error: "session is not writable" });
        }
        if (i < keys.length - 1) await sleep(KEYSTROKE_GAP_MS);
      }
      ack?.({ success: true });
    } finally {
      // Released as soon as the keys are out. The confirm pass below only observes, and
      // holding the lock through it would block the answer to the NEXT prompt — which the
      // CLI can raise immediately after acting on this one.
      answering.delete(sessionId);
    }

    // Claude fires no hook after the user answers, so confirm by re-reading the screen.
    await sleep(VERIFY_DELAY_MS);
    // The pane can be closed, or moved on to another prompt, during that wait.
    if (!sessions.has(sessionId) || getPrompt(sessionId)?.promptId !== promptId) return;
    const after = await readScreen(sessionId);
    if (promptStillPresent(after, prompt)) {
      // Keep the card AND its id: the user's retry must still match the pending prompt.
      socket.emit(EVENTS.PROMPT, { sessionId, prompt, stale: true });
      return;
    }
    clearPrompt(sessionId);
    socket.emit(EVENTS.PROMPT_CLEARED, { sessionId });
  });

  socket.on(EVENTS.SEND_TEXT, ({ sessionId, text } = {}, ack) => {
    if (!sessionId || typeof text !== "string" || !text.trim()) {
      return ack?.({ success: false, error: "empty message" });
    }
    if (text.length > MAX_MESSAGE_LENGTH) return ack?.({ success: false, error: "message is too long" });
    // While the CLI is blocked on a choice, free text would be swallowed by the selector.
    if (getPrompt(sessionId)) return ack?.({ success: false, error: "answer the pending prompt first" });
    // Every newline in a paste would submit as its own command. Collapse them so the
    // message arrives as one input, and only the trailing Enter submits it.
    const oneLine = text.replace(/\r?\n/g, " ");
    const ok = writeToPty(sessionId, `${oneLine}${KEYS.ENTER}`);
    ack?.({ success: ok, ...(ok ? {} : { error: "session is not writable" }) });
  });

  socket.on(EVENTS.INTERRUPT, ({ sessionId } = {}, ack) => {
    if (!sessionId) return ack?.({ success: false, error: "no session" });
    const ok = writeToPty(sessionId, KEYS.INTERRUPT);
    ack?.({ success: ok });
  });
}
