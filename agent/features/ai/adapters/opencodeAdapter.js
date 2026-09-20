// Adapter for OpenCode server (opencode serve) over HTTP/SSE.
import { AgentProc } from "../proc/agentProc.js";
import { createLogger } from "../../../lib/logger.js";
import { stageAttachment, stagedPaths } from "../aiAttachment.js";
import * as opencodeServer from "../opencodeServer.js";
import { createOpencodeBusParser } from "../opencodeBus.js";

// The v2 prompt endpoint rejects an empty message; an attachment-only turn has no caption.
const ATTACHMENT_ONLY_PROMPT = "See the attached file.";

// Images must be passed as data: URLs; other files stay paths in the text.
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
    this.server = server || opencodeServer;
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    // Kept for adopt() compatibility; OpenCode server runs outside daemon.
    this.proc = proc || new AgentProc({ procId: "" });
    this.hostSessionId = hostSessionId;
    this.activeSessionId = sessionId || null;
    this.isTurnRunning = false;
    this.currentModel = model || "";
    this.currentVariant = "medium";
    this.permissionMode = "default";
    this.flags = [];
    this.stats = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTurns: 0 };
    // Empty model means CLI default; sent to server as real model id.
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

  // Set session model on server; model requires provider prefix.
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

  // Re-attach to running session on server after agent restart.
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
      }
    }
    return fetch;
  }

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

  handleEvent(envelope) {
    this._ensureParser();
    this.parser.handle(envelope);
  }

  _onBusEvent(event, data) {
    if (event === "turn_complete" || event === "error" || event === "tool_result") {
      logger.info(`[TEMP DIAGNOSTIC] oc bus ${event} subtype=${data?.subtype || "-"} turnRunning=${this.isTurnRunning} interrupted=${this._interrupted}`);
    }
    // Swallow error echo from an interrupt we initiated.
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

  // Interrupt current turn on server; session and context are preserved.
  interrupt() {
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
