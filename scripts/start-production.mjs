// Production entry point (Dockerfile): runs the realm and the API side by side. If either stops,
// the other is stopped too and the process exits, so the host (Fly.io) restarts the machine.
import { spawn } from "node:child_process";

const run = (name, cwd) => {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: new URL(cwd, import.meta.url),
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    console.error(`[start] ${name} exited (${signal ?? code}); stopping`);
    shutdown(code ?? 1);
  });
  return child;
};

const children = [run("realm", "../apps/realm/"), run("api", "../apps/api/")];
let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 3000).unref();
}
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
