// Adapter for the OpenCode server: one shared `opencode serve`, spoken to over HTTP.
//
// The turn is no longer a CLI process (`opencode run` re-emitted the same bus at
// completion only — the pane watched a spinner until everything landed at once).
// The server's own event bus streams what its TUI renders: text and reasoning as
// deltas, a tool the moment its input starts forming. One server per machine
// (see opencodeServer.js — the rewind path already depends on it), every chat a
// session on it; the bus is machine-global, so envelopes are filtered by session.
//
// ponytail: no interactive permission card yet — no recording of permission on
// the v2 bus exists on this machine; wire it when one does. Out-of-workspace
// actions fail as tool errors until then.
import { AgentProc } from "../proc/agentProc.js";
import { createLogger } from "../../../lib/logger.js";
import { stageAttachment, stagedPaths } from "../aiAttachment.js";
import * as opencodeServer from "../opencodeServer.js";
import { createOpencodeBusParser } from "../opencodeBus.js";

// The v2 prompt endpoint rejects an empty message; an attachment-only turn has
// no caption, so it needs something to send.
const ATTACHMENT_ONLY_PROMPT = "See the attached file.";

// The prompt body the v2 protocol takes: {prompt: {text, files?}}. The v2 server
// does not read file paths — an image must ride as a data: URL or the model never
// sees it. Other files stay paths in the text (the model reads them itself), the
// same handover agy takes.
function buildPromptBody(promptText, staged) {
  const images = (staged || []).filter((a) => a.kind === "image");
  const text = [stagedPaths(staged), promptText].filter(Boolean).join(" ")
    || (images.length ? ATTACHMENT_ONLY_PROMPT : "");
  return {
    prompt: {
      text,
      ...(images.length
        ? { files: images.map((a) => ({ uri: `data:${a.mediaType};base64,${a.data}` })) }
        : {})
    }
  };
}

const logger = createLogger("ai");

export class OpenCodeAdapter {
  constructor({ cwd, onEvent, proc = null, sessionId = null, model = "", hostSessionId = null, server = null } = {}) {
    // The server module, injectable so a test can stand in for the real one.
    this.server = server || opencodeServer;
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    // The daemon carrier is kept for adopt() only: a chat reopened after an agent
    // restart still asks it for a process to reattach. This engine runs none —
    // the shared server outlives turns — so the answer is always "nothing alive".
    this.proc = proc || new AgentProc({ procId: "" });
    this.hostSessionId = hostSessionId;
    this.activeSessionId = sessionId || null;
    this.isTurnRunning = false;
    this.currentModel = model || "";
    this.currentVariant = "medium";
    this.permissionMode = "default";
    // Config-modal toggles, kept on metadata for the modal to read back. The run
    // mode they drove (--pure, --print-logs) is gone with the per-turn CLI; the
    // server has no equivalent to send.
    this.flags = [];
    this.stats = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTurns: 0 };
    // Empty model means "CLI default" — never a label: this value is sent to the
    // server as a real model id.
    this.metadata = { model: this.currentModel, sessionId: this.activeSessionId || "", permissionMode: this.permissionMode, variant: this.currentVariant };
    this.bus = null;         // {close} — the SSE subscription
    this.parser = null;      // bus envelopes → the pane's events
    this._interrupted = false;
  }

  setOptions({ model, variant, mode, resume, flags }) {
    let modelChanged = false;
    if (model) {
      this.currentModel = model;
      this.metadata.model = model;
      modelChanged = true;
    }
    if (variant) {
      this.currentVariant = variant;
      this.metadata.variant = variant;
      modelChanged = true;
    }
    if (modelChanged) this._applyModel();
    if (mode) {
      this.permissionMode = mode;
      this.metadata.permissionMode = mode;
    }
    if (resume && resume !== this.activeSessionId) {
      this.activeSessionId = resume;
      this.metadata.sessionId = resume;
    }
    if (flags && typeof flags === "object") {
      this.metadata.pure = Boolean(flags.pure);
      this.metadata.printLogs = Boolean(flags.printLogs);
    }
    this.onEvent?.("init", { ...this.metadata });
  }

  // Point the server's session at the chosen model/variant. A model id without a
  // provider prefix is not addressable on this API — the CLI's own config decides.
  // Resolves when the server has answered (or refused): a prompt sent before this
  // lands races the model pick and can run the machine's default instead.
  async _applyModel() {
    if (!this.activeSessionId || !this.currentModel) return;
    const parts = this.currentModel.split("/");
    if (parts.length < 2) return;
    try {
      await this.server.setSessionModel(this.activeSessionId, {
        id: parts.slice(1).join("/"),
        providerID: parts[0],
        ...(this.currentVariant ? { variant: this.currentVariant } : {})
      });
    } catch (e) {
      this.onEvent?.("error", { message: `Could not set the OpenCode model: ${e.message}` });
    }
  }

  // The CLI's own health command. Static so it resolves without spawning a process.
  static doctorSpec() {
    return { command: "opencode", args: ["debug", "info"] };
  }

  /**
   * Re-attach after an agent restart. The daemon has no process for this engine —
   * but the shared server may still be running this chat's turn from before the
   * restart. Adopt that too: subscribe the bus now and ask the server which
   * sessions are live, so the pane rejoins a running answer instead of showing
   * idle while the turn streams into nobody — and the next prompt steers into
   * it mid-flight.
   */
  async adopt(from = 0, epoch = null) {
    const f = typeof from === "object" && from !== null ? from.from ?? 0 : Number(from) || 0;
    const ep = typeof from === "object" && from !== null ? from.epoch ?? null : epoch ?? null;
    const fetch = await this.proc.attach(f, ep);
    if (this.activeSessionId) {
      this._ensureBus();
      try {
        const active = await this.server.activeSessions();
        const state = active?.[this.activeSessionId];
        if (state && state.type !== "idle") {
          this.isTurnRunning = true;
          logger.info(`[TEMP DIAGNOSTIC] oc adopt → turn still running on server (${this.activeSessionId})`);
        }
      } catch {
        // The server's own answer is a convenience; the bus subscription above
        // already carries the turn if one is running.
      }
    }
    return fetch;
  }

  /** Lines a daemon buffer might still hold from a pre-server turn. There are none. */
  feed() {}

  _ensureParser() {
    if (!this.parser) {
      this.parser = createOpencodeBusParser({
        onEvent: (event, data) => this._onBusEvent(event, data),
        stats: this.stats
      });
    }
  }

  _ensureBus() {
    if (this.bus) return;
    this._ensureParser();
    this.bus = this.server.subscribeBus((envelope) => {
      const data = envelope?.data;
      if (!data || data.sessionID !== this.activeSessionId) return;
      // The model the server actually runs is worth the chip even when it was
      // picked outside this pane (a resumed chat, the TUI beside it).
      if (envelope.type === "session.next.step.started" && data.model?.id) {
        const full = data.model.providerID ? `${data.model.providerID}/${data.model.id}` : data.model.id;
        if (full !== this.metadata.model) {
          this.metadata.model = full;
          this.currentModel = full;
          this.onEvent?.("init", { ...this.metadata });
        }
      }
      this.parser.handle(envelope);
    });
  }

  /** One bus envelope by hand — the test door for recorded turns. */
  handleEvent(envelope) {
    this._ensureParser();
    this.parser.handle(envelope);
  }

  _onBusEvent(event, data) {
    // TEMP DIAGNOSTIC (esc-stop): the turn's own edges, as the server bus told them.
    if (event === "turn_complete" || event === "error" || event === "tool_result") {
      logger.info(`[TEMP DIAGNOSTIC] oc bus ${event} subtype=${data?.subtype || "-"} turnRunning=${this.isTurnRunning} interrupted=${this._interrupted}`);
    }
    // The echo of a stop WE asked for is not a failure — the pane drew `stopped`
    // when the interrupt went out, and this error would paint a crash over it.
    // Consumed silently: interrupt() already ended the turn, and a turn_complete
    // here could land on the NEXT turn's watch and kill its running flag.
    if (event === "error" && this._interrupted) {
      this._interrupted = false;
      this.isTurnRunning = false;
      logger.info("[TEMP DIAGNOSTIC] oc bus swallowed interrupted echo");
      return;
    }
    if (event === "turn_complete" || event === "error") this.isTurnRunning = false;
    this.onEvent?.(event, data);
  }

  sendPrompt(promptText, attachments = null) {
    if (this.isTurnRunning) {
      throw new Error("OpenCode turn is already running.");
    }
    this.isTurnRunning = true;
    this._interrupted = false;
    const staged = attachments?.length ? attachments.map(stageAttachment) : null;
    Promise.resolve().then(async () => {
      if (!this.activeSessionId) {
        const session = await this.server.createSession(this.cwd);
        if (this._interrupted) return;
        if (!session?.id) throw new Error("The opencode server created no session.");
        this.activeSessionId = session.id;
        this.metadata.sessionId = session.id;
        this.onEvent?.("init", { ...this.metadata });
      }
      if (this._interrupted) return;
      await this._applyModel();
      if (this._interrupted) return;
      this._ensureBus();
      await this.server.prompt(this.activeSessionId, buildPromptBody(promptText, staged));
    }).catch((e) => {
      this.isTurnRunning = false;
      if (!this._interrupted) {
        this.onEvent?.("error", { message: e.message });
      }
    });
  }

  /**
   * End the TURN, not the conversation: the server keeps the session and its
   * context, so the next prompt resumes where this one stopped.
   *
   * The turn ends HERE, not on a bus echo: a turn hung in its LLM call never
   * settles on the bus (measured — interrupt POST 204, then not one settle
   * event), and waiting for it left isTurnRunning stuck true so every later
   * prompt was refused. The flag only stays to swallow the late "interrupted"
   * error echo, if one ever arrives.
   */
  interrupt() {
    // TEMP DIAGNOSTIC (esc-stop)
    logger.info(`[TEMP DIAGNOSTIC] oc interrupt turnRunning=${this.isTurnRunning} session=${this.activeSessionId || "-"}`);
    if (!this.isTurnRunning) return false;
    this._interrupted = true;
    this.isTurnRunning = false;
    if (this.activeSessionId) {
      this.server.interruptSession(this.activeSessionId)
        .then(() => logger.info("[TEMP DIAGNOSTIC] oc interrupt POST ok"))
        .catch((e) => logger.warn(`[TEMP DIAGNOSTIC] oc interrupt POST refused: ${e.message}`));
    }
    return true;
  }

  /** The fallback AiSession.stop reaches for. There is no process to signal. */
  signal(sig) {
    return this.interrupt();
  }

  stop() {
    this.isTurnRunning = false;
    this.bus?.close();
    this.bus = null;
    this.parser = null;
    if (this.activeSessionId) this.server.interruptSession(this.activeSessionId).catch(() => {});
    return Promise.resolve();
  }
}
