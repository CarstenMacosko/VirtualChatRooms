import { type ComponentType, lazy } from "react";

const RELOADED_KEY = "vcr.reloadedForBuild";

/**
 * Reloads the page to pick up a new deploy, whose build replaced the hashed chunks this page still
 * points at. At most once a minute, so a real outage shows an error instead of reloading forever.
 * Returns whether it reloaded.
 */
export function reloadForNewBuild(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOADED_KEY));
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(RELOADED_KEY, String(Date.now()));
  } catch {
    return false;
  }
  window.location.reload();
  return true;
}

/** Whether an error is a lazily loaded chunk that couldn't be fetched (or parsed). */
export function isChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /dynamically imported module|module script|Importing a module script failed|error loading dynamically/i.test(
    message,
  );
}

/**
 * `React.lazy` that survives a deploy landing while the page is open: when the chunk is gone it
 * reloads onto the new build instead of failing.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- matches React.lazy's own signature
export function lazyChunk<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((error: unknown) => {
      if (reloadForNewBuild()) return new Promise<never>(() => {});
      throw error;
    }),
  );
}
