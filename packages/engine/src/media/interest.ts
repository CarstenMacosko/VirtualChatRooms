/**
 * Who you hear and whose video tiles you see first (PLAN.md § 4.5). Pure functions over positions
 * and speaking times, so the browser media layer stays thin and these stay testable.
 */

export interface Positioned {
  id: string;
  x: number;
  z: number;
}

export interface AudibleOptions {
  /** Most people subscribed for audio at once. */
  maxCount: number;
  /** Metres; anyone farther is silent anyway after distance attenuation. */
  radius: number;
}

export const AUDIBLE_DEFAULTS: AudibleOptions = { maxCount: 20, radius: 20 };

/** The nearest people within `radius`, at most `maxCount` of them. */
export function selectAudible(
  listener: { x: number; z: number },
  others: readonly Positioned[],
  options: Partial<AudibleOptions> = {},
): Set<string> {
  const { maxCount, radius } = { ...AUDIBLE_DEFAULTS, ...options };
  return new Set(
    others
      .map((o) => ({ id: o.id, d: Math.hypot(o.x - listener.x, o.z - listener.z) }))
      .filter((o) => o.d <= radius)
      .sort((a, b) => a.d - b.d)
      .slice(0, maxCount)
      .map((o) => o.id),
  );
}

export interface TileOrderInput {
  selfId: string;
  ids: readonly string[];
  pinnedId?: string | null;
  /** When each person last spoke (ms, same clock as `now`). */
  lastSpokeAt: ReadonlyMap<string, number>;
  /** Distance from you, when known. */
  distance: ReadonlyMap<string, number>;
  now: number;
  /** How long someone counts as a recent speaker. */
  recentMs?: number;
}

/**
 * FaceTime-style sidebar order: you, then whoever you pinned, then recent speakers (most recent
 * first), then everyone else nearest first.
 */
export function orderTiles(input: TileOrderInput): string[] {
  const { selfId, pinnedId, lastSpokeAt, distance, now, recentMs = 10_000 } = input;
  const rest = input.ids.filter((id) => id !== selfId && id !== pinnedId);
  const spokeAt = (id: string) => {
    const t = lastSpokeAt.get(id);
    return t !== undefined && now - t <= recentMs ? t : null;
  };
  rest.sort((a, b) => {
    const sa = spokeAt(a);
    const sb = spokeAt(b);
    if (sa !== null || sb !== null) return (sb ?? -Infinity) - (sa ?? -Infinity);
    const da = distance.get(a) ?? Infinity;
    const db = distance.get(b) ?? Infinity;
    return da === db ? a.localeCompare(b) : da - db;
  });
  const head = [selfId];
  if (pinnedId && pinnedId !== selfId && input.ids.includes(pinnedId)) head.push(pinnedId);
  return input.ids.includes(selfId) ? [...head, ...rest] : [...head.slice(1), ...rest];
}
