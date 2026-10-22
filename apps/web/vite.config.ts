import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Read VITE_* variables from the repo-root .env shared by every app.
  envDir: "../..",
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
