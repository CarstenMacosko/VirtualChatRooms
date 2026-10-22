import { useSyncExternalStore } from "react";

/** A handful of screens, so a tiny History API router instead of a dependency. */
export type Route =
  | { name: "home" }
  | { name: "avatar" }
  | { name: "session"; id: string }
  | { name: "guest"; token: string };

export function parseRoute(pathname: string): Route {
  if (/^\/avatar\/?$/.test(pathname)) return { name: "avatar" };
  const session = /^\/s\/([a-zA-Z0-9_-]{1,64})\/?$/.exec(pathname);
  if (session) return { name: "session", id: session[1]! };
  const guest = /^\/join\/([a-zA-Z0-9_-]{8,64})\/?$/.exec(pathname);
  if (guest) return { name: "guest", token: guest[1]! };
  return { name: "home" };
}

const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
};

export function navigate(path: string, { replace = false } = {}) {
  if (path === window.location.pathname) return;
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  for (const listener of listeners) listener();
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, () => window.location.pathname);
  return parseRoute(pathname);
}
