import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Read VITE_* variables from the repo-root .env shared by every app.
  envDir: "../..",
  build: {
    // The World chunk carries three.js, Spark and Rapier's inlined WASM (~2.9 MB gzipped). It is
    // lazy-loaded after sign-in and well within the 40 MB room-entry budget (PLAN.md § 7).
    chunkSizeWarningLimit: 9000,
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
