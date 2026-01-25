// Mouse Handler for Remote Desktop
import { remoteConfig } from "../config.js";

export class MouseHandler {
  constructor(robot, resourceManager) {
    this.robot = robot;
    this.resourceManager = resourceManager;
    this.lastMouseMove = 0;
  }

  setupMouseHandlers(socket, requireAuth) {
    const robot = this.robot;

    socket.on("mouse-move", requireAuth((data) => {
      const now = Date.now();
      if (now - this.lastMouseMove < remoteConfig.throttling.mouseThrottle) return;
      this.lastMouseMove = now;

      try {
        robot.moveMouse(data.x, data.y);
        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Mouse move error:", error.message);
      }
    }));

    socket.on("mouse-click", requireAuth(async (data) => {
      try {
        const clientData = this.resourceManager.getClient(socket.id);
        if (!clientData) return;

        const dimensions = robot.getScreenSize();
        const pcX = Math.round((data.x / 100) * dimensions.width);
        const pcY = Math.round((data.y / 100) * dimensions.height);
        const finalX = Math.max(0, Math.min(dimensions.width - 1, pcX));
        const finalY = Math.max(0, Math.min(dimensions.height - 1, pcY));

        robot.moveMouse(finalX, finalY);
        robot.mouseClick(data.button || "left", data.double || false);

        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Mouse click error:", error.message);
      }
    }));

    socket.on("mouse-press", requireAuth(async (data) => {
      try {
        const clientData = this.resourceManager.getClient(socket.id);
        if (!clientData) return;

        const dimensions = robot.getScreenSize();
        const pcX = Math.round((data.x / 100) * dimensions.width);
        const pcY = Math.round((data.y / 100) * dimensions.height);
        const finalX = Math.max(0, Math.min(dimensions.width - 1, pcX));
        const finalY = Math.max(0, Math.min(dimensions.height - 1, pcY));

        robot.moveMouse(finalX, finalY);
        robot.mouseToggle("down", data.button || "left");

        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Mouse press error:", error.message);
      }
    }));

    socket.on("mouse-release", requireAuth(async (data) => {
      try {
        const clientData = this.resourceManager.getClient(socket.id);
        if (!clientData) return;

        const dimensions = robot.getScreenSize();
        const pcX = Math.round((data.x / 100) * dimensions.width);
        const pcY = Math.round((data.y / 100) * dimensions.height);
        const finalX = Math.max(0, Math.min(dimensions.width - 1, pcX));
        const finalY = Math.max(0, Math.min(dimensions.height - 1, pcY));

        robot.moveMouse(finalX, finalY);
        robot.mouseToggle("up", data.button || "left");

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
        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Scroll error:", error.message);
      }
    }));

    socket.on("mouse-drag-select", requireAuth((data) => {
      try {
        const { startX, startY, endX, endY } = data;
        const dimensions = robot.getScreenSize();

        const startPcX = Math.round((startX / 100) * dimensions.width);
        const startPcY = Math.round((startY / 100) * dimensions.height);
        const endPcX = Math.round((endX / 100) * dimensions.width);
        const endPcY = Math.round((endY / 100) * dimensions.height);

        const finalStartX = Math.max(0, Math.min(dimensions.width - 1, startPcX));
        const finalStartY = Math.max(0, Math.min(dimensions.height - 1, startPcY));
        const finalEndX = Math.max(0, Math.min(dimensions.width - 1, endPcX));
        const finalEndY = Math.max(0, Math.min(dimensions.height - 1, endPcY));

        robot.moveMouse(finalStartX, finalStartY);
        robot.mouseToggle("down", "left");
        robot.dragMouse(finalEndX, finalEndY);
        robot.mouseToggle("up", "left");

        this.resourceManager.updateClientActivity(socket.id);
      } catch (error) {
        console.error("Drag selection error:", error.message);
      }
    }));
  }
}
