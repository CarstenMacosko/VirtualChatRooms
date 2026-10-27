/**
 * A small geometry kit for building stylized avatars from smooth primitives. Every part is
 * rigidly bound to one bone and belongs to one material; parts may carry morph targets (for
 * facial expressions) as position deltas.
 */

export type V3 = [number, number, number];

export interface Part {
  material: string;
  bone: string;
  positions: number[];
  indices: number[];
  normals: number[];
  /** Morph target name → per-vertex position deltas (same length as `positions`). */
  morphs: Map<string, number[]>;
}

/** Turns a point on the unit sphere (its normal) into a position. */
export type Shaper = (n: V3) => V3;

export interface SphereOptions {
  rings?: number;
  segments?: number;
  /** Keep only triangles whose three vertices pass (by their unit-sphere normal). */
  keep?: (n: V3) => boolean;
}

/**
 * The workhorse: a UV sphere whose vertices are placed by `shape`. Morph targets are other
 * shapers evaluated on the same unit normals, so each target is an exact alternative shape.
 */
export function shapedSphere(
  material: string,
  bone: string,
  shape: Shaper,
  options: SphereOptions = {},
  morphShapes: Record<string, Shaper> = {},
): Part {
  const rings = options.rings ?? 14;
  const segments = options.segments ?? 22;
  const units: V3[] = [];
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      // Starting at the back puts the seam where hair usually covers it.
      const theta = Math.PI + (j / segments) * Math.PI * 2;
      units.push([Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta)]);
    }
  }
  const indices: number[] = [];
  const row = segments + 1;
  const keep = options.keep;
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * row + j;
      const b = a + row;
      for (const tri of [
        [a, b, a + 1],
        [a + 1, b, b + 1],
      ] as const) {
        if (!keep || tri.every((k) => keep(units[k]!))) indices.push(...tri);
      }
    }
  }
  const positions = units.flatMap(shape);
  const part: Part = { material, bone, positions, indices, normals: [], morphs: new Map() };
  for (const [name, morph] of Object.entries(morphShapes)) {
    const target = units.flatMap(morph);
    part.morphs.set(
      name,
      target.map((v, i) => v - positions[i]!),
    );
  }
  return withNormals(part);
}

/** An axis-aligned ellipsoid; `box` < 1 squares it off (a superellipsoid, for shoes and torsos). */
export function ellipsoid(center: V3, radii: V3, box = 1): Shaper {
  return (n) => {
    const s = (v: number) => (box === 1 ? v : Math.sign(v) * Math.abs(v) ** box);
    return [
      center[0] + s(n[0]) * radii[0],
      center[1] + s(n[1]) * radii[1],
      center[2] + s(n[2]) * radii[2],
    ];
  };
}

/** Rotates a shaper's output around Z (in the XY plane) about `pivot`. */
export function rotateZ(shape: Shaper, pivot: V3, angle: number): Shaper {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return (n) => {
    const p = shape(n);
    const x = p[0] - pivot[0];
    const y = p[1] - pivot[1];
    return [pivot[0] + x * c - y * s, pivot[1] + x * s + y * c, p[2]];
  };
}

/**
 * A capsule from `a` to `b` whose radius tapers from `ra` to `rb`: limbs, necks, sleeves. Built
 * as a lathe around the a→b axis.
 */
export function capsule(
  material: string,
  bone: string,
  a: V3,
  b: V3,
  ra: number,
  rb: number,
  segments = 16,
): Part {
  const axis: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const length = Math.hypot(...axis);
  const u: V3 = [axis[0] / length, axis[1] / length, axis[2] / length];
  // Any vector not parallel to u, crossed twice, gives the lathe's two radial directions.
  const helper: V3 = Math.abs(u[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const v = normalize(cross(u, helper));
  const w = cross(u, v);
  const profile: [number, number][] = [];
  const capRings = 5;
  for (let i = 0; i <= capRings; i++) {
    const phi = -Math.PI / 2 + (i / capRings) * (Math.PI / 2);
    profile.push([ra * Math.cos(phi), ra * Math.sin(phi)]);
  }
  for (let i = 0; i <= capRings; i++) {
    const phi = (i / capRings) * (Math.PI / 2);
    profile.push([rb * Math.cos(phi), length + rb * Math.sin(phi)]);
  }
  const positions: number[] = [];
  for (const [r, h] of profile) {
    for (let j = 0; j <= segments; j++) {
      const theta = (j / segments) * Math.PI * 2;
      const c = Math.cos(theta) * r;
      const s = Math.sin(theta) * r;
      for (let k = 0; k < 3; k++) positions.push(a[k]! + u[k]! * h + v[k]! * c + w[k]! * s);
    }
  }
  const indices: number[] = [];
  const row = segments + 1;
  for (let i = 0; i < profile.length - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const p = i * row + j;
      const q = p + row;
      indices.push(p, p + 1, q, p + 1, q + 1, q);
    }
  }
  return withNormals({ material, bone, positions, indices, normals: [], morphs: new Map() });
}

/**
 * A surface patch: a `rows` × `cols` grid placed by `at(u, v)` (both 0…1). With u running down
 * and v running toward +X, it faces +Z: shirt fronts and lapels laid onto the chest.
 */
export function patch(
  material: string,
  bone: string,
  rows: number,
  cols: number,
  at: (u: number, v: number) => V3,
): Part {
  const positions: number[] = [];
  for (let i = 0; i <= rows; i++) {
    for (let j = 0; j <= cols; j++) positions.push(...at(i / rows, j / cols));
  }
  const indices: number[] = [];
  const row = cols + 1;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * row + j;
      const b = a + row;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  return withNormals({ material, bone, positions, indices, normals: [], morphs: new Map() });
}

/** A ring (glasses frames, collars), lying in the plane perpendicular to `normal`. */
export function torus(
  material: string,
  bone: string,
  center: V3,
  normal: V3,
  radius: number,
  tube: number,
  scale: [number, number] = [1, 1],
  segments = 28,
  sides = 8,
  /** Rotates where the ring starts; with 4 segments, π/4 makes a square frame. */
  startAngle = 0,
): Part {
  const n = normalize(normal);
  const helper: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const v = normalize(cross(helper, n));
  const w = cross(n, v);
  const positions: number[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = startAngle + (i / segments) * Math.PI * 2;
    const ring: V3 = [0, 1, 2].map(
      (k) =>
        center[k]! + (v[k]! * Math.cos(a) * scale[0] + w[k]! * Math.sin(a) * scale[1]) * radius,
    ) as V3;
    const out = normalize([0, 1, 2].map((k) => ring[k]! - center[k]!) as V3);
    for (let j = 0; j <= sides; j++) {
      const b = (j / sides) * Math.PI * 2;
      for (let k = 0; k < 3; k++) {
        positions.push(ring[k]! + (out[k]! * Math.cos(b) + n[k]! * Math.sin(b)) * tube);
      }
    }
  }
  const indices: number[] = [];
  const row = sides + 1;
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const p = i * row + j;
      const q = p + row;
      indices.push(p, q, p + 1, p + 1, q, q + 1);
    }
  }
  return withNormals({ material, bone, positions, indices, normals: [], morphs: new Map() });
}

/** Smooth vertex normals from the triangles actually kept. */
function withNormals(part: Part): Part {
  const { positions: p, indices } = part;
  const normals = new Float64Array(p.length);
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [indices[i]! * 3, indices[i + 1]! * 3, indices[i + 2]! * 3];
    const e1: V3 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const e2: V3 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const n = cross(e1, e2);
    for (const v of [a, b, c]) {
      for (let k = 0; k < 3; k++) normals[v + k] = normals[v + k]! + n[k]!;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1;
    for (let k = 0; k < 3; k++) normals[i + k] = normals[i + k]! / len;
  }
  // Seams (where the sphere wraps around, and at the poles) have duplicate vertices; average
  // their normals so shading doesn't show a line there.
  const shared = new Map<string, number[]>();
  for (let i = 0; i < p.length; i += 3) {
    const key = `${p[i]!.toFixed(5)},${p[i + 1]!.toFixed(5)},${p[i + 2]!.toFixed(5)}`;
    const list = shared.get(key);
    if (list) list.push(i);
    else shared.set(key, [i]);
  }
  for (const list of shared.values()) {
    if (list.length < 2) continue;
    const sum: V3 = [0, 0, 0];
    for (const i of list) for (let k = 0; k < 3; k++) sum[k] = sum[k]! + normals[i + k]!;
    const n = normalize(sum);
    for (const i of list) for (let k = 0; k < 3; k++) normals[i + k] = n[k]!;
  }
  part.normals = Array.from(normals);
  return part;
}

export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function normalize(v: V3): V3 {
  const len = Math.hypot(...v) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
