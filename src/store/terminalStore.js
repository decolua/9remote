import { create } from "zustand";

export const useTerminalStore = create((set) => ({
  connected: false,
  ws: null,
  sessionId: null,
  
  setConnected: (connected) => set({ connected }),
  setWs: (ws) => set({ ws }),
  setSessionId: (sessionId) => set({ sessionId }),
  
  connect: (sessionId) => {
    set({ sessionId, connected: true });
  },
  
  disconnect: () => {
    set({ connected: false, ws: null, sessionId: null });
  },
  
  send: (data) => {
    const { ws } = useTerminalStore.getState();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}));
