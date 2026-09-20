// Maps client Codex options to Codex app-server protocol schema
const MODE_TO_SANDBOX = {
  readOnly: "readOnly",
  default: "workspaceWrite",
  plan: "workspaceWrite",
  fullAccess: "dangerFullAccess"
};

const RAW_SANDBOX = {
  "read-only": "readOnly",
  "workspace-write": "workspaceWrite",
  "danger-full-access": "dangerFullAccess"
};

const MODE_TO_APPROVAL = {
  readOnly: "untrusted",
  default: "on-request",
  plan: "on-request",
  fullAccess: "never"
};

const DEFAULT_MODE = "default";

const MODE_LADDER = [["plan", "readOnly"], "default", "fullAccess"];

export const MODE_LABELS = { plan: "Plan", readOnly: "Read Only", default: "Default", fullAccess: "Full Access" };

export function nextModeUp(current) {
  for (let i = 0; i < MODE_LADDER.length; i++) {
    const step = MODE_LADDER[i];
    if (Array.isArray(step) ? step.includes(current) : step === current) return MODE_LADDER[i + 1] ?? null;
  }
  return null;
}

// Pattern matching Codex refusal messages in assistant text
export const BLOCKED_TEXT_RE = /(?:can(?:not|'t|not)\s+(?:create|write|edit|modify|delete)|unable to\s+(?:create|write|edit|modify)|permission denied|operation not permitted|not permitted to|(?:workspace|sandbox)\s+is\s+read-?only|outside the (?:workspace|sandbox))/i;

const FEATURE_NAME_RE = /^[A-Za-z0-9_]+$/;

export function sandboxPolicyFor({ mode, sandbox, networkAccess = false, addDirs = [] } = {}) {
  const type = MODE_TO_SANDBOX[mode] || RAW_SANDBOX[sandbox] || MODE_TO_SANDBOX[DEFAULT_MODE];
  if (type === "dangerFullAccess") return { type };

  const policy = {
    type,
    writableRoots: (addDirs || []).filter((d) => typeof d === "string" && d),
    networkAccess: Boolean(networkAccess),
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  };
  if (type === "readOnly") {
    return { type, networkAccess: policy.networkAccess };
  }
  return policy;
}

export function approvalPolicyFor({ mode } = {}) {
  return MODE_TO_APPROVAL[mode] || MODE_TO_APPROVAL[DEFAULT_MODE];
}

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

export function turnSettingsFor({ mode, model, effort, personality } = {}) {
  const out = {
    sandboxPolicy: sandboxPolicyFor({ mode }),
    approvalPolicy: approvalPolicyFor({ mode })
  };
  if (model) out.model = model;
  if (effort) out.effort = effort;
  if (personality) out.personality = personality;
  return out;
}

export function spawnArgsFor({ enable = [], disable = [], skipGitRepoCheck = false } = {}) {
  const args = [];
  for (const name of enable || []) {
    if (FEATURE_NAME_RE.test(String(name))) args.push("-c", `features.${name}=true`);
  }
  for (const name of disable || []) {
    if (FEATURE_NAME_RE.test(String(name))) args.push("-c", `features.${name}=false`);
  }
  if (skipGitRepoCheck) args.push("-c", "skip_git_repo_check=true");
  return args;
}
