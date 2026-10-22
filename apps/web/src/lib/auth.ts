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
