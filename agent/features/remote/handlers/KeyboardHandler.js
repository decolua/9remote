// Keyboard Handler for Remote Desktop
import { execFile } from "child_process";
import { REMOTE_CONFIG } from "../REMOTE_CONFIG.js";

// macOS Spaces switch — AppleScript bypasses macOS synthetic-event filter that blocks robotjs.
function macSpaceSwitch(combo) {
  let script;
  if (combo.type === "missionControl") {
    // Open Mission Control — user adds Space manually (no reliable AppleScript)
    script = `tell application "System Events" to key code 160`;
  } else {
    script = `tell application "System Events" to key code ${combo.keyCode} using ${combo.mods}`;
  }
  execFile("osascript", ["-e", script], (err) => { if (err) console.error("osascript error:", err.message); });
}

export class KeyboardHandler {
  constructor(robot, resourceManager) {
    this.robot = robot;
    this.resourceManager = resourceManager;
    this.lastKeyPress = 0;
    this.lastTypeText = 0;
  }

  setupKeyboardHandlers(socket, requireAuth) {
    const robot = this.robot;

    socket.on("key-press", requireAuth((data) => {
      const now = Date.now();
      if (now - this.lastKeyPress < REMOTE_CONFIG.throttling.keyThrottle) return;
      this.lastKeyPress = now;

      try {
        if (!data.key || typeof data.key !== "string") return;

        const clientData = this.resourceManager.getClient(socket.id);

        let key = data.key;
        const modifier = data.modifier || [];
        if (key.length === 1) {
          // ctrl/alt/cmd combos (not shift) → keyTap. robotjs keyTap can't produce
          // uppercase or shifted symbols on its own (throws on "A"/"!"), so a plain
          // char — even with shift — goes through typeString which types it verbatim.
          const hard = modifier.filter((m) => m !== "shift");
          if (hard.length > 0) {
            robot.keyTap(key.toLowerCase(), modifier);
            for (const m of modifier) robot.keyToggle(m, "up");
          } else {
            robot.typeString(key);
          }
        } else {
          // Normalize common aliases → robotjs key names. All branches MUST pass
          // `modifier` so combos like Shift+Tab, Ctrl+Enter, Alt+F4 work.
          const alias = { return: "enter" };
          const normalized = alias[key.toLowerCase()] ?? key.toLowerCase();
          robot.keyTap(normalized, modifier);
        }

        // Reset idle counter to speed up streaming after keypress
        if (clientData) {
          clientData.idleFrameCount = 0;
        }
        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Key press error:", error.message);
      }
    }));

    socket.on("desktop-switch", requireAuth((data) => {
      try {
        const direction = data?.direction;
        const combo = REMOTE_CONFIG.desktopSwitch[process.platform]?.[direction];
        if (!combo) return;
        if (process.platform === "darwin") macSpaceSwitch(combo);
        else robot.keyTap(combo[0], combo[1]);
        const clientData = this.resourceManager.getClient(socket.id);
        if (clientData) clientData.idleFrameCount = 0;
        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Desktop switch error:", error.message);
      }
    }));

    socket.on("type-text", requireAuth((data) => {
      const now = Date.now();
      if (now - this.lastTypeText < REMOTE_CONFIG.throttling.typeTextThrottle) return;
      this.lastTypeText = now;

      try {
        if (!data.text || typeof data.text !== "string") return;

        let text = data.text;
        if (text.length > REMOTE_CONFIG.throttling.maxTextLength) {
          text = text.substring(0, REMOTE_CONFIG.throttling.maxTextLength);
        }

        const safeText = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
        const clientData = this.resourceManager.getClient(socket.id);

        setTimeout(() => {
          try {
            robot.typeString(safeText);
            this.resourceManager.updateClientActivity(socket.id);

            // Reset idle counter and clear cache for immediate screen update
            if (clientData) {
              clientData.idleFrameCount = 0;
              if (clientData.tileManager) {
                clientData.tileManager.clearScreenCache();
              }
            }
          } catch (typeError) {
            console.error("Robot typeString error:", typeError.message);
          }
        }, 10);
      } catch (error) {
        console.error("Type text error:", error.message);
      }
    }));
  }
}
