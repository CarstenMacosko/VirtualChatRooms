import { yawFromDirection } from "../math";

/**
 * Conversation groups from where avatars stand (PLAN.md § 4.5, side conversations). People
 * within `joinDistance` of each other, directly or through a chain of neighbours, are one group,
 * the way people at a party drift into circles. Nobody is ever cut off: people outside your group
 * stay audible as background voices.
 *
 * Every client computes the same groups from the same avatar positions; nothing is stored on
 * the server.
 */

export interface ClusterOptions {
  /** Standing this close (meters) puts two people in the same group. */
  joinDistance: number;
  /**
   * Two people who were standing close stay linked until this far apart, so a step back doesn't
   * flicker. Only direct neighbours: being in the same group through others doesn't hold you.
   */
  leaveDistance: number;
  /** Below this many people the whole call is one conversation. */
  minPeople: number;
}

export const CLUSTER_DEFAULTS: ClusterOptions = {
  joinDistance: 2.5,
  leaveDistance: 3,
  minPeople: 4,
};

export interface Placed {
  id: string;
  x: number;
  z: number;
}

export interface Clusters {
  /** Each person's group: the smallest id in it, so a group keeps its label while its members stay. */
  labels: Map<string, string>;
  /** Pairs standing close enough to hold each other in the group (for the next round). */
  links: Set<string>;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Groups `people`; `previous` is the last result, for the hysteresis. */
export function clusterPeople(
  people: readonly Placed[],
  previous: Clusters | null = null,
  options: Partial<ClusterOptions> = {},
): Clusters {
  const { joinDistance, leaveDistance, minPeople } = { ...CLUSTER_DEFAULTS, ...options };
  const parent = people.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  };
  const links = new Set<string>();
  if (people.length < minPeople) {
    for (let i = 1; i < people.length; i++) parent[i] = 0;
  } else {
    for (let a = 0; a < people.length; a++) {
      for (let b = a + 1; b < people.length; b++) {
        const pa = people[a]!;
        const pb = people[b]!;
        const d = Math.hypot(pa.x - pb.x, pa.z - pb.z);
        const key = pairKey(pa.id, pb.id);
        const held = previous?.links.has(key) ?? false;
        if (d <= joinDistance || (held && d <= leaveDistance)) {
          links.add(key);
          parent[find(a)] = find(b);
        }
      }
    }
  }
  const label = new Map<number, string>();
  people.forEach((p, i) => {
    const root = find(i);
    const current = label.get(root);
    if (current === undefined || p.id < current) label.set(root, p.id);
  });
  return { labels: new Map(people.map((p, i) => [p.id, label.get(find(i))!])), links };
}

/** Gap between you and the group's outermost person when you join it. */
const JOIN_SPACING = 1;
/** Keep joining spots this far inside the room's walls. */
const WALL_MARGIN = 0.4;

/**
 * Where to stand to join a group without walking there (the video grid): at the edge of the
 * circle, inside the room, on the side farthest from everyone else, so you don't link another
 * group to this one. Returns feet x/z and the yaw that faces the group.
 */
export function joinSpot(
  members: readonly Placed[],
  others: readonly Placed[],
  bounds: { min: readonly number[]; max: readonly number[] },
): { x: number; z: number; yaw: number } | null {
  if (!members.length) return null;
  const cx = members.reduce((sum, m) => sum + m.x, 0) / members.length;
  const cz = members.reduce((sum, m) => sum + m.z, 0) / members.length;
  const spread = Math.max(0, ...members.map((m) => Math.hypot(m.x - cx, m.z - cz)));
  const inside = (x: number, z: number) =>
    x >= bounds.min[0]! + WALL_MARGIN &&
    x <= bounds.max[0]! - WALL_MARGIN &&
    z >= bounds.min[2]! + WALL_MARGIN &&
    z <= bounds.max[2]! - WALL_MARGIN;
  let best: { x: number; z: number; score: number } | null = null;
  for (const radius of [spread + JOIN_SPACING, Math.max(0.6, spread + JOIN_SPACING / 2)]) {
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const x = cx + Math.sin(angle) * radius;
      const z = cz + Math.cos(angle) * radius;
      if (!inside(x, z)) continue;
      const score = Math.min(Infinity, ...others.map((o) => Math.hypot(o.x - x, o.z - z)));
      if (!best || score > best.score) best = { x, z, score };
    }
    if (best) break;
  }
  // A group in a tight corner: squeeze in at the middle.
  const spot = best ?? { x: cx, z: cz };
  return { x: spot.x, z: spot.z, yaw: yawFromDirection(cx - spot.x, cz - spot.z) };
}
