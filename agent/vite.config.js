import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

const AGENT_PORT = 2208;

export default defineConfig({
  root: "ui",
  plugins: [preact()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://localhost:${AGENT_PORT}`,
        changeOrigin: true,
      },
      "/socket.io": {
        target: `http://localhost:${AGENT_PORT}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
