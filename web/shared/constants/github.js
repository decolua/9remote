// GitHub Codespace integration config

export const GITHUB_API = "https://api.github.com";
export const GITHUB_PAT_SCOPES = ["codespace", "repo", "user"];
export const GITHUB_PAT_DESCRIPTION = "9remote";
export const GITHUB_PAT_GENERATE_URL = `https://github.com/settings/tokens/new?scopes=${GITHUB_PAT_SCOPES.join(",")}&description=${encodeURIComponent(GITHUB_PAT_DESCRIPTION)}`;

export const DEVCONTAINER_PATH = ".devcontainer/devcontainer.json";
export const NREMOTE_SECRET_NAME = "NREMOTE_API_KEY";

export const DEVCONTAINER_TEMPLATE = {
  name: "9Remote",
  image: "mcr.microsoft.com/devcontainers/universal:latest",
  postCreateCommand: "npm install -g 9remote@latest",
  postAttachCommand: "nohup 9remote start > /tmp/9remote.log 2>&1 &",
  forwardPorts: [2208],
  portsAttributes: {
    "2208": {
      label: "9Remote Server",
      onAutoForward: "silent",
      visibility: "public"
    }
  }
};

export const CODESPACE_AGENT_PORT = 2208;
export const CODESPACE_FORWARD_DOMAIN = "app.github.dev";

export const CODESPACE_POLL_INTERVAL_MS = 3000;
export const CODESPACE_POLL_MAX_ATTEMPTS = 60;

export const CODESPACE_STATE = {
  available: "Available",
  starting: "Starting",
  shutdown: "Shutdown",
  unknown: "Unknown"
};

export const GITHUB_ENDPOINTS = {
  user: "/user",
  codespaces: "/user/codespaces",
  codespaceByName: (name) => `/user/codespaces/${name}`,
  startCodespace: (name) => `/user/codespaces/${name}/start`,
  userReposList: "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator",
  repoContents: (owner, repo, path) => `/repos/${owner}/${repo}/contents/${path}`,
  createCodespaceForRepo: (owner, repo) => `/repos/${owner}/${repo}/codespaces`,
  codespaceSecretsPublicKey: "/user/codespaces/secrets/public-key",
  codespaceSecret: (name) => `/user/codespaces/secrets/${name}`,
  codespaceSecretRepos: (name, repoId) => `/user/codespaces/secrets/${name}/repositories/${repoId}`
};

export function buildCodespaceUrl(codespaceName) {
  return `https://${codespaceName}-${CODESPACE_AGENT_PORT}.${CODESPACE_FORWARD_DOMAIN}`;
}
