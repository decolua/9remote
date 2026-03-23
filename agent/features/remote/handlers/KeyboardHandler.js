// Keyboard Handler for Remote Desktop
import { REMOTE_CONFIG } from "../REMOTE_CONFIG.js";

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
        if (key.length === 1) {
          robot.keyTap(key, data.modifier || []);
          for (const modifier of (data.modifier || [])) {
            robot.keyToggle(modifier, "up");
          }
        } else {
          switch (key.toLowerCase()) {
            case "enter":
            case "return":
              robot.keyTap("enter");
              break;
            case "space":
              robot.keyTap(" ");
              break;
            case "backspace":
              robot.keyTap("backspace");
              break;
            case "tab":
              robot.keyTap("tab");
              break;
            case "escape":
              robot.keyTap("escape");
              break;
            default:
              robot.keyTap(key, data.modifier || []);
          }
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
