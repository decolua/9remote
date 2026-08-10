// Exposes the same surface the agent UI already calls through window.__TAURI__,
// so agent/ui/src/lib/tauriBridge.js keeps working unchanged.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__TAURI__", {
  core: {
    invoke: (cmd, args) => ipcRenderer.invoke(cmd, args),
  },
  event: {
    listen: (name, handler) => {
      const wrapped = (_e, payload) => handler({ payload });
      ipcRenderer.on(name, wrapped);
      return Promise.resolve(() => ipcRenderer.off(name, wrapped));
    },
  },
});
