import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** This build's id: the client compares it with /version.json to notice a newer deploy. */
const BUILD_ID = Date.now().toString(36);

/** Writes /version.json next to the build, for open pages to check against (lib/appUpdate.ts). */
function buildVersion(): Plugin {
  return {
    name: "vcr-build-version",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ build: BUILD_ID }),
      });
    },
  };
}

/** Dev only: saves the built-in room models the browser exports (world/exportRoomModels.ts). */
function saveRoomModels(): Plugin {
  const dir = fileURLToPath(new URL("public/rooms/", import.meta.url));
  return {
    name: "vcr-save-room-models",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__dev/room-model/", (req, res) => {
        const id = req.url?.slice(1) ?? "";
        if (req.method !== "POST" || !/^[a-z-]+$/.test(id)) {
          res.statusCode = 400;
          return res.end();
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          mkdirSync(dir, { recursive: true });
          writeFileSync(`${dir}${id}.glb`, Buffer.concat(chunks));
          res.end("saved");
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), buildVersion(), saveRoomModels()],
  define: { "import.meta.env.VITE_BUILD_ID": JSON.stringify(BUILD_ID) },
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
    // `pnpm share` serves this dev server at a public *.trycloudflare.com address.
    allowedHosts: [".trycloudflare.com"],
    // Everything the browser needs comes from this one origin, so a single tunnel (or a single
    // deployed domain) carries the whole app.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/realm": {
        target: "http://127.0.0.1:2567",
        ws: true,
        rewrite: (path) => path.replace(/^\/realm/, ""),
      },
    },
  },
});
