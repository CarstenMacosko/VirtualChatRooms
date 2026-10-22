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
  },
}));
