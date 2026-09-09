// Represents a single active AI session (Claude, Codex, or OpenCode)
import { AI_ENGINES } from "./constants.js";
import { ClaudeAdapter } from "./adapters/claudeAdapter.js";
import { CodexAdapter } from "./adapters/codexAdapter.js";
import { OpenCodeAdapter } from "./adapters/opencodeAdapter.js";

export class AiSession {
  constructor({ id, engine, cwd, options = {}, onEvent }) {
    this.id = id;
    this.engine = engine;
    this.cwd = cwd || process.cwd();
    this.options = options;
    this.onEvent = onEvent;
    this.createdAt = Date.now();
    this.history = [];
    this.lastPrompt = "";
    this.adapter = null;

    if (!options.mock) {
      this.initAdapter();
    }
  }

  initAdapter() {
    const onEvent = (event, data) => this.emitNormalized(event, data);

    switch (this.engine) {
      case AI_ENGINES.CLAUDE:
        this.adapter = new ClaudeAdapter({ cwd: this.cwd, onEvent });
        this.adapter.start(this.options.mode || "default");
        break;
      case AI_ENGINES.CODEX:
        this.adapter = new CodexAdapter({ cwd: this.cwd, onEvent });
        if (this.options.model || this.options.effort || this.options.sandbox) {
          this.adapter.setOptions(this.options);
        }
        break;
      case AI_ENGINES.OPENCODE:
        this.adapter = new OpenCodeAdapter({ cwd: this.cwd, onEvent });
        if (this.options.model || this.options.variant) {
          this.adapter.setOptions(this.options);
        }
        break;
      default:
        throw new Error(`Unsupported engine: ${this.engine}`);
    }
  }

  emitNormalized(event, data) {
    this.history.push({ event, data, timestamp: Date.now() });
    if (this.history.length > 500) this.history.shift();
    this.onEvent?.(this.id, event, data);
  }

  sendPrompt(prompt) {
    this.lastPrompt = prompt;
    if (this.options.mock) {
      this.emitNormalized("delta", { text: `[Mock reply to: ${prompt}]` });
      this.emitNormalized("turn_complete", { stats: {} });
      return;
    }
    this.adapter?.sendPrompt(prompt);
  }

  resolvePermission(requestId, behavior, message) {
    this.adapter?.resolvePermission?.(requestId, behavior, message);
  }

  resolveQuestion(requestId, answers) {
    this.adapter?.resolveQuestion?.(requestId, answers);
  }

  setOptions(opts) {
    this.options = { ...this.options, ...opts };
    this.adapter?.setOptions?.(opts);
  }

  stop() {
    this.adapter?.stop();
    this.emitNormalized("stopped", {});
  }

  destroy() {
    this.stop();
  }
}
