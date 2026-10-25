import { io } from "socket.io-client";
import { readDevice, relayApi } from "@/shared/aremote/client";
export class RelayAdapter {
  constructor({ socketOptions = {} }) { this.auth = socketOptions.auth || {}; this.cancelled = false; this.socket = null; }
  async connect({ onSocket, onFail }) {
    try {
      const device = readDevice();
      const { ticket } = await relayApi("/api/tickets", { hostId: this.auth.apiKey }, device);
      if (this.cancelled) return;
      const socket = this.socket = io(device.server, { transports: ["websocket"], path: "/relay/client", query: { ticket }, reconnection: false, forceNew: true, timeout: 10000, auth: { deviceId: device.id } });
      socket.once("connect", () => { if (this.cancelled) socket.disconnect(); else onSocket(socket, "relay"); });
      socket.once("connect_error", () => { socket.disconnect(); if (!this.cancelled) onFail?.(); });
    } catch (err) { if (!this.cancelled) onFail?.(err); }
  }
  disconnect() { this.cancelled = true; this.socket?.disconnect(); }
}
