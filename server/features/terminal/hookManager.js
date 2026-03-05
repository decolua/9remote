// AI Tool Hook Management (Claude Code, Codex, Gemini CLI)
import os from "os";
import fs from "fs";
import path from "path";

function getClaudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function getCodexConfigPath() {
  return path.join(os.homedir(), ".codex", "config.toml");
}

function getGeminiSettingsPath() {
  return path.join(os.homedir(), ".gemini", "settings.json");
}

function readJsonFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
  } catch (e) {
    // Ignore parse errors
  }
  return {};
}

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function enableClaudeHook() {
  const filePath = getClaudeSettingsPath();
  const settings = readJsonFile(filePath);
  
  const stopCmd = "command -v curl >/dev/null 2>&1 && curl -s --connect-timeout 1 --max-time 2 \"http://localhost:2208/api/notify?type=stop&sessionId=$NINE_REMOTE_SESSION_ID&tool=claude\" > /dev/null 2>&1 & true";
  const notifyCmd = "command -v curl >/dev/null 2>&1 && curl -s --connect-timeout 1 --max-time 2 \"http://localhost:2208/api/notify?type=notification&sessionId=$NINE_REMOTE_SESSION_ID&tool=claude\" > /dev/null 2>&1 & true";
  
  settings.hooks = {
    ...settings.hooks,
    Stop: [{
      matcher: "",
      hooks: [{ type: "command", command: stopCmd }]
    }],
    Notification: [{
      matcher: "permission_prompt|idle_prompt",
      hooks: [{ type: "command", command: notifyCmd }]
    }]
  };
  
  writeJsonFile(filePath, settings);
  return { success: true };
}

function disableClaudeHook() {
  const filePath = getClaudeSettingsPath();
  const settings = readJsonFile(filePath);
  
  if (settings.hooks) {
    delete settings.hooks.Stop;
    delete settings.hooks.Notification;
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }
  
  writeJsonFile(filePath, settings);
  return { success: true };
}

function enableCodexHook() {
  const filePath = getCodexConfigPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  
  const cmd = "command -v curl >/dev/null 2>&1 && curl -s --connect-timeout 1 --max-time 2 \"http://localhost:2208/api/notify?type=stop&sessionId=$NINE_REMOTE_SESSION_ID&tool=codex\" > /dev/null 2>&1 & true";
  
  let content = "";
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, "utf8");
    // Remove existing notify line
    content = content.replace(/\n?# 9Remote notification\nnotify\s*=.*\n?/g, "");
  }
  
  content += `\n# 9Remote notification\nnotify = ["bash", "-c", "${cmd}"]\n`;
  fs.writeFileSync(filePath, content, "utf8");
  return { success: true };
}

function disableCodexHook() {
  const filePath = getCodexConfigPath();
  if (!fs.existsSync(filePath)) return { success: true };
  
  let content = fs.readFileSync(filePath, "utf8");
  content = content.replace(/\n?# 9Remote notification\nnotify\s*=.*\n?/g, "");
  fs.writeFileSync(filePath, content, "utf8");
  return { success: true };
}

function enableGeminiHook() {
  const filePath = getGeminiSettingsPath();
  const settings = readJsonFile(filePath);
  
  const stopCmd = "command -v curl >/dev/null 2>&1 && curl -s --connect-timeout 1 --max-time 2 \"http://localhost:2208/api/notify?type=stop&sessionId=$NINE_REMOTE_SESSION_ID&tool=gemini\" > /dev/null 2>&1 & true";
  const notifyCmd = "command -v curl >/dev/null 2>&1 && curl -s --connect-timeout 1 --max-time 2 \"http://localhost:2208/api/notify?type=notification&sessionId=$NINE_REMOTE_SESSION_ID&tool=gemini\" > /dev/null 2>&1 & true";
  
  settings.hooks = {
    ...settings.hooks,
    enabled: true,
    AfterAgent: [{
      matcher: "",
      hooks: [{ type: "command", command: stopCmd }]
    }],
    Notification: [{
      matcher: "",
      hooks: [{ type: "command", command: notifyCmd }]
    }]
  };
  
  if (!settings.tools) settings.tools = {};
  settings.tools.enableHooks = true;
  
  writeJsonFile(filePath, settings);
  return { success: true };
}

function disableGeminiHook() {
  const filePath = getGeminiSettingsPath();
  const settings = readJsonFile(filePath);
  
  if (settings.hooks) {
    delete settings.hooks.AfterAgent;
    delete settings.hooks.Notification;
    delete settings.hooks.enabled;
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }
  }
  
  writeJsonFile(filePath, settings);
  return { success: true };
}

function isToolHookEnabled(tool) {
  switch (tool) {
    case "claude": {
      const settings = readJsonFile(getClaudeSettingsPath());
      return !!(settings.hooks?.Stop || settings.hooks?.Notification);
    }
    case "codex": {
      const filePath = getCodexConfigPath();
      if (!fs.existsSync(filePath)) return false;
      const content = fs.readFileSync(filePath, "utf8");
      return content.includes("# 9Remote notification");
    }
    case "gemini": {
      const settings = readJsonFile(getGeminiSettingsPath());
      return !!(settings.hooks?.AfterAgent || settings.hooks?.Notification);
    }
    default: return false;
  }
}

function isToolInstalled(tool) {
  const paths = {
    claude: getClaudeSettingsPath().replace("/settings.json", ""),
    codex: getCodexConfigPath().replace("/config.toml", ""),
    gemini: getGeminiSettingsPath().replace("/settings.json", "")
  };
  return fs.existsSync(paths[tool]);
}

export function enableToolHook(tool) {
  switch (tool) {
    case "claude": return enableClaudeHook();
    case "codex": return enableCodexHook();
    case "gemini": return enableGeminiHook();
    default: return { success: false, error: "Unknown tool" };
  }
}

export function disableToolHook(tool) {
  switch (tool) {
    case "claude": return disableClaudeHook();
    case "codex": return disableCodexHook();
    case "gemini": return disableGeminiHook();
    default: return { success: false, error: "Unknown tool" };
  }
}

export function getHookStatus() {
  const tools = ["claude", "codex", "gemini"];
  const status = {};
  for (const tool of tools) {
    status[tool] = {
      installed: isToolInstalled(tool),
      enabled: isToolHookEnabled(tool)
    };
  }
  return status;
}
