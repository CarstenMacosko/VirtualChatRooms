import { create } from "zustand";
import { DevLoginResponse } from "@vcr/protocol";

const STORAGE_KEY = "vcr.auth";

function loadStored(): DevLoginResponse | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? DevLoginResponse.parse(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * The sign-in provider behind real accounts (Clerk), when configured. It can mint a fresh
 * session for the same person when ours expires, and sign them out of the provider too.
 */
export interface AuthProvider {
  refresh(): Promise<DevLoginResponse | null>;
  signOut(): Promise<void>;
}

let provider: AuthProvider | null = null;
let refreshing: Promise<boolean> | null = null;

export function setAuthProvider(next: AuthProvider | null) {
  provider = next;
}

interface AuthStore {
  auth: DevLoginResponse | null;
  signIn(auth: DevLoginResponse): void;
  signOut(): void;
}

export const useAuth = create<AuthStore>((set) => ({
  auth: loadStored(),
  signIn(auth) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
    } catch {
      // Storage unavailable (private mode): stay signed in for this tab only.
    }
    set({ auth });
  },
  signOut() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    set({ auth: null });
    void provider?.signOut().catch(() => {});
  },
}));

/**
 * Our session token expired (or was rejected): get a new one from the provider without
 * bothering the person. Resolves false if they really need to sign in again. Concurrent callers
 * share one attempt.
 */
export function refreshSession(): Promise<boolean> {
  if (!provider) return Promise.resolve(false);
  refreshing ??= provider
    .refresh()
    .then((auth) => {
      if (auth) useAuth.getState().signIn(auth);
      return auth !== null;
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/**
 * Whether a session token (a JWT) has expired, or will within `skewSeconds`. A token we can't
 * read counts as fresh: the API has the final say.
 */
export function tokenExpired(token: string, skewSeconds = 30, now = Date.now()): boolean {
  try {
    const payload = token.split(".")[1];
    if (!payload) return false;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const { exp } = JSON.parse(json) as { exp?: unknown };
    return typeof exp === "number" && exp * 1000 < now + skewSeconds * 1000;
  } catch {
    return false;
  }
}

/**
 * The session token to send, renewed first when it has expired and the provider can renew it,
 * so a page opened after a while doesn't send every first request just to have it refused.
 */
export async function currentToken(): Promise<string | undefined> {
  const token = useAuth.getState().auth?.token;
  if (token && provider && tokenExpired(token)) await refreshSession();
  return useAuth.getState().auth?.token;
}
