// Engine registry: one entry per chat engine, the single place a new engine is declared.
//
// Consumers (aiSession construction, doctor, model catalog dispatch) read this table and
// fall back to a default when an entry or field is missing — an engine nobody taught
// degrades, it never disappears.
import { ClaudeAdapter } from "./claudeAdapter.js";
import { CodexAdapter } from "./codexAdapter.js";
import { OpenCodeAdapter } from "./opencodeAdapter.js";
import { AntigravityAdapter } from "./antigravityAdapter.js";
import { OmpAdapter } from "./ompAdapter.js";
import { DevinAdapter } from "./devinAdapter.js";
import { HermesAdapter } from "./hermesAdapter.js";

// The ctx every build() gets. Adapters destructure what they need; extras are ignored,
// so the per-engine construction differences live in build(), not in the caller.
//   proc          daemon-owned process handle, null when unmanaged
//   sessionId     the CLI's own conversation id (claude/opencode/omp/devin/hermes)
//   threadId      codex's spelling of the same
//   conversationId antigravity's spelling of the same
export const ENGINES = Object.freeze({
  claude: {
    Adapter: ClaudeAdapter,
    managed: true,
    build: (ctx) => {
      const adapter = new ClaudeAdapter(ctx);
      // Set BEFORE start(): setOptions would restart the CLI and spawn a second process.
      if (ctx.model) adapter.metadata.model = ctx.model;
      if (ctx.effort) adapter.effort = ctx.effort;
      // adopt() re-seeds from currentMode; without this a re-attach resets the mode to
      // "default" and a Yolo session starts asking for permission.
      adapter.currentMode = ctx.mode;
      return adapter;
    }
  },
  codex: {
    Adapter: CodexAdapter,
    managed: true,
    build: (ctx) => new CodexAdapter(ctx),
    // Re-sent on every rebuild — codex spawns fresh per turn.
    seed: (adapter, s) => {
      if (s.permissionMode || s.options.model || s.options.effort || s.effort || s.options.sandbox || s.options.flags) {
        adapter.setOptions({ ...s.options, effort: s.effort || s.options.effort, mode: s.permissionMode || s.options.mode });
      }
    }
  },
  opencode: {
    Adapter: OpenCodeAdapter,
    managed: true,
    build: (ctx) => new OpenCodeAdapter(ctx),
    seed: (adapter, s) => {
      if (s.permissionMode || s.options.model || s.options.variant || s.options.flags) {
        adapter.setOptions({ ...s.options, mode: s.permissionMode || s.options.mode });
      }
    }
  },
  antigravity: {
    Adapter: AntigravityAdapter,
    managed: true,
    build: (ctx) => new AntigravityAdapter(ctx),
    // Through setOptions, not the field — it publishes effort on init and drops model-tier suffixes.
    seed: (adapter, s) => {
      if (s.permissionMode || s.options.model || s.options.flags || s.effort) {
        adapter.setOptions({ ...s.options, effort: s.effort || s.options.effort, mode: s.permissionMode || s.options.mode });
      }
    }
  },
  omp: {
    Adapter: OmpAdapter,
    managed: true,
    build: (ctx) => new OmpAdapter(ctx),
    seed: (adapter, s) => {
      if (s.permissionMode || s.options.model || s.effort) {
        adapter.setOptions({ ...s.options, effort: s.effort || s.options.effort, mode: s.permissionMode || s.options.mode });
      }
    }
  },
  devin: {
    Adapter: DevinAdapter,
    managed: true,
    build: (ctx) => new DevinAdapter(ctx),
    // Mode is read-only on this wire (session/set-mode is absent) — only the model rides setOptions.
    seed: (adapter, s) => {
      if (s.model || s.options.model) adapter.setOptions({ model: s.model || s.options.model });
    }
  },
  hermes: {
    Adapter: HermesAdapter,
    managed: true,
    build: (ctx) => new HermesAdapter(ctx),
    seed: (adapter, s) => {
      if (s.permissionMode || s.model || s.effort) {
        adapter.setOptions({ mode: s.permissionMode || s.options.mode, model: s.model || s.options.model, effort: s.effort || s.options.effort });
      }
    }
  }
});

// hasOwnProperty, not a bare lookup: an id like "constructor" hits Object.prototype
// and would hand back the Object constructor as if it were an engine def.
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

/** Engine definition, or null — callers fall back, they never throw on an unknown id. */
export const getEngineDef = (engine) => (engine != null && hasOwn(ENGINES, engine) ? ENGINES[engine] : null);

/** Whether the daemon owns this engine's CLI, so a turn outlives an agent restart. */
export const isManagedEngine = (engine) => Boolean(ENGINES[engine]?.managed);

/** The CLI's own health command, from the adapter's static spec. */
export const doctorSpecOf = (engine) => ENGINES[engine]?.Adapter?.doctorSpec?.() || null;
