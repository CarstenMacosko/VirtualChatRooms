import { create } from "zustand";
import { recipeForSeed } from "@vcr/avatar";
import { type AvatarRecipe, type ParticipantView, parseRecipe } from "@vcr/protocol";
import { api } from "./api";

/** Guests keep their avatar on this device only (nothing about guests is stored server-side). */
const GUEST_KEY = "vcr.guestAvatar";

export function loadGuestAvatar(): AvatarRecipe | null {
  try {
    return parseRecipe(localStorage.getItem(GUEST_KEY));
  } catch {
    return null;
  }
}

export function saveGuestAvatar(recipe: AvatarRecipe) {
  try {
    localStorage.setItem(GUEST_KEY, JSON.stringify(recipe));
  } catch {
    // Private mode: the avatar lasts for this visit only.
  }
}

interface MyAvatarStore {
  /** null until loaded, or if they haven't made one yet (`made` says which). */
  recipe: AvatarRecipe | null;
  status: "idle" | "loading" | "ready" | "error";
  load(): Promise<void>;
  save(recipe: AvatarRecipe): Promise<void>;
}

/** The signed-in user's saved avatar. */
export const useMyAvatar = create<MyAvatarStore>((set, get) => ({
  recipe: null,
  status: "idle",
  async load() {
    if (get().status === "loading") return;
    set({ status: "loading" });
    try {
      set({ recipe: (await api.myAvatar()).recipe, status: "ready" });
    } catch {
      set({ status: "error" });
    }
  },
  async save(recipe) {
    set({ recipe: (await api.saveAvatar(recipe)).recipe, status: "ready" });
  },
}));

/** Someone's avatar: what they made, or a stable stand-in based on who they are. */
export function recipeOf(p: Pick<ParticipantView, "avatar" | "userId">): AvatarRecipe {
  return parseRecipe(p.avatar) ?? recipeForSeed(p.userId);
}
