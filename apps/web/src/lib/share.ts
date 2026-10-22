import { useEffect, useState } from "react";
import { api } from "./api";

/** Whether this page is being viewed through a `pnpm share` link (not on the host's computer). */
export const viewingShared = () => window.location.hostname.endsWith(".trycloudflare.com");

/**
 * The public link `pnpm share` is serving, if any (development only). Polled, so the home
 * screen notices when you start or stop sharing.
 */
export function useShareUrl(pollMs = 10_000): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const check = () =>
      api
        .share()
        .then((s) => active && setUrl(s.url))
        .catch(() => active && setUrl(null));
    void check();
    const timer = setInterval(check, pollMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [pollMs]);
  return url;
}

/** Where people outside this computer should go: the share link if sharing, else this origin. */
export const publicOrigin = (shareUrl: string | null) => shareUrl ?? window.location.origin;
