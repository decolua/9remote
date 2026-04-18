import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import obfuscator from "vite-plugin-javascript-obfuscator";
import { browserPreset } from "../scripts/obfuscatorConfig.js";

const AGENT_PORT = 2208;

export default defineConfig({
  root: "ui",
  plugins: [preact(), obfuscator({ apply: "build", include: ["**/*.js"], options: browserPreset })],
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
    outDir: "../dist/ui",
    emptyOutDir: true,
  },
});
