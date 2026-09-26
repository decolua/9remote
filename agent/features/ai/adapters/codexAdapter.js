// Adapter for the OpenAI Codex CLI.
import { getExtendedEnv } from "./env.js";
import { stageAttachment, buildAttachedPrompt } from "../aiAttachment.js";
import { AgentProc } from "../proc/agentProc.js";
import { DaemonProc } from "../proc/daemonProc.js";
import { LocalProc } from "../proc/localProc.js";
import * as daemonClient from "../../terminal/ptyDaemonClient.js";
import { readCodexFileChanges, readCodexParsedCommands } from "../transcript.js";
import { codexItemEvents, isCodexFileChange, isCodexToolItem } from "../codexItems.js";
import { CodexAppServer } from "../proc/codexAppServer.js";
import { spawnArgsFor, BLOCKED_TEXT_RE, MODE_LABELS, nextModeUp } from "../codexSettings.js";
import { createLogger } from "../../../lib/logger.js";

const logger = createLogger("ai");

// Composer mode → codex sandbox policy (codex has no single mode flag); mirrors the TUI presets.
const MODE_TO_SANDBOX = {
  readOnly: "read-only",
  default: "workspace-write",
  fullAccess: "danger-full-access"
};

// Plan is a collaboration mode, not a sandbox — the gate stays; writes stay blocked by the sandbox.
const PLAN_MODE_ARG = ["-c", 'collaboration_mode="plan"'];

export class CodexAdapter {
  constructor({ cwd, onEvent, proc = null, threadId = null, model = "", hostSessionId = null, transport = null } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.hostSessionId = hostSessionId;
    // app-server (one process, two-way JSON-RPC) is the default; `NREMOTE_CODEX_TRANSPORT=exec` is the fallback — anything but exactly "exec" keeps the default.
    const asked = transport || process.env.NREMOTE_CODEX_TRANSPORT;
    this.transport = asked === "exec" ? "exec" : "app-server";
    this.appServer = null;
    this._restarting = false;
    // Prompts that arrived while the server was being replaced; drained once it is up.
    this._heldPrompts = [];
    // One prompt held while OUR interrupt is landing — sister of `_heldPrompts`, same one-deep patience.
    this._pendingAfterStop = null;
    // An injected proc is the caller's (a test's); the transport's own carrier is chosen lazily in start().
    this._procOverride = proc;
    this.proc = proc || new AgentProc({ procId: "" });
    this.activeThreadId = threadId || null;
    this.isTurnRunning = false;
    this.currentModel = model || "";
    this.reasoningEffort = "xhigh";
    this.sandboxMode = "workspace-write";
    // The composer sends `mode` — dropped here, every turn ran the default policy.
    this.permissionMode = "default";
    // Plan-mode reasoning is codex's own knob; empty falls back to the CLI default.
    this.planEffort = "";
    // Codex's own persona for the assistant's tone: friendly | pragmatic | none.
    this.personality = "";
    // Sandbox tuning the TUI exposes but the sandbox policy string does not carry.
    this.networkAccess = false;
    this.addDirs = [];
    this.skipGitRepoCheck = false;
    this.ephemeral = false;
    // Feature flags (`/experimental`, `--enable` / `--disable`).
    this.enable = [];
    this.disable = [];
    this.planMode = false;
    this.stats = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, totalTurns: 0 };
    // Empty model means CLI default — metadata is later fed to `-m`, a display string would 404.
    // The Config modal reads its values back from here — every settable option must be present or reopening reverts it.
    this.metadata = { model: this.currentModel, sandbox: this.sandboxMode, permissionMode: this.permissionMode, planMode: false, effort: this.reasoningEffort, planEffort: this.planEffort, personality: this.personality, networkAccess: this.networkAccess, addDirs: this.addDirs, enable: this.enable, disable: this.disable, skipGitRepoCheck: this.skipGitRepoCheck, ephemeral: this.ephemeral };
    this.setThreadId(this.activeThreadId);
  }

  // Publish the thread id under both names: `threadId` for the goal RPC, `sessionId` for the shared consumer.
  setThreadId(id) {
    this.activeThreadId = id || null;
    this.metadata.threadId = this.metadata.sessionId = id || "";
  }

  setOptions({ model, effort, planEffort, sandbox, mode, resume, personality, networkAccess, addDirs, enable, disable, skipGitRepoCheck, ephemeral }) {
    // Read before writing: feature flags live on the PROCESS — change is only visible by comparison.
    const featuresBefore = `${this.enable.join(",")}|${this.disable.join(",")}`;
    if (model) {
      this.currentModel = model;
      this.metadata.model = model;
    }
    if (effort) {
      this.reasoningEffort = effort;
      this.metadata.effort = effort;
    }
    // Empty string is a real choice (CLI default), unlike fields where empty means not sent.
    if (typeof planEffort === "string") {
      this.planEffort = planEffort;
      this.metadata.planEffort = planEffort;
    }
    if (mode && MODE_LABELS[mode]) {
      this.permissionMode = mode;
      this.metadata.permissionMode = mode;
      // Plan keeps whatever sandbox the session had — the two are independent axes.
      this.planMode = mode === "plan";
      this.metadata.planMode = this.planMode;
      const sandbox = MODE_TO_SANDBOX[mode];
      if (sandbox) {
        this.sandboxMode = sandbox;
        this.metadata.sandbox = sandbox;
      }
    }
    if (sandbox) {
      this.sandboxMode = sandbox;
      this.metadata.sandbox = sandbox;
    }
    if (typeof personality === "string") {
      this.personality = personality;
      this.metadata.personality = personality;
    }
    if (typeof networkAccess === "boolean") {
      this.networkAccess = networkAccess;
      this.metadata.networkAccess = networkAccess;
    }
    if (Array.isArray(addDirs)) {
      this.addDirs = addDirs.filter((d) => typeof d === "string" && d);
      this.metadata.addDirs = this.addDirs;
    }
    if (typeof skipGitRepoCheck === "boolean") {
      this.skipGitRepoCheck = skipGitRepoCheck;
      this.metadata.skipGitRepoCheck = skipGitRepoCheck;
    }
    if (typeof ephemeral === "boolean") {
      this.ephemeral = ephemeral;
      this.metadata.ephemeral = ephemeral;
    }
    if (Array.isArray(enable)) {
      this.enable = enable.filter((f) => typeof f === "string" && f);
      this.metadata.enable = this.enable;
    }
    if (Array.isArray(disable)) {
      this.disable = disable.filter((f) => typeof f === "string" && f);
      this.metadata.disable = this.disable;
    }
    // Resume a past thread: the next turn runs `codex exec resume <id>`.
    if (resume) this.setThreadId(resume);
    this._syncAppServer(`${this.enable.join(",")}|${this.disable.join(",")}` !== featuresBefore);
    this.onEvent?.("init", { ...this.metadata });
  }

  /** Request fields apply on the spot; feature flags only work at spawn (probed), so they respawn the server — never mid-turn. */
  _syncAppServer(featuresChanged) {
    if (!this.appServer || this.isTurnRunning) return;

    const changed = this.appServer.applyOptions({
      mode: this.permissionMode,
      networkAccess: this.networkAccess,
      addDirs: this.addDirs,
      planMode: this.planMode,
      planEffort: this.planEffort,
      model: this.currentModel,
      effort: this.reasoningEffort,
      personality: this.personality
    });
    // Fire and forget: a failed settings call must not take the turn's options; turn/start repeats them.
    this.appServer.updateSettings(changed).catch(() => {});

    if (featuresChanged) this.restart().catch(() => {});
  }

  /** Respawn keeping the thread; `appServer` stays until the replacement exists or sendPrompt falls through to exec — a second writer. */
  async restart() {
    if (!this.persistent || this._restarting) return;
    this._restarting = true;
    const threadId = this.activeThreadId;
    const previous = this.appServer;
    try {
      previous?.detach();
      // Stop the carrier this chat's server actually runs on (not `this.proc`, exec's) — even when injected, or two codex processes share one thread.
      const carrier = this._activeCarrier();
      this._appServerProc = null;
      await carrier?.stop();
      await this.start(this.permissionMode, threadId);
    } finally {
      this._restarting = false;
      // Replayed in order, through the normal path so each one is staged the same way
      // it would have been. A restart takes a moment; a prompt typed during it must not
      // vanish.
      const held = this._heldPrompts;
      this._heldPrompts = [];
      for (const p of held) {
        try { this.sendPrompt(p.prompt, p.attachments); }
        catch (err) { this.onEvent?.("error", { message: err.message }); }
      }
    }
  }

  // The CLI's own health command. Static so it resolves without spawning a process.
  static doctorSpec() {
    return { command: "codex", args: ["doctor"] };
  }

  /** True for a one-process-per-chat transport — aiSession starts those eagerly, leaves turn-per-CLI alone. */
  get persistent() {
    return this.transport === "app-server";
  }

  /** AgentProc is read-only (exec's); the app-server needs this two-way carrier — ONE accessor so restart()/stop() stop the real one. */
  _carrierFor() {
    if (this._procOverride) return this._procOverride;
    if (!this._appServerProc) this._appServerProc = new LocalProc();
    return this._appServerProc;
  }

  /** The carrier this chat's server was actually started on, for stopping it. */
  _activeCarrier() {
    return this._procOverride || this._appServerProc || null;
  }

  /** Spawn the app-server and open (or rejoin) a thread; exec falls through with nothing fetched. */
  async start(mode = "default", resumeSessionId = null) {
    if (!this.persistent) return null;
    if (resumeSessionId) this.setThreadId(resumeSessionId);

    const diag = (msg) => logger.info(`[codex-adapter] ${msg}`);
    diag(`start begin transport=${this.transport} mode=${mode} resume=${resumeSessionId} managed=${daemonClient.isConnected()}`);

    this.permissionMode = mode || this.permissionMode;
    // ONE carrier for spawn and session — `this.proc` is exec's AgentProc and never ran this chat.
    const carrier = this._carrierFor();
    this.appServer = new CodexAppServer({
      proc: carrier,
      cwd: this.cwd,
      onEvent: (ev, data) => this._forward(ev, data),
      // The interrupt's landing never reaches this adapter as an event — flag release and the held prompt hang off this.
      onInterruptSettled: () => {
        this.isTurnRunning = false;
        this._flushPendingAfterStop();
      },
      threadId: this.activeThreadId,
      model: this.currentModel,
      effort: this.reasoningEffort,
      personality: this.personality || null
    });
    // Options set BEFORE the handshake — a Plan chat opens its thread in Plan; the session keeps them itself.
    this.appServer.applyOptions({
      mode: this.permissionMode,
      networkAccess: this.networkAccess,
      addDirs: this.addDirs,
      planMode: this.planMode,
      planEffort: this.planEffort,
      model: this.currentModel,
      effort: this.reasoningEffort,
      personality: this.personality
    });

    // `-c features.X=true` is the only way to enable a feature (probed) — flags own the process.
    const started = await carrier.start({
      bin: "codex",
      args: ["app-server", ...spawnArgsFor({ enable: this.enable, disable: this.disable, skipGitRepoCheck: this.skipGitRepoCheck })],
      cwd: this.cwd,
      env: getExtendedEnv({ hostSessionId: this.hostSessionId }),
      keepStdin: true
    }).then(
      (r) => { diag(`carrier started (${carrier.constructor.name})`); return r; },
      (err) => { diag(`carrier start FAILED: ${err.message}`); throw err; }
    );

    // commit is not optional: DaemonProc holds the spawn's lines until released — skip it and the handshake starves; the feed is protocol envelopes for the RPC client, not this parser.
    started?.commit?.((line) => this.appServer?.rpc?.feed(line));
    diag("carrier committed");

    const threadId = await this.appServer.start().then(
      (id) => { diag(`handshake OK thread=${id}`); return id; },
      (err) => { diag(`handshake FAILED: ${err.message}`); throw err; }
    );
    this.setThreadId(threadId);
    this._bind();
    this.onEvent?.("init", { ...this.metadata, permissionMode: this.permissionMode });
    return null;
  }

  /** Events raised by the app-server session, plus the bookkeeping the session reads. */
  _forward(ev, data) {
    if (ev === "stats") Object.assign(this.stats, data);
    if (ev === "turn_complete" || ev === "error") this.isTurnRunning = false;
    if (ev === "tool_start" || ev === "thinking" || ev === "delta") this.isTurnRunning = true;
    this.onEvent?.(ev, ev === "turn_complete" ? { stats: this.stats, ...data } : data);
  }

  /** Re-attach to the daemon's turn; one that ended unwatched replays from the daemon's buffer. */
  async adopt(from = 0, epoch = null) {
    if (this.persistent) {
      // The app-server session cannot cross process boundaries — stop the orphan and resume the thread via start().
      const f = typeof from === "object" && from !== null ? from.from ?? 0 : Number(from) || 0;
      const ep = typeof from === "object" && from !== null ? from.epoch ?? null : epoch ?? null;
      const fetch = await this.proc.attach(f, ep);
      if (fetch?.alive) {
        await this.proc.stop();
      }
      this.isTurnRunning = false;
      return { alive: false, lines: [] };
    }
    const f = typeof from === "object" && from !== null ? from.from ?? 0 : Number(from) || 0;
    const ep = typeof from === "object" && from !== null ? from.epoch ?? null : epoch ?? null;
    const fetch = await this.proc.attach(f, ep);
    if (!fetch.lines?.length && !fetch.alive) return fetch;
    this._bind();
    // The turn's process is the turn: while it lives, the chat is still working.
    this.isTurnRunning = fetch.alive;
    this.fetched = fetch;
    return fetch;
  }

  // Idempotent — the same process can carry a later turn.
  _bind() {
    // The app-server owns the pipe and the exit hook — re-pointing either leaves a dead server looking alive.
    if (this.persistent) return;
    this.proc.onLine = (line) => this.feed(line);
    this.proc.onExit = ({ code, error }) => {
      this.isTurnRunning = false;
      if (error) this.onEvent?.("error", { message: error });
      // A nonzero exit is news: without isError the row never draws and the pane reads a crash as a clean finish.
      else this.onEvent?.("turn_complete", { stats: this.stats, exitCode: code, isError: code != null && code !== 0, result: code != null && code !== 0 ? `Codex exited (code ${code}).` : "", subtype: "exit" });
    };
  }

  feed(line) {
    if (!String(line).trim()) return;
    try {
      this.handleEvent(JSON.parse(line));
    } catch {
      this.onEvent?.("ansi", { chunk: line + "\r\n" });
    }
  }

  // Options that mean the same argv token on a fresh exec and on a resumed one.
  pushSharedArgs(args, images = []) {
    // `--image=` is a flag, so it rides before the positional prompt in both branches.
    for (const image of images) args.push(`--image=${image}`);
    if (this.personality) args.push("-c", `personality="${this.personality}"`);
    // Network access is a sandbox sub-setting, not part of the policy string.
    if (this.networkAccess) args.push("-c", "sandbox_workspace_write.network_access=true");
    for (const dir of this.addDirs) args.push("--add-dir", dir);
    for (const f of this.enable) args.push("--enable", f);
    for (const f of this.disable) args.push("--disable", f);
    if (this.skipGitRepoCheck) args.push("--skip-git-repo-check");
    if (this.ephemeral) args.push("--ephemeral");
  }

  // Split from sendPrompt so the flags stay testable without spawning a CLI.
  buildArgs(prompt, images = []) {
    const args = ["exec"];
    // `-s danger-full-access` alone still stops at the approval gate — the bypass flag rides along.
    const bypass = this.permissionMode === "fullAccess";

    if (this.activeThreadId) {
      // `exec resume` rejects `-s` (verified) — typed flags go through `-c` overrides instead.
      args.push("resume", "--json");
      if (this.currentModel) args.push("-m", this.currentModel);
      if (this.reasoningEffort) args.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
      if (this.planMode) args.push(...PLAN_MODE_ARG);
      if (this.planEffort) args.push("-c", `plan_mode_reasoning_effort="${this.planEffort}"`);
      if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
      else if (this.sandboxMode) args.push("-c", `sandbox_mode="${this.sandboxMode}"`);
      this.pushSharedArgs(args, images);
      args.push(this.activeThreadId, prompt);
      return args;
    }

    args.push("--json");
    if (this.currentModel) args.push("-m", this.currentModel);
    if (this.reasoningEffort) args.push("-c", `model_reasoning_effort="${this.reasoningEffort}"`);
    if (this.planMode) args.push(...PLAN_MODE_ARG);
    if (this.planEffort) args.push("-c", `plan_mode_reasoning_effort="${this.planEffort}"`);
    if (bypass) args.push("--dangerously-bypass-approvals-and-sandbox");
    else if (this.sandboxMode) args.push("-s", this.sandboxMode);
    this.pushSharedArgs(args, images);
    args.push(prompt);
    return args;
  }

  /** Send the prompt held through the stop window, once that window has closed. */
  _flushPendingAfterStop() {
    const held = this._pendingAfterStop;
    this._pendingAfterStop = null;
    if (!held) return;
    // A throw here has no caller — it becomes the pane's error, not an unhandled rejection.
    try { this.sendPrompt(held.prompt, held.attachments); }
    catch (err) { this.onEvent?.("error", { message: err.message }); }
  }

  sendPrompt(prompt, attachments = null) {
    if (this.isTurnRunning) {
      // Held for the stop window, not refused — the client drains its queue before the server finished stopping.
      if (this.persistent && this.appServer?.interrupting && !this._pendingAfterStop) {
        // Raw: the flush re-enters sendPrompt, which stages — staging here too would stage twice.
        this._pendingAfterStop = { prompt, attachments: attachments?.length ? attachments : null };
        return;
      }
      throw new Error("Codex turn is already running.");
    }
    // Held, not chained: a chain link that re-runs this method spins microtasks while the restart is in flight (exec here would be a second writer).
    if (this.persistent && (!this.appServer || this._restarting)) {
      this._heldPrompts.push({ prompt, attachments });
      return;
    }

    const staged = attachments?.length ? attachments.map(stageAttachment) : null;

    // The server carries the mode/sandbox it was opened with.
    if (this.persistent && this.appServer) {
      this.isTurnRunning = true;
      // `/review` routes to review/start inside app-server; exec sends it as prose — honest for a CLI with no review RPC.
      // Attachments ride as `localImage` entries; a file is named in the text (the server takes no file input).
      this.appServer.sendPrompt(prompt, staged).catch((err) => {
        this.isTurnRunning = false;
        this.onEvent?.("error", { message: err.message });
      });
      return;
    }

    // Images ride as `--image=` files; other files and the caption join the text (both exec forms take the flag).
    const images = (staged || []).filter((a) => a.kind === "image").map((a) => a.path);
    this.isTurnRunning = true;
    this._bind();
    const args = this.buildArgs(buildAttachedPrompt(prompt, staged), images);

    this.proc.start({
      bin: "codex",
      args,
      cwd: this.cwd,
      env: getExtendedEnv({ hostSessionId: this.hostSessionId })
    }).then(
      // commit feeds lines printed before handlers were live, then closes stdin — codex exec blocks on a pipe nobody closes.
      (started) => started.commit((line) => this.feed(line)),
      // A missing binary or a daemon that refused the start reports here.
      (err) => {
        this.isTurnRunning = false;
        this.onEvent?.("error", { message: err.message });
      }
    );
  }

  handleEvent(event) {
    const type = event.type;
    if (type === "thread.started") {
      this.setThreadId(event.thread_id);
      this.onEvent?.("init", { ...this.metadata });
      return;
    }

    // ONE shared mapping (codexItems.js) opens and closes cards — a replayed card and a live one are the same object.
    if (type === "item.started" || type === "item.completed") {
      const item = event.item;
      if (!isCodexToolItem(item?.type)) {
        if (type !== "item.completed") return;
        if (item?.type === "reasoning") this.onEvent?.("thinking", { text: item.text || "" });
        else if (item?.type === "agent_message") {
          this.onEvent?.("delta", { text: item.text || "" });
          // A refusal under a narrow sandbox arrives only as prose. Surface it as a
          // card that offers the mode that would allow the action.
          if (item.text && BLOCKED_TEXT_RE.test(item.text)) {
            const next = nextModeUp(this.permissionMode);
            if (next) {
              this.onEvent?.("blocked", {
                engine: "codex",
                message: item.text,
                escalate: { mode: next, label: MODE_LABELS[next] }
              });
            }
          }
          // Codex gates request_user_input on the PLAN collaboration mode — Full Access
          // is a sandbox axis and never unlocks it. The harness refuses the call with no
          // tool item, so the model's prose quoting the error is the only visible trace.
          if (item.text && /request_user_input is unavailable/i.test(item.text)) {
            this.onEvent?.("blocked", {
              engine: "codex",
              message: "The ask-user tool only exists in Codex Plan mode. Full Access governs the sandbox — switch to Plan to let the agent ask questions.",
              escalate: { mode: "plan", label: MODE_LABELS.plan }
            });
          }
        } else if (item?.type === "web_search") {
          this.onEvent?.("tool_result", { id: item.id, name: "web_search", output: item.query || "", status: "done" });
        }
        return;
      }
      // A file_change takes its patch from the rollout, which holds it and is on disk
      // before the CLI prints the matching item. Read once per change, not per file.
      // Gated on the ROLE, not on a spelling: the live stream names it `file_change` and
      // the rollout `FileChange`, and testing one literal left the live card with no patch
      // — an empty row reading "Running or no output returned…".
      const recorded =
        type === "item.completed" && isCodexFileChange(item)
          ? readCodexFileChanges(this.cwd, this.activeThreadId)
          : null;
      // `parsed_cmd` is missing from the live stream on every command item, so the same
      // read from the rollout puts the name back — without it a live turn is all
      // "command" while the reopened chat names each one. Looked up on `item.started`,
      // which is the event that opens the card and the only one whose name is kept.
      const parsed =
        type === "item.started" && item?.id
          ? readCodexParsedCommands(this.cwd, this.activeThreadId)?.[item.id]
          : null;
      // The envelope IS the status here: the live stream spells it as two event types and
      // puts no status on the item, while the rollout has only the completed one. Handed
      // over so the shared mapper reads one field either way.
      const status = type === "item.completed" ? "completed" : "started";
      const enriched = parsed ? { ...item, parsed_cmd: parsed } : item;
      for (const ev of codexItemEvents({ item: enriched, status }, recorded)) this.onEvent?.(ev.event, ev.data);
      return;
    }

    if (type === "turn.completed" && event.usage) {
      // A resume resends the whole conversation, so this number grows with the thread
      // rather than counting one turn: measured 14067 on a fresh run, 28142 on the
      // resumed one. Assign it — adding would count the earlier turns twice.
      // input_tokens includes the cached part, so it IS the window's current fill.
      this.stats.inputTokens = event.usage.input_tokens || 0;
      this.stats.outputTokens = event.usage.output_tokens || 0;
      this.stats.cachedTokens = event.usage.cached_input_tokens || 0;
      this.stats.reasoningTokens = event.usage.reasoning_output_tokens || 0;
      this.stats.totalTurns += 1;
      this.onEvent?.("stats", { stats: this.stats });
      return;
    }

    // Nothing above claimed it. The pane is a re-render of the CLI's own TUI, so a record
    // this adapter does not know yet still has to REACH it — under its own name, whole —
    // or the pane quietly shows less than the CLI said and nobody ever finds out. Every
    // branch above returns, so reaching here means no branch wanted it.
    this.onEvent?.("cli_event", { type: type || "", subtype: "", record: event });
  }

  /**
   * The gates the server is holding right now, keyed by the id an answer must carry.
   * `aiSession.pendingPermission()` reads this to bring a card back after a replay —
   * without it a reopened chat shows a CLI waiting on an answer nobody can see.
   */
  get pendingRequests() {
    return this.appServer?.gates || new Map();
  }

  /** Answer a gate. `false` when it is no longer waiting, so the card stays put. */
  resolvePermission(requestId, behavior, message = "") {
    if (!this.appServer) return false;
    return this.appServer.resolvePermission(requestId, behavior, message);
  }

  /** Rename the running thread in codex's own store; `false` before the app-server boots. */
  async renameThread(name) {
    return Boolean(this.appServer && await this.appServer.setName(name));
  }

  /**
   * Answer a question the CLI is blocking on. Only the app-server can ask one (the exec
   * transport has no way to), so a chat on that transport has nothing to answer — the
   * `false` that comes back is the honest answer, and it keeps the card on screen.
   */
  resolveQuestion(requestId, answers) {
    if (!this.appServer) return false;
    return this.appServer.resolveQuestion(requestId, answers);
  }

  /**
   * End the TURN, not the chat — what Stop/Esc means. Returns whether anything was
   * actually stopped, because the caller reports that to the user.
   *
   * This adapter had no `interrupt` at all, so `AiSession.stop()` found nothing to call,
   * fell through to a `signal` that also did not exist, and emitted `stopped` anyway: the
   * pane cleared its turn flag while the CLI kept running, and every later prompt queued
   * behind a turn that had never ended. Both transports are covered here — the app-server
   * holds the turn in a thread and takes its own `turn/interrupt` (the CLI ends the turn
   * and keeps the conversation), while `exec` IS the turn's process, so ending it is
   * ending the turn.
   */
  interrupt() {
    // TEMP DIAGNOSTIC (esc-stop)
    logger.info(`[TEMP DIAGNOSTIC] codex interrupt persistent=${this.persistent} thread=${this.activeThreadId || "-"} turn=${this.appServer?.turnId || "-"} transport=${this.transport || "-"}`);
    if (this.persistent) {
      // The server's own answer, not a guess: it needs BOTH the thread and the open turn,
      // and only it knows whether a turn is really running. Returning `true` off a thread
      // id alone was the same lie one layer down — `AiSession.stop` would report a turn
      // stopped and clear the pane's flag over a CLI that never heard anything.
      const willInterrupt = Boolean(this.appServer?.threadId && this.appServer?.turnId && !this.appServer?.closed);
      if (!willInterrupt) {
        this.isTurnRunning = false;
        if (this.appServer) this.appServer.isTurnRunning = false;
      }
      return Boolean(this.appServer?.interrupt());
    }
    this.isTurnRunning = false;
    // Not awaited: `stop()` is reached from a synchronous path. The rejection is caught
    // because a carrier that is already gone is the ordinary case here, not a failure.
    Promise.resolve(this.proc?.stop()).catch(() => {});
    return true;
  }

  /**
   * Last resort when `interrupt()` could not be written — a SIGINT to whatever is running
   * this chat. Only some carriers can take one (`AgentProc`, which exec runs on, has no
   * `signal` at all), so this reports whether the signal went out rather than assuming it.
   */
  signal(sig = "SIGINT") {
    const carrier = this.persistent ? this._activeCarrier() : this.proc;
    if (typeof carrier?.signal !== "function") return false;
    try {
      carrier.signal(sig);
      this.isTurnRunning = false;
      if (this.appServer) this.appServer.isTurnRunning = false;
      return true;
    } catch { return false; }
  }

  /**
   * End this chat's server and return when it is actually gone.
   *
   * Awaiting matters here rather than being tidiness: the carriers kill a child process,
   * and a caller that returns first (a restart opening the replacement, a session tearing
   * down) leaves the old codex app-server running with nobody reading it — the orphan that
   * only shows up later as CPU or as a second writer on the same thread.
   */
  async stop() {
    this.isTurnRunning = false;
    if (this.appServer) {
      // The chat is the process: dropping the session without ending it would leave it
      // running with nobody reading, and the next start would open a second thread.
      await this.appServer.stop();
      this.appServer = null;
      // Stopped on the carrier the server actually runs on. `this.proc` is AgentProc —
      // exec's carrier — and calling stop() there talks to a daemon this chat never used
      // ("Not connected to daemon"), while the real child kept running.
      const carrier = this._activeCarrier();
      this._appServerProc = null;
      await carrier?.stop();
      return;
    }
    // exec: the turn's own process is `this.proc`, and stopping it IS stopping the turn.
    return this.proc.stop();
  }
}
