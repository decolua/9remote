// Adapter for OpenAI Codex CLI using exec --json
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

// Composer permission mode → codex sandbox policy. The CLI has no single "mode" flag:
// what a mode means is decided by how much the sandbox allows. These mirror the TUI's
// own presets (Read Only / Default / Full Access).
const MODE_TO_SANDBOX = {
  readOnly: "read-only",
  default: "workspace-write",
  fullAccess: "danger-full-access"
};

// Plan is a separate axis in codex (collaboration_mode), not a sandbox: it keeps the
// gate where it is and makes the model propose instead of execute. Verified: a write
// under this mode is rejected with "writing is blocked by read-only sandbox".
const PLAN_MODE_ARG = ["-c", 'collaboration_mode="plan"'];

// Widening ladder: a blocked action is resolved by the next mode up. Plan sits at the
export class CodexAdapter {
  constructor({ cwd, onEvent, proc = null, threadId = null, model = "", hostSessionId = null, transport = null } = {}) {
    this.cwd = cwd || process.cwd();
    this.onEvent = onEvent;
    this.hostSessionId = hostSessionId;
    // Two transports, one protocol's worth of difference between them. `exec` spawns a
    // process per turn and reads stdout one way; `app-server` keeps one process for the
    // chat and talks JSON-RPC both ways, which is what makes thinking stream and lets a
    // permission gate hold a turn.
    //
    // app-server is the default: it is the transport that behaves like the CLI's own TUI
    // (streamed reasoning, the CLI's parse of every command), and `exec` is kept as the
    // way back — `NREMOTE_CODEX_TRANSPORT=exec` — for a machine where the app-server
    // cannot start. Anything not exactly "exec" is the default, so a typo cannot silently
    // switch a deployment to the older path either.
    const asked = transport || process.env.NREMOTE_CODEX_TRANSPORT;
    this.transport = asked === "exec" ? "exec" : "app-server";
    this.appServer = null;
    this._restarting = false;
    // Prompts that arrived while the server was being replaced; drained once it is up.
    this._heldPrompts = [];
    // One prompt held while OUR interrupt is landing — see sendPrompt. Sister of
    // `_heldPrompts` (the restart window), with the same one-deep patience.
    this._pendingAfterStop = null;
    // Turn-per-CLI: a process is born per turn. Under the daemon it outlives an agent
    // restart, and adopt() picks that turn back up.
    // An injected proc is the caller's (a test's); otherwise the transport decides —
    // AgentProc for exec, a two-way carrier for the app-server, chosen lazily in start().
    this._procOverride = proc;
    this.proc = proc || new AgentProc({ procId: "" });
    this.activeThreadId = threadId || null;
    this.isTurnRunning = false;
    this.currentModel = model || "";
    this.reasoningEffort = "medium";
    this.sandboxMode = "workspace-write";
    // The composer sends `mode`; without this it was dropped and every turn ran at the
    // default policy, so switching modes changed nothing.
    this.permissionMode = "default";
    // Plan mode reasoning is a separate knob in codex (`plan_mode_reasoning_effort`),
    // not a separate model — left empty it falls back to the CLI's own default.
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
    // Empty model means "CLI default" — never a label. This metadata is echoed back by
    // the session and later fed to `-m`, so a display string here would be sent to the
    // CLI as a real model id and get the provider to 404.
    // The Config modal reads its current values back from this metadata, so every
    // option the modal can set has to be here — otherwise reopening it shows defaults
    // and silently reverts what the user chose.
    this.metadata = { model: this.currentModel, sandbox: this.sandboxMode, permissionMode: this.permissionMode, planMode: false, effort: this.reasoningEffort, planEffort: this.planEffort, personality: this.personality, networkAccess: this.networkAccess, addDirs: this.addDirs, enable: this.enable, disable: this.disable, skipGitRepoCheck: this.skipGitRepoCheck, ephemeral: this.ephemeral };
    this.setThreadId(this.activeThreadId);
  }

  // The thread id is codex's conversation id. The shared init consumer reads that
  // off `sessionId` (every other adapter names it so), so publish it under both:
  // `threadId` for the goal RPC, `sessionId` for the conversation mirror.
  setThreadId(id) {
    this.activeThreadId = id || null;
    this.metadata.threadId = this.metadata.sessionId = id || "";
  }

  setOptions({ model, effort, planEffort, sandbox, mode, resume, personality, networkAccess, addDirs, enable, disable, skipGitRepoCheck, ephemeral }) {
    // Read once, before anything is written: a feature flag lives on the PROCESS, so a
    // change to it is only visible by comparing what it was.
    const featuresBefore = `${this.enable.join(",")}|${this.disable.join(",")}`;
    if (model) {
      this.currentModel = model;
      this.metadata.model = model;
    }
    if (effort) {
      this.reasoningEffort = effort;
      this.metadata.effort = effort;
    }
    // Empty string is a real choice here — it means "use the CLI's own default", so
    // these two take any string, unlike the ones where empty means "not sent".
    if (typeof planEffort === "string") {
      this.planEffort = planEffort;
      this.metadata.planEffort = planEffort;
    }
    if (mode && MODE_LABELS[mode]) {
      this.permissionMode = mode;
      this.metadata.permissionMode = mode;
      // Plan is a collaboration mode, not a sandbox — it keeps whatever sandbox the
      // session already had, so the two stay independent axes here.
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

  /**
   * Push the options onto the running server, restarting it only when something needs a
   * new process.
   *
   * On the exec transport every option was an argv flag on the turn's own process, so a
   * change cost nothing. Here the process is the chat, and the two kinds of option are
   * not alike:
   *
   *   request fields  sandbox, approval, plan, effort, personality, model — a
   *                   `thread/settings/update`, effective on the spot
   *   process flags   feature enable/disable — probed on the real server: thread/start's
   *                   `config` does NOT apply them and `experimentalFeature/enablement/set`
   *                   answers `{}` without changing anything. Only `-c features.X=true`
   *                   at spawn does, so the server is respawned.
   *
   * A restart drops the turn in flight, so it is never taken while one is running —
   * the same rule the exec path followed when a spawn-time option changed.
   */
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
    // Fire and forget: a settings call that fails must not take the turn's options with
    // it, and every one of them is repeated on `turn/start` anyway.
    this.appServer.updateSettings(changed).catch(() => {});

    if (featuresChanged) this.restart().catch(() => {});
  }

  /**
   * Respawn the server with the options this adapter now holds, keeping the thread.
   * `thread/resume` on the same id is what makes this a restart rather than a new chat.
   *
   * `this.appServer` is left in place until the replacement exists. Clearing it first
   * made `sendPrompt` fall through to the exec branch for the width of the restart —
   * a chat on this transport would spawn `codex exec`, a second writer on the same
   * conversation. The old session is detached from the proc right before the respawn,
   * so its exit cannot be read as this chat dying.
   */
  async restart() {
    if (!this.persistent || this._restarting) return;
    this._restarting = true;
    const threadId = this.activeThreadId;
    const previous = this.appServer;
    try {
      previous?.detach();
      // The carrier this chat's server runs on, not `this.proc` — that one is exec's
      // AgentProc, and stopping it would ask a daemon that never ran this process.
      //
      // Stopped even when the caller injected it: that carrier IS this chat's server, and
      // a respawn without stopping it leaves two codex processes on one thread. DaemonProc
      // is keyed by procId, so this ends the process for this chat and nothing else.
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

  /**
   * True for a transport that holds ONE process for the whole chat. `aiSession` starts
   * those eagerly (as it does for Claude) and leaves a turn-per-CLI engine alone until
   * the user asks for a turn.
   */
  get persistent() {
    return this.transport === "app-server";
  }

  /**
   * The carrier to run the app-server on.
   *
   * `AgentProc` — codex's own default — is for `exec`: it only READS the CLI's stdout and
   * has no `write()` at all, so a chat built on it could never send its first
   * `initialize`. The app-server is two-way and needs a carrier that can both write and
   * spawn: the caller's when it gave one (aiSession hands down a DaemonProc, a test hands
   * its own), otherwise a direct child.
   *
   * ONE accessor, deliberately: `_appServerProc` used to be set here and read in
   * restart()/stop(), so with an injected carrier those two saw `null` and the old
   * process was never stopped — a respawn that left the previous codex running.
   */
  _carrierFor() {
    if (this._procOverride) return this._procOverride;
    if (!this._appServerProc) this._appServerProc = new LocalProc();
    return this._appServerProc;
  }

  /** The carrier this chat's server was actually started on, for stopping it. */
  _activeCarrier() {
    return this._procOverride || this._appServerProc || null;
  }

  /**
   * Spawn the app-server and open (or rejoin) a thread. The exec path has nothing to do
   * here — its process is born with the turn — so it falls through to the same
   * "nothing fetched" answer the session already handles.
   */
  async start(mode = "default", resumeSessionId = null) {
    if (!this.persistent) return null;
    if (resumeSessionId) this.setThreadId(resumeSessionId);

    // TEMP DIAGNOSTIC — a codex chat that opens and then says nothing has no other trace:
    // the adapter logs nothing, so a failed spawn and a spawn that was never attempted
    // look identical from outside. Remove once the app-server path has settled.
    const diag = (msg) => logger.info(`[codex-adapter] ${msg}`);
    diag(`start begin transport=${this.transport} mode=${mode} resume=${resumeSessionId} managed=${daemonClient.isConnected()}`);

    this.permissionMode = mode || this.permissionMode;
    // ONE carrier, used for both the spawn and the session. Spawning on `this.proc` was
    // the bug: that one is AgentProc — exec's carrier, which talks to the daemon — so the
    // session held a LocalProc nobody had started while the spawn asked a daemon that
    // never ran this chat. It answered "Not connected to daemon" in 1ms, and on a machine
    // WITH a daemon it would have been worse: the process spawned under one carrier and
    // the protocol written to another, so the turn would hang with no error at all.
    const carrier = this._carrierFor();
    this.appServer = new CodexAppServer({
      proc: carrier,
      cwd: this.cwd,
      onEvent: (ev, data) => this._forward(ev, data),
      // The interrupt's landing is the one ending this adapter never hears as an event
      // (the pane-facing echo is swallowed in the app-server), so the flag release and
      // the prompt held for that window both hang off this callback instead.
      onInterruptSettled: () => {
        this.isTurnRunning = false;
        this._flushPendingAfterStop();
      },
      threadId: this.activeThreadId,
      model: this.currentModel,
      effort: this.reasoningEffort,
      personality: this.personality || null
    });
    // The app's options are set BEFORE the handshake: a chat that opens in Plan must
    // open its thread in Plan, not switch into it a call later. The session holds them
    // itself — assigning the returned patch back onto it made a second copy that the
    // turn overrides read instead of the first.
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

    // `-c features.<name>=true` is the ONLY way to turn a feature on — probed: neither
    // thread/start's config nor experimentalFeature/enablement/set has any effect. So
    // the flags belong to the process, and changing them means a new process (see
    // setOptions).
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

    // `commit` is not optional on every carrier. DaemonProc opens a HOLD around the
    // spawn — every line the process prints is buffered until the caller releases it —
    // so skipping this left the server's `initialize` answer sitting in that buffer for
    // good, and the handshake timed out after 15s on a server that had answered at once.
    // LocalProc has no hold, which is exactly why the same code worked without a daemon
    // and failed with one. `commit(feed)` is the one door: feed what was fetched, let
    // the held lines through, then (for a non-keepStdin engine) close stdin.
    //
    // The feed goes to the JSON-RPC client, not to this adapter's `feed`: these are
    // protocol envelopes, and the exec parser would only turn them into ANSI noise.
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

  /**
   * Re-attach to the turn the daemon is still running after an agent restart. A turn
   * that ended while nobody was watching is replayed too — every line it printed is
   * in the daemon's buffer, so the chat shows the answer instead of a blank pane.
   */
  async adopt({ from = 0, epoch = null } = {}) {
    const fetch = await this.proc.attach({ from, epoch });
    if (!fetch.lines?.length && !fetch.alive) return fetch;
    this._bind();
    // The turn's process is the turn: while it lives, the chat is still working.
    this.isTurnRunning = fetch.alive;
    // The gap is healed by the session (it owns the conversation id and the log), so
    // the lines are handed over before the held ones are released.
    this.fetched = fetch;
    return fetch;
  }

  // Handlers bind to the process that owns them, and the same process can carry a
  // second turn later — so this is idempotent, not a one-shot wiring.
  _bind() {
    // The app-server owns the pipe AND the exit hook: it parses JSON-RPC itself and has
    // to hear the process die to end the turn. Re-pointing either one here would leave a
    // dead server looking alive and the pane spinning forever.
    if (this.persistent) return;
    this.proc.onLine = (line) => this.feed(line);
    this.proc.onExit = ({ code, error }) => {
      this.isTurnRunning = false;
      if (error) this.onEvent?.("error", { message: error });
      else this.onEvent?.("turn_complete", { stats: this.stats, exitCode: code });
    };
  }

  /** Parse one raw line from the CLI. */
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

  // The argv for one turn. Split out of sendPrompt so the flags stay testable without
  // spawning a CLI — the two branches (fresh exec vs resume) differ in more than one way.
  buildArgs(prompt, images = []) {
    const args = ["exec"];
    // Full Access means no prompts anywhere. `-s danger-full-access` alone still stops
    // at the approval gate, so the bypass flag has to ride along.
    const bypass = this.permissionMode === "fullAccess";

    if (this.activeThreadId) {
      // `codex exec resume` has no `-s` flag (verified against the CLI: it rejects it
      // with "unexpected argument '-s'"). Sandbox and the other typed flags go through
      // config overrides instead; the boolean ones it does accept ride along directly.
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
    // Same shape as the restart drain: a throw here has no caller to catch it, so it
    // becomes the pane's error instead of an unhandled rejection.
    try { this.sendPrompt(held.prompt, held.attachments); }
    catch (err) { this.onEvent?.("error", { message: err.message }); }
  }

  sendPrompt(prompt, attachments = null) {
    if (this.isTurnRunning) {
      // A stop we sent is still landing: the turn ends the moment the server's echo
      // arrives, and this prompt goes right after it — held for the width of that
      // window, not refused into the user's face (the client drains its queue the
      // instant `stopped` arrives, which is before the server has finished stopping).
      if (this.persistent && this.appServer?.interrupting && !this._pendingAfterStop) {
        // Raw, like `_heldPrompts`: the flush re-enters sendPrompt, which stages —
        // staging here too would stage twice, and the second pass has no content.
        this._pendingAfterStop = { prompt, attachments: attachments?.length ? attachments : null };
        return;
      }
      throw new Error("Codex turn is already running.");
    }
    // This transport has no per-turn fallback: `exec` here would be a SECOND writer on a
    // conversation the server still owns. So a prompt that lands mid-restart is held
    // until the replacement is up. It is HELD, not retried on a promise chain — a chain
    // whose link re-runs this method spins through microtasks forever while the restart
    // is still in flight, because each link sees the same "not ready" and makes another.
    if (this.persistent && (!this.appServer || this._restarting)) {
      this._heldPrompts.push({ prompt, attachments });
      return;
    }

    const staged = attachments?.length ? attachments.map(stageAttachment) : null;

    // One process for the chat: the prompt is a turn on the server that is already up,
    // and the server carries the mode/sandbox it was opened with.
    if (this.persistent && this.appServer) {
      this.isTurnRunning = true;
      // `/review` is handled inside app-server.sendPrompt, which routes it to the
      // server's own `review/start`. The exec transport below has no such call — a chat
      // forced onto it (`NREMOTE_CODEX_TRANSPORT=exec`) sends the text as prose, which is
      // the honest behaviour for a one-process-per-turn CLI that offers no review RPC.
      // Attachments ride as `localImage` entries; a file is named in the text for the
      // agent to read (the server takes no file input).
      this.appServer.sendPrompt(prompt, staged).catch((err) => {
        this.isTurnRunning = false;
        this.onEvent?.("error", { message: err.message });
      });
      return;
    }

    // Images ride as files (`--image=`); other files — and the caption — join the text
    // as a path list, which codex reads on its own. Verified against the CLI: `exec` and
    // `exec resume` both take the flag, and an image-only prompt is fine (an empty
    // PROMPT is accepted).
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
      // commit, not just closeStdin: the process prints its first items while the start
      // handshake is still in flight, and anything it printed before the handlers were
      // live has to be fed here — then the held lines let through, then stdin closed
      // (codex exec blocks on a pipe nobody closes). Skipping it made the whole turn
      // silent: the chat showed the prompt and then nothing.
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

    // A tool item is announced while it runs and completed later, carrying the same id —
    // so ONE mapping opens the card and, once the item is done, closes it with its output.
    // That mapping is codexItems.js, shared with the rollout reader: a replayed card and
    // a live one are the same object, which is what keeps the two doors honest.
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
    if (this.persistent) {
      // The server's own answer, not a guess: it needs BOTH the thread and the open turn,
      // and only it knows whether a turn is really running. Returning `true` off a thread
      // id alone was the same lie one layer down — `AiSession.stop` would report a turn
      // stopped and clear the pane's flag over a CLI that never heard anything.
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
    try { carrier.signal(sig); return true; } catch { return false; }
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
