import type { EmoteId } from "@vcr/protocol";

export const EMOTE_GLYPHS: Record<EmoteId, string> = {
  wave: "👋",
  laugh: "😂",
  heart: "❤️",
  thumbsUp: "👍",
  dance: "💃",
};

/** How long an emote stays above someone's avatar. */
export const EMOTE_DURATION_MS = 2500;

/** Stable, friendly color per participant. */
export function colorFor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  // Comma syntax: three.js's color parser doesn't accept the space-separated form.
  return `hsl(${Math.abs(hash) % 360}, 70%, 60%)`;
}
