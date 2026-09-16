// The app's codex options → the app-server's own vocabulary.
//
// `codex exec` takes each option as an argv flag on the turn's own process. The
// app-server is one process for the whole chat, so every option becomes a field on a
// request instead — and the two are NOT one-to-one, which is the whole reason this file
// exists rather than a spread:
//
//   mode            →  sandboxPolicy + approvalPolicy   (two knobs, not one)
//   planMode        →  collaborationMode                (a different axis, not a sandbox)
//   networkAccess   →  sandboxPolicy.networkAccess      (a field of the policy)
//   addDirs         →  sandboxPolicy.writableRoots      (likewise)
//   enable/disable  →  the process's OWN flags          (cannot be changed later)
//
// Every name below is the server's, checked against `codex app-server generate-ts` and
// probed on the installed binary — it rejects an unknown enum variant with -32600, so a
// near-miss spelling fails loudly rather than silently.

/** What each permission mode means, as the server spells it. */
const MODE_TO_SANDBOX = {
  readOnly: "readOnly",
  default: "workspaceWrite",
  plan: "workspaceWrite",
  fullAccess: "dangerFullAccess"
};

// The exec transport names the same three things with hyphens (`-s read-only`), and the
// adapter carries that spelling on `sandboxMode`. Accepted here so a raw sandbox name is
// not silently dropped on the floor — which it was, until a full-access chat was found
// running as workspace-write.
const RAW_SANDBOX = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
  "danger-full-access": "dangerFullAccess"
};

// Whether the server stops to ask first. A mode the user picked that means "do not ask"
// says so; anything narrower keeps the gate, because the gate IS the mode.
const MODE_TO_APPROVAL = {
  readOnly: "untrusted",
  default: "on-request",
  plan: "on-request",
  fullAccess: "never"
};

const DEFAULT_MODE = "default";

// A feature name becomes part of a config override (`features.<name>=true`), so anything
// that could close that expression or start another is refused rather than escaped —
// there is no legitimate name that needs a quote, a space or an `=`.
const FEATURE_NAME_RE = /^[A-Za-z0-9_]+$/;

/**
 * The sandbox policy for an option set, in the shape the server deserializes.
 *
 * `dangerFullAccess` is a bare tag and carries nothing else — network and roots are
 * meaningless once nothing is restricted, and the schema has no field for them.
 */
export function sandboxPolicyFor({ mode, sandbox, networkAccess = false, addDirs = [] } = {}) {
  const type = MODE_TO_SANDBOX[mode] || RAW_SANDBOX[sandbox] || MODE_TO_SANDBOX[DEFAULT_MODE];
  if (type === "dangerFullAccess") return { type };

  const policy = {
    type,
    // Verified end to end: a command wrote into a dir listed here, outside the workspace.
    writableRoots: (addDirs || []).filter((d) => typeof d === "string" && d),
    networkAccess: Boolean(networkAccess),
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
  if (type === "readOnly") {
    // readOnly takes only `networkAccess`; the roots would be a schema error.
    return { type, networkAccess: policy.networkAccess };
  }
  return policy;
}

/** The approval policy for a mode. */
export function approvalPolicyFor({ mode } = {}) {
  return MODE_TO_APPROVAL[mode] || MODE_TO_APPROVAL[DEFAULT_MODE];
}

/**
 * Plan mode as the server states it: a collaboration mode, not a sandbox.
 *
 * `settings.model` is required by the schema and "" is what the server reads as "the
 * default"; `reasoning_effort` is the plan-only knob (`plan_mode_reasoning_effort` on
 * the exec side), falling back to the turn's own effort when unset.
 */
export function collaborationModeFor({ planMode = false, model = "", effort = "", planEffort = "" } = {}) {
  return {
    mode: planMode ? "plan" : "default",
    settings: {
      model: model || "",
      reasoning_effort: planEffort || effort || null,
      developer_instructions: null
    }
  };
}

/** The settings a mode change has to reach mid-chat, so they ride the turn as well. */
export function turnSettingsFor({ mode, model, effort, personality } = {}) {
  const out = {
    sandboxPolicy: sandboxPolicyFor({ mode }),
    approvalPolicy: approvalPolicyFor({ mode })
  };
  // An unset option is LEFT OUT, never sent as null: `model: null` would override the
  // thread's model with nothing.
  if (model) out.model = model;
  if (effort) out.effort = effort;
  if (personality) out.personality = personality;
  return out;
}

/**
 * The flags the app-server process itself has to be started with.
 *
 * Feature flags live here and NOWHERE else. Probed on the real server: `thread/start`'s
 * `config` does not apply them (read back through `experimentalFeature/list` a named
 * feature stayed false), and `experimentalFeature/enablement/set` answers `{}` without
 * changing anything. Only the process's own `-c features.<name>=true` does — so changing
 * this option mid-chat means restarting the server, exactly as changing the model does
 * on the exec transport.
 */
export function spawnArgsFor({ enable = [], disable = [], skipGitRepoCheck = false } = {}) {
  const args = [];
  for (const name of enable || []) {
    if (FEATURE_NAME_RE.test(String(name))) args.push("-c", `features.${name}=true`);
  }
  for (const name of disable || []) {
    if (FEATURE_NAME_RE.test(String(name))) args.push("-c", `features.${name}=false`);
  }
  // The app-server does not refuse a directory that is not a git repo, so the flag has
  // nothing to turn off; it is accepted anyway for a value the user already set.
  if (skipGitRepoCheck) args.push("-c", "skip_git_repo_check=true");
  return args;
}
