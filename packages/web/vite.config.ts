import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Client build.
 *
 * The dev server proxies `/api` (including the WebSocket upgrade) to the Bun
 * server on port 8000, so `bun run dev` serves both halves on one origin;
 * `bun run build` emits the static bundle the server hosts from `dist/`.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
});
