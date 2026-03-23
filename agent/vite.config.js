import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

const SERVER_PORT = 2208;

export default defineConfig({
  plugins: [preact()],
  root: "ui",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: ["es2021", "chrome105", "safari15"],
    minify: "esbuild",
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${SERVER_PORT}`,
      "/socket.io": {
        target: `http://localhost:${SERVER_PORT}`,
        ws: true,
      },
    },
  },
});
