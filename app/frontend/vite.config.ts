import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Dev-only: forward API + SSE to the headless Deno server.
      "/api": { target: "http://127.0.0.1:8747", changeOrigin: false },
    },
  },
  build: { outDir: "dist", sourcemap: false },
});
