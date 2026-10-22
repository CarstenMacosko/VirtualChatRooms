/**
 * Live avatar headshots for camera-off sidebar tiles (PLAN.md § 4.6). Tiles register a 2D canvas
 * per person; the World's render loop periodically renders that person's avatar face (avatars
 * only, on their own layer) and copies it into the canvas.
 */

export interface HeadshotTarget {
  canvas: HTMLCanvasElement;
  /** Backdrop color behind the face. */
  color: string;
}

/** Participant id → every canvas showing them (a pinned person is in the sidebar too). */
export const headshotTargets = new Map<string, Set<HeadshotTarget>>();

/** Registers a tile's canvas; returns the function that unregisters it. */
export function registerHeadshot(id: string, target: HeadshotTarget): () => void {
  let set = headshotTargets.get(id);
  if (!set) {
    set = new Set();
    headshotTargets.set(id, set);
  }
  set.add(target);
  return () => {
    set.delete(target);
    if (set.size === 0 && headshotTargets.get(id) === set) headshotTargets.delete(id);
  };
}
