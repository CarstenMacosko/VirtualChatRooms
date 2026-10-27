import { useEffect, useState } from "react";

/** How often an open page checks for a newer deploy. */
const CHECK_EVERY_MS = 5 * 60_000;

async function newerBuild(): Promise<boolean> {
  try {
    const res = await fetch("/version.json", { cache: "no-store" });
    if (!res.ok) return false;
    const { build } = (await res.json()) as { build?: unknown };
    return typeof build === "string" && build !== import.meta.env.VITE_BUILD_ID;
  } catch {
    return false;
  }
}

/** Whether this page is in a call, where reloading on its own would drop people. */
const inCall = () => window.location.pathname.startsWith("/s/");

/**
 * Whether a newer version of the app has been deployed since this page loaded. A page left open
 * for days otherwise keeps running the old app. Out of a call, a hidden page reloads by itself;
 * otherwise the caller offers a reload.
 */
export function useAppUpdate(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (import.meta.env.DEV) return;
    let found = false;
    const check = async () => {
      if (!found) found = await newerBuild();
      if (!found) return;
      setReady(true);
      if (document.visibilityState === "hidden" && !inCall()) window.location.reload();
    };
    const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
    const onVisibility = () => void check();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return ready;
}
