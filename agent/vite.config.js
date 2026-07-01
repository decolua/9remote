import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import obfuscator from "vite-plugin-javascript-obfuscator";
import { browserPreset } from "../scripts/obfuscatorConfig.js";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_PORT = 2208;

export default defineConfig({
  root: "ui",
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "ui/src/lib"),
    },
  },
  // Obfuscate all UI code except @xterm — obfuscating xterm breaks alt-screen parsing (TUI apps blank)
  plugins: [preact(), obfuscator({ apply: "build", include: ["**/*.js"], exclude: ["**/node_modules/@xterm/**"], options: browserPreset })],
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
    // Minify breaks xterm.js alt-screen parsing (TUI apps like opencode won't render)
    minify: false,
  },
});
