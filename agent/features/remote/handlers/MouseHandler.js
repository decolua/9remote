// Mouse Handler for Remote Desktop
import { REMOTE_CONFIG } from "../REMOTE_CONFIG.js";
import { getResizeShape } from "../utils/winCursorShape.js";
import { createLogger } from "../../../lib/logger.js";

const log = createLogger("cursorShape");

export class MouseHandler {
  constructor(robot, resourceManager) {
    this.robot = robot;
    this.resourceManager = resourceManager;
    this.lastMouseMove = 0;
    // Tracks button held between press→release so mouse-move routes to dragMouse.
    this.buttonDown = null;
    // OS cursor shape sync — last emitted resize direction + emit timestamp.
    this.lastShape = null;
    this.lastShapeEmit = 0;
  }

  // Map client percent (0-100) → host pixel. With a MonitorManager available
  // (multi-monitor + DPI-aware process), use the active monitor's physical
  // origin+dims so coords are correct on any display. Otherwise fall back to
  // the legacy primary logical mapping.
  _resolvePoint(socket, percentX, percentY) {
    const clientData = this.resourceManager.getClient(socket.id);
    const active = clientData?.monitorManager?.getActive();
    // Off-primary display: node-screenshots origin+dims give the correct rect.
    // On the primary, keep the legacy robot.getScreenSize() path — that's the
    // coordinate space robotjs moveMouse uses, so single-monitor + scaled
    // primary stays accurate (the multi-monitor path is off-by-DPI there).
    if (active && !active.primary) {
      return {
        x: Math.round((percentX / 100) * active.w + active.x),
        y: Math.round((percentY / 100) * active.h + active.y)
      };
    }
    const d = this.robot.getScreenSize();
    return {
      x: Math.max(0, Math.min(d.width - 1, Math.round((percentX / 100) * d.width))),
      y: Math.max(0, Math.min(d.height - 1, Math.round((percentY / 100) * d.height)))
    };
  }

  // Sync OS resize-cursor direction to the client. Piggybacks on remote
  // mouse-move (no polling). Emits only on change, throttled so a rapid
  // shape flicker can't spam. Win-only — getResizeShape() is null elsewhere.
  _emitResizeShape(protocol, now) {
    const shape = getResizeShape();
    if (shape === this.lastShape) return;
    const passed = now - this.lastShapeEmit >= REMOTE_CONFIG.cursorShape.throttleMs;
    if (!passed) return;
    this.lastShape = shape;
    this.lastShapeEmit = now;
    log.info(`emit shape=${shape} (was ${this.lastShape})`);
    protocol?.emit?.("cursor-shape", { shape });
  }

  setupMouseHandlers(socket, requireAuth, protocol) {
    const robot = this.robot;

    socket.on("mouse-move", requireAuth((data) => {
      const now = Date.now();
      const throttle = process.platform === "win32" && this.buttonDown
        ? REMOTE_CONFIG.throttling.dragMouseThrottleWin
        : REMOTE_CONFIG.throttling.mouseThrottle;
      if (now - this.lastMouseMove < throttle) return;
      this.lastMouseMove = now;

      try {
        const { x: finalX, y: finalY } = this._resolvePoint(socket, data.x, data.y);

        // macOS needs kCGEventLeftMouseDragged (not kCGEventMouseMoved) to drag a
        // window mid-press. dragMouse posts the correct event type; on Linux/Win
        // it falls back to moveMouse so behavior is unchanged.
        if (this.buttonDown) robot.dragMouse(finalX, finalY, this.buttonDown);
        else robot.moveMouse(finalX, finalY);
        this._emitResizeShape(protocol, now);
        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Mouse move error:", error.message);
      }
    }));

    socket.on("mouse-click", requireAuth(async (data) => {
      try {
        const clientData = this.resourceManager.getClient(socket.id);
        if (!clientData) return;

        const { x: finalX, y: finalY } = this._resolvePoint(socket, data.x, data.y);
        robot.moveMouse(finalX, finalY);
        robot.mouseClick(data.button || "left", data.double || false);

        // Reset idle counter to speed up streaming after action
        clientData.idleFrameCount = 0;
        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Mouse click error:", error.message);
      }
    }));

    socket.on("mouse-press", requireAuth(async (data) => {
      try {
        const clientData = this.resourceManager.getClient(socket.id);
        if (!clientData) return;

        const { x: finalX, y: finalY } = this._resolvePoint(socket, data.x, data.y);
        robot.moveMouse(finalX, finalY);
        const button = data.button || "left";
        robot.mouseToggle("down", button);
        this.buttonDown = button;

        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Mouse press error:", error.message);
      }
    }));

    socket.on("mouse-release", requireAuth(async (data) => {
      try {
        const clientData = this.resourceManager.getClient(socket.id);
        if (!clientData) return;

        const { x: finalX, y: finalY } = this._resolvePoint(socket, data.x, data.y);
        robot.moveMouse(finalX, finalY);
        const button = this.buttonDown || data.button || "left";
        robot.mouseToggle("up", button);
        this.buttonDown = null;

        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Mouse release error:", error.message);
      }
    }));

    socket.on("scroll", requireAuth(async (data) => {
      try {
        const { direction, amount = 60, horizontal = false } = data;
        const clientData = this.resourceManager.getClient(socket.id);
        if (!clientData) return;

        let scrollX = 0;
        let scrollY = 0;

        if (horizontal || direction === "left" || direction === "right") {
          scrollX = direction === "right" ? amount : -amount;
        } else {
          scrollY = direction === "down" ? -amount : amount;
        }

        robot.scrollMouse(scrollX, scrollY);

        // Reset idle counter to speed up streaming after scroll
        clientData.idleFrameCount = 0;
        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Scroll error:", error.message);
      }
    }));

    socket.on("mouse-drag-select", requireAuth((data) => {
      try {
        const { x: sx, y: sy } = this._resolvePoint(socket, data.startX, data.startY);
        const { x: ex, y: ey } = this._resolvePoint(socket, data.endX, data.endY);

        robot.moveMouse(sx, sy);
        robot.mouseToggle("down", "left");
        robot.dragMouse(ex, ey);
        robot.mouseToggle("up", "left");

        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Drag selection error:", error.message);
      }
    }));
  }
}
