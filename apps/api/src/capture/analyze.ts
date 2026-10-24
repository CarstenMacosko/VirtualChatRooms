import { rotationToYUp, type ScaleSource, type Seat, type Table, type UpAxis } from "@vcr/protocol";
import { detectFurniture } from "./furniture";
import type { SplatPoints } from "./splatFile";

/**
 * Post-processing for an imported scan (PLAN.md § 4.1, stages 3–6), on splat centers alone:
 *
 * 1. **Up and floor.** Phone exports are gravity-aligned but disagree on which axis is up (ARKit
 *    apps use +Y, 3DGS trainers often −Y, some tools +Z). The floor is the biggest flat layer at
 *    one end of an axis, with most of the room's content close to it; a plane fit then removes
 *    any small tilt.
 * 2. **Walls square to the axes.** A yaw search makes wall layers as sharp as possible, so the
 *    collision boxes hug them.
 * 3. **Scale.** Scaniverse and Polycam export meters (ARKit). If the room's height doesn't look
 *    like meters, assume a 2.5 m ceiling; the owner can correct it.
 * 4. **Collision (ADR 0002).** A grid over the floor: a cell is walkable if it has floor and
 *    nothing at body height. Everything around the largest walkable area becomes boxes (walls and
 *    furniture to their measured height, unscanned space to the ceiling), plus raised floor for
 *    steps. You can't walk through walls, or off the edge of the scan.
 * 5. **Spawn points** where there's the most open floor.
 * 6. **Seats and tables** suggested from flat surfaces at sitting and table height (furniture.ts).
 *
 * Everything below is in "world" coordinates (meters, +Y up, floor at 0, centered on the floor)
 * unless it says file space.
 */

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

export interface Box {
  center: Vec3;
  halfExtents: Vec3;
}

export interface AnalyzeOptions {
  /** Take this file axis as up instead of detecting it. */
  up?: UpAxis;
  /** Scale the room to this height instead of estimating it. */
  heightMeters?: number;
}

export interface RoomAnalysis {
  transform: {
    metersPerUnit: number;
    rotation: Quat;
    translation: Vec3;
    up: Vec3;
    floorY: number;
    scaleSource: ScaleSource;
  };
  upAxis: UpAxis | null;
  bounds: { min: Vec3; max: Vec3 };
  spawnPoints: Array<{ position: Vec3; yaw: number }>;
  boxes: Box[];
  /** Suggested seats and tables (`source: "auto"`), world space. */
  seats: Seat[];
  tables: Table[];
  size: { width: number; depth: number; height: number };
  /** Grid diagnostics, for tests and tuning. */
  grid: { cell: number; walkableCells: number };
}

export class RoomAnalysisError extends Error {
  override name = "RoomAnalysisError";
}

/** Splats fainter than this are mostly haze and floaters. */
const MIN_OPACITY = 0.15;
/** Rooms between these heights (file units) are taken to already be in meters. */
const METRIC_HEIGHT = [1.9, 4.5] as const;
const ASSUMED_CEILING_M = 2.5;
/** Body band: anything here blocks walking (above a step, below head height). */
const BODY_BAND_M = [0.3, 1.9] as const;
const FLOOR_BAND_M = [-0.12, 0.3] as const;
const MIN_FLOOR_AREA_M2 = 1.5;
const HEIGHT_STEP_M = 0.25;

const AXES: Record<UpAxis, Vec3> = {
  "+x": [1, 0, 0],
  "-x": [-1, 0, 0],
  "+y": [0, 1, 0],
  "-y": [0, -1, 0],
  "+z": [0, 0, 1],
  "-z": [0, 0, -1],
};

// --- small math -----------------------------------------------------------------------------

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** Rotation matrix (row-major 3×3) of a unit quaternion. */
export function qmatrix([x, y, z, w]: Quat): number[] {
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}

export function qrotate(q: Quat, v: Vec3): Vec3 {
  const m = qmatrix(q);
  return [
    m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2],
    m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2],
    m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2],
  ];
}

function rotateAll(points: Float32Array, q: Quat): Float32Array {
  const m = qmatrix(q);
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i]!;
    const y = points[i + 1]!;
    const z = points[i + 2]!;
    out[i] = m[0]! * x + m[1]! * y + m[2]! * z;
    out[i + 1] = m[3]! * x + m[4]! * y + m[5]! * z;
    out[i + 2] = m[6]! * x + m[7]! * y + m[8]! * z;
  }
  return out;
}

/** Quantiles of `values` (every `stride`-th from `offset`), over at most ~200k of them. */
function quantilesOf(
  values: Float32Array,
  qs: readonly number[],
  stride = 1,
  offset = 0,
): number[] {
  const n = Math.floor((values.length - offset + stride - 1) / stride);
  const step = Math.max(1, Math.floor(n / 200_000));
  const picked = new Float32Array(Math.ceil(n / step));
  let k = 0;
  for (let i = 0; i < n; i += step) picked[k++] = values[i * stride + offset]!;
  const sorted = picked.subarray(0, k).sort();
  return qs.map((q) => sorted[Math.min(k - 1, Math.max(0, Math.round(q * (k - 1))))]!);
}

/** Quantiles of one coordinate (0, 1 or 2) of interleaved xyz points. */
const quantiles = (points: Float32Array, axis: number, qs: readonly number[]) =>
  quantilesOf(points, qs, 3, axis);

/** Eigenvector for the smallest eigenvalue of a symmetric 3×3 matrix (Jacobi rotations). */
function smallestEigenvector(c: number[]): Vec3 {
  const a = [...c];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p * 3 + q]!;
      off += Math.abs(apq);
      if (Math.abs(apq) < 1e-15) continue;
      const theta = (a[q * 3 + q]! - a[p * 3 + p]!) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cos = 1 / Math.sqrt(t * t + 1);
      const sin = t * cos;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p]!;
        const akq = a[k * 3 + q]!;
        a[k * 3 + p] = cos * akp - sin * akq;
        a[k * 3 + q] = sin * akp + cos * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k]!;
        const aqk = a[q * 3 + k]!;
        a[p * 3 + k] = cos * apk - sin * aqk;
        a[q * 3 + k] = sin * apk + cos * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p]!;
        const vkq = v[k * 3 + q]!;
        v[k * 3 + p] = cos * vkp - sin * vkq;
        v[k * 3 + q] = sin * vkp + cos * vkq;
      }
    }
    if (off < 1e-12) break;
  }
  const diag = [a[0]!, a[4]!, a[8]!];
  const i = diag.indexOf(Math.min(...diag));
  return [v[i]!, v[3 + i]!, v[6 + i]!];
}

// --- 1. up and floor ------------------------------------------------------------------------

interface Layer {
  /** Height (along the direction) of the densest layer near the low end. */
  height: number;
  /** Fraction of all points in that layer. */
  fraction: number;
  /** Bin width used. */
  bin: number;
}

/** The densest thin layer within the lowest `within` of the range of heights along `dir`. */
function lowLayer(points: Float32Array, dir: Vec3, within = 0.25, bins = 200): Layer {
  const n = points.length / 3;
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    heights[i] =
      points[i * 3]! * dir[0] + points[i * 3 + 1]! * dir[1] + points[i * 3 + 2]! * dir[2];
  }
  const [lo, hi] = quantilesOf(heights, [0.005, 0.995]);
  const bin = Math.max((hi! - lo!) / bins, 1e-6);
  const hist = new Float64Array(bins);
  for (const h of heights) {
    const b = Math.floor((h - lo!) / bin);
    if (b >= 0 && b < bins) hist[b]! += 1;
  }
  let best = 0;
  let bestSum = -1;
  for (let b = 0; b < Math.ceil(bins * within); b++) {
    const sum = (hist[b - 1] ?? 0) + hist[b]! + (hist[b + 1] ?? 0);
    if (sum > bestSum) {
      bestSum = sum;
      best = b;
    }
  }
  return { height: lo! + (best + 0.5) * bin, fraction: bestSum / n, bin };
}

/**
 * Picks up among the six axis directions: the one whose low end has the biggest flat layer,
 * favoring the room's shortest dimension (rooms are wider than they are tall), directions where
 * most content sits in the lower half (furniture stands on floors; ceilings are often missing
 * from scans) and the Y axis (what most exporters use).
 */
export function detectUpAxis(points: Float32Array): UpAxis {
  const sample = subsample(points, 200_000);
  const ranges = [0, 1, 2].map((a) => {
    const [lo, hi] = quantiles(sample, a, [0.02, 0.98]);
    return hi! - lo!;
  });
  const shortest = ranges.indexOf(Math.min(...ranges));
  let best: UpAxis = "+y";
  let bestScore = -1;
  for (const [axis, dir] of Object.entries(AXES) as Array<[UpAxis, Vec3]>) {
    const layer = lowLayer(sample, dir, 0.2, 100);
    const a = dir.findIndex((c) => c !== 0);
    const [lo, mid, hi] = quantiles(sample, a, [0.005, 0.5, 0.995]);
    const range = hi! - lo! || 1;
    const lowHalf = dir[a]! > 0 ? (mid! - lo!) / range < 0.5 : (hi! - mid!) / range < 0.5;
    const score =
      layer.fraction * (lowHalf ? 1.3 : 1) * (a === shortest ? 1.5 : 1) * (a === 1 ? 1.25 : 1);
    if (score > bestScore) {
      bestScore = score;
      best = axis;
    }
  }
  return best;
}

function subsample(points: Float32Array, max: number): Float32Array {
  const n = points.length / 3;
  if (n <= max) return points;
  const step = n / max;
  const out = new Float32Array(max * 3);
  for (let k = 0; k < max; k++) {
    const i = Math.floor(k * step) * 3;
    out[k * 3] = points[i]!;
    out[k * 3 + 1] = points[i + 1]!;
    out[k * 3 + 2] = points[i + 2]!;
  }
  return out;
}

/**
 * Fits the floor plane near `dir` (RANSAC over the lowest quarter of the room, then least
 * squares on the inliers) to correct a small tilt. Keeps `dir` if no plane within 15° fits.
 */
export function refineUp(points: Float32Array, dir: Vec3): Vec3 {
  const sample = subsample(points, 200_000);
  const n = sample.length / 3;
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    heights[i] =
      sample[i * 3]! * dir[0] + sample[i * 3 + 1]! * dir[1] + sample[i * 3 + 2]! * dir[2];
  }
  const [lo, hi] = quantilesOf(heights, [0.005, 0.995]);
  const band = lo! + 0.25 * (hi! - lo!);
  const tolerance = ((hi! - lo!) / 200) * 1.5;
  const candidates: Vec3[] = [];
  const every = Math.max(1, Math.floor(n / 150_000));
  for (let i = 0; i < n; i += every) {
    if (heights[i]! <= band)
      candidates.push([sample[i * 3]!, sample[i * 3 + 1]!, sample[i * 3 + 2]!]);
  }
  if (candidates.length < 100) return dir;
  // Score hypotheses on a subset; deterministic, so the same scan always gives the same room.
  const scoring = candidates.filter(
    (_, i) => i % Math.max(1, Math.floor(candidates.length / 8000)) === 0,
  );
  const rand = mulberry(12345);
  const pick = () => candidates[Math.floor(rand() * candidates.length)]!;
  const minCos = Math.cos((15 * Math.PI) / 180);
  let best: { normal: Vec3; offset: number; inliers: number } | null = null;
  for (let iter = 0; iter < 400; iter++) {
    const a = pick();
    const b = pick();
    const c = pick();
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let normal: Vec3 = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ];
    const len = Math.hypot(...normal);
    if (len < 1e-12) continue;
    normal = normal.map((x) => x / len) as Vec3;
    if (dot(normal, dir) < 0) normal = normal.map((x) => -x) as Vec3;
    if (dot(normal, dir) < minCos) continue;
    const offset = dot(normal, a);
    let inliers = 0;
    for (const p of scoring) if (Math.abs(dot(normal, p) - offset) < tolerance) inliers++;
    if (!best || inliers > best.inliers) best = { normal, offset, inliers };
  }
  if (!best) return dir;

  // Least squares on every inlier of the winning plane, twice (the second with a tighter fit).
  let { normal, offset } = best;
  for (let round = 0; round < 2; round++) {
    const inliers = candidates.filter((p) => Math.abs(dot(normal, p) - offset) < tolerance);
    if (inliers.length < 50) break;
    const mean: Vec3 = [0, 0, 0];
    for (const p of inliers) for (let k = 0; k < 3; k++) mean[k]! += p[k]! / inliers.length;
    const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (const p of inliers) {
      const d = [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) cov[r * 3 + c]! += d[r]! * d[c]!;
    }
    let fit = smallestEigenvector(cov);
    const len = Math.hypot(...fit);
    fit = fit.map((x) => x / len) as Vec3;
    if (dot(fit, dir) < 0) fit = fit.map((x) => -x) as Vec3;
    if (dot(fit, dir) < minCos) break;
    normal = fit;
    offset = dot(fit, mean);
  }
  return normal;
}

/** Small deterministic PRNG. */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 2. walls square to the axes -------------------------------------------------------------

/** Rotation about +Y (radians, in [0, π/2)) that lines the walls up with X and Z. */
export function wallYaw(points: Float32Array): number {
  const sample = subsample(points, 60_000);
  const [ylo, yhi] = quantiles(sample, 1, [0.02, 0.98]);
  const [mx] = quantiles(sample, 0, [0.5]);
  const [mz] = quantiles(sample, 2, [0.5]);
  const xs: number[] = [];
  const zs: number[] = [];
  for (let i = 0; i < sample.length; i += 3) {
    const y = sample[i + 1]!;
    // Mid-height: walls and the sides of furniture, not the floor or ceiling.
    if (y < ylo! + 0.15 * (yhi! - ylo!) || y > ylo! + 0.85 * (yhi! - ylo!)) continue;
    xs.push(sample[i]! - mx!);
    zs.push(sample[i + 2]! - mz!);
  }
  if (xs.length < 100) return 0;
  let radius = 0;
  for (let i = 0; i < xs.length; i++) radius = Math.max(radius, Math.hypot(xs[i]!, zs[i]!));
  const bins = 300;
  const width = (2 * radius) / bins || 1;
  const hx = new Float64Array(bins + 1);
  const hz = new Float64Array(bins + 1);
  const sharpness = (theta: number) => {
    hx.fill(0);
    hz.fill(0);
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    for (let i = 0; i < xs.length; i++) {
      const x = c * xs[i]! + s * zs[i]!;
      const z = -s * xs[i]! + c * zs[i]!;
      hx[Math.floor((x + radius) / width)]! += 1;
      hz[Math.floor((z + radius) / width)]! += 1;
    }
    let score = 0;
    for (let b = 0; b <= bins; b++) score += hx[b]! * hx[b]! + hz[b]! * hz[b]!;
    return score;
  };
  const deg = Math.PI / 180;
  let best = 0;
  let bestScore = -1;
  for (let d = 0; d < 90; d++) {
    const score = sharpness(d * deg);
    if (score > bestScore) [best, bestScore] = [d * deg, score];
  }
  const coarse = best;
  for (let d = -1; d <= 1; d += 0.1) {
    const score = sharpness(coarse + d * deg);
    if (score > bestScore) [best, bestScore] = [coarse + d * deg, score];
  }
  return ((best % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2);
}

// --- the whole analysis ---------------------------------------------------------------------

export function analyzeRoom(splats: SplatPoints, opts: AnalyzeOptions = {}): RoomAnalysis {
  // Opaque splats only, in file space.
  const n = splats.opacity.length;
  const raw = new Float32Array(n * 3);
  const weight = new Float32Array(n);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const o = splats.opacity[i]!;
    const x = splats.positions[i * 3]!;
    const y = splats.positions[i * 3 + 1]!;
    const z = splats.positions[i * 3 + 2]!;
    if (!(o >= MIN_OPACITY) || !Number.isFinite(x + y + z)) continue;
    raw[kept * 3] = x;
    raw[kept * 3 + 1] = y;
    raw[kept * 3 + 2] = z;
    weight[kept++] = o;
  }
  if (kept < 2000) {
    throw new RoomAnalysisError("This scan has too few solid splats to be a room.");
  }
  const file = raw.subarray(0, kept * 3);

  // 1. Up, refined to the actual floor plane.
  const axisGuess = opts.up ?? detectUpAxis(file);
  const up = refineUp(file, AXES[axisGuess]);
  const qUp = rotationToYUp(up);
  const upright = rotateAll(file, qUp);

  // 2. Square the walls to X and Z.
  const yaw = wallYaw(upright);
  const qYaw: Quat = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];
  const rotation = qmul(qYaw, qUp);
  const aligned = rotateAll(upright, qYaw);

  // Floor height (file units along up): middle of the floor layer.
  const floorLayer = lowLayer(aligned, [0, 1, 0]);
  const floorY = floorLayer.height;

  // 3. Room height and scale.
  const top = roomTop(aligned, floorY, floorLayer.fraction);
  let metersPerUnit: number;
  let scaleSource: ScaleSource;
  if (opts.heightMeters) {
    metersPerUnit = opts.heightMeters / top.height;
    scaleSource = "user";
  } else if (top.height >= METRIC_HEIGHT[0] && top.height <= METRIC_HEIGHT[1]) {
    metersPerUnit = 1;
    scaleSource = "file";
  } else {
    metersPerUnit = ASSUMED_CEILING_M / top.height;
    scaleSource = top.ceiling ? "ceiling" : "walls";
  }
  const height = top.height * metersPerUnit;

  // World coordinates before centering: scaled, floor at 0.
  const world = aligned;
  for (let i = 0; i < world.length; i += 3) {
    world[i] = world[i]! * metersPerUnit;
    world[i + 1] = (world[i + 1]! - floorY) * metersPerUnit;
    world[i + 2] = world[i + 2]! * metersPerUnit;
  }

  // 4. Occupancy grid → walkable floor → collision boxes.
  const grid = buildGrid(world, weight.subarray(0, kept), height);
  const room = largestComponent(grid);
  if (room.cells.length * grid.cell * grid.cell < MIN_FLOOR_AREA_M2) {
    throw new RoomAnalysisError(
      "Couldn't find enough open floor in this scan. Make sure the scan includes the floor.",
    );
  }
  const boxes = collisionBoxes(grid, room, height);

  // 5. Spawn points where there's the most room around you.
  const spawnPoints = pickSpawns(grid, room);

  // Center the room on its walkable floor.
  const cx = grid.x0 + ((room.minI + room.maxI + 1) / 2) * grid.cell;
  const cz = grid.z0 + ((room.minJ + room.maxJ + 1) / 2) * grid.cell;

  // 6. Furniture people can sit at or play on, reachable from the walkable floor.
  const { seats, tables } = detectFurniture(world, {
    floorArea: room.cells.length * grid.cell * grid.cell,
    nearFloor: (x, z, radius) => nearRoom(grid, room, x, z, radius),
    origin: [cx, cz],
  });
  for (const b of boxes) {
    b.center[0] -= cx;
    b.center[2] -= cz;
  }
  for (const s of spawnPoints) {
    s.position[0] -= cx;
    s.position[2] -= cz;
  }
  const margin = grid.cell;
  const bounds = {
    min: [
      grid.x0 + room.minI * grid.cell - margin - cx,
      0,
      grid.z0 + room.minJ * grid.cell - margin - cz,
    ] as Vec3,
    max: [
      grid.x0 + (room.maxI + 1) * grid.cell + margin - cx,
      height,
      grid.z0 + (room.maxJ + 1) * grid.cell + margin - cz,
    ] as Vec3,
  };
  const translation: Vec3 = [-cx, -floorY * metersPerUnit, -cz];

  const axis = (Object.entries(AXES) as Array<[UpAxis, Vec3]>).find(
    ([, v]) => dot(v, up) > Math.cos((10 * Math.PI) / 180),
  );
  return {
    transform: { metersPerUnit, rotation, translation, up, floorY, scaleSource },
    upAxis: axis?.[0] ?? null,
    bounds,
    spawnPoints,
    boxes,
    seats,
    tables,
    size: {
      width: (room.maxI - room.minI + 1) * grid.cell,
      depth: (room.maxJ - room.minJ + 1) * grid.cell,
      height,
    },
    grid: { cell: grid.cell, walkableCells: room.cells.length },
  };
}

/** Height of the room above the floor (file units): the ceiling layer if scanned, else the walls' top. */
function roomTop(points: Float32Array, floorY: number, floorFraction: number) {
  const n = points.length / 3;
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) heights[i] = points[i * 3 + 1]! - floorY;
  const [top98, top995] = quantilesOf(heights, [0.98, 0.995]);
  const bins = 100;
  // A little headroom, so a ceiling right at the top quantile still lands in a bin.
  const bin = Math.max((top995! * 1.05) / bins, 1e-6);
  const hist = new Float64Array(bins);
  for (let i = 0; i < n; i++) {
    const b = Math.floor(heights[i]! / bin);
    if (b >= 0 && b < bins) hist[b]! += 1;
  }
  let best = -1;
  let bestSum = 0;
  for (let b = Math.floor(bins * 0.6); b < bins; b++) {
    const sum = hist[b - 1]! + hist[b]! + (hist[b + 1] ?? 0);
    if (sum > bestSum) [best, bestSum] = [b, sum];
  }
  const ceiling = bestSum / n >= Math.max(0.02, 0.15 * floorFraction);
  return { height: ceiling ? (best + 0.5) * bin : top98!, ceiling };
}

interface Grid {
  cell: number;
  nx: number;
  nz: number;
  x0: number;
  z0: number;
  walkable: Uint8Array;
  /** Content above step height (walls, furniture). */
  blocked: Uint8Array;
  /** Top of the content in each blocked cell, meters. */
  top: Float32Array;
  /** Floor height of each walkable cell (raised floors, steps), meters. */
  floor: Float32Array;
}

function buildGrid(world: Float32Array, weight: Float32Array, height: number): Grid {
  const [xlo, xhi] = quantiles(world, 0, [0.005, 0.995]);
  const [zlo, zhi] = quantiles(world, 2, [0.005, 0.995]);
  const pad = 0.3;
  const extent = Math.max(xhi! - xlo!, zhi! - zlo!) + 2 * pad;
  const cell = Math.max(0.08, extent / 300);
  const x0 = xlo! - pad;
  const z0 = zlo! - pad;
  const nx = Math.ceil((xhi! - xlo! + 2 * pad) / cell);
  const nz = Math.ceil((zhi! - zlo! + 2 * pad) / cell);
  const size = nx * nz;
  const floorW = new Float32Array(size);
  const floorH = new Float32Array(size);
  const bodyW = new Float32Array(size);
  const top = new Float32Array(size);
  const bodyTop = Math.min(BODY_BAND_M[1], height - 0.2);
  const contentTop = height - 0.15;

  for (let k = 0; k < weight.length; k++) {
    const i = Math.floor((world[k * 3]! - x0) / cell);
    const j = Math.floor((world[k * 3 + 2]! - z0) / cell);
    if (i < 0 || j < 0 || i >= nx || j >= nz) continue;
    const c = j * nx + i;
    const y = world[k * 3 + 1]!;
    const w = weight[k]!;
    if (y >= FLOOR_BAND_M[0] && y < FLOOR_BAND_M[1]) {
      floorW[c]! += w;
      floorH[c]! += w * y;
    }
    if (y >= BODY_BAND_M[0] && y <= bodyTop) bodyW[c]! += w;
    if (y >= BODY_BAND_M[0] && y < contentTop && y > top[c]!) top[c] = y;
  }

  // A typical floor cell's weight is the yardstick for "something is here".
  const nonzero = floorW.filter((w) => w > 0).sort();
  const reference = nonzero.length ? nonzero[Math.floor(nonzero.length * 0.6)]! : 1;
  const walkable = new Uint8Array(size);
  const blocked = new Uint8Array(size);
  const floor = new Float32Array(size);
  for (let c = 0; c < size; c++) {
    const i = c % nx;
    const j = (c - i) / nx;
    // The outermost cells stay unwalkable, so there's always room for a wall around the floor.
    const edge = i < 2 || j < 2 || i >= nx - 2 || j >= nz - 2;
    blocked[c] = bodyW[c]! >= 0.5 * reference ? 1 : 0;
    walkable[c] = !edge && !blocked[c] && floorW[c]! >= 0.2 * reference ? 1 : 0;
    if (floorW[c]! > 0) floor[c] = Math.max(0, floorH[c]! / floorW[c]!);
  }

  const neighbors = (c: number, mask: Uint8Array) => {
    const i = c % nx;
    const j = (c - i) / nx;
    let count = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di;
        const jj = j + dj;
        if (ii >= 0 && jj >= 0 && ii < nx && jj < nz) count += mask[jj * nx + ii]!;
      }
    }
    return count;
  };
  // Lone specks of "furniture" in open floor are floaters.
  for (let c = 0; c < size; c++) {
    if (blocked[c] && neighbors(c, blocked) === 0 && neighbors(c, walkable) >= 6) {
      blocked[c] = 0;
      walkable[c] = 1;
    }
  }
  // Fill small gaps in the floor (thin spots in the scan) between walkable cells.
  for (let pass = 0; pass < 2; pass++) {
    const next = walkable.slice();
    for (let c = 0; c < size; c++) {
      const i = c % nx;
      const j = (c - i) / nx;
      const edge = i < 2 || j < 2 || i >= nx - 2 || j >= nz - 2;
      if (!edge && !walkable[c] && !blocked[c] && neighbors(c, walkable) >= 5) next[c] = 1;
    }
    walkable.set(next);
  }
  return { cell, nx, nz, x0, z0, walkable, blocked, top, floor };
}

interface Component {
  cells: number[];
  member: Uint8Array;
  minI: number;
  maxI: number;
  minJ: number;
  maxJ: number;
}

function largestComponent(grid: Grid): Component {
  const { nx, nz, walkable } = grid;
  const seen = new Uint8Array(nx * nz);
  let best: number[] = [];
  for (let start = 0; start < nx * nz; start++) {
    if (!walkable[start] || seen[start]) continue;
    const cells = [start];
    seen[start] = 1;
    for (let q = 0; q < cells.length; q++) {
      const c = cells[q]!;
      const i = c % nx;
      for (const d of [i > 0 ? -1 : 0, i < nx - 1 ? 1 : 0, -nx, nx]) {
        const nb = c + d;
        if (d && nb >= 0 && nb < nx * nz && walkable[nb] && !seen[nb]) {
          seen[nb] = 1;
          cells.push(nb);
        }
      }
    }
    if (cells.length > best.length) best = cells;
  }
  const member = new Uint8Array(nx * nz);
  let [minI, maxI, minJ, maxJ] = [nx, -1, nz, -1];
  for (const c of best) {
    member[c] = 1;
    const i = c % nx;
    const j = (c - i) / nx;
    minI = Math.min(minI, i);
    maxI = Math.max(maxI, i);
    minJ = Math.min(minJ, j);
    maxJ = Math.max(maxJ, j);
  }
  return { cells: best, member, minI, maxI, minJ, maxJ };
}

/** Chessboard distance (in cells) from each cell to the nearest cell outside `member`. */
function clearance(grid: Grid, member: Uint8Array): Int32Array {
  const { nx, nz } = grid;
  const dist = new Int32Array(nx * nz).fill(-1);
  const queue: number[] = [];
  for (let c = 0; c < nx * nz; c++) {
    if (!member[c]) {
      dist[c] = 0;
      queue.push(c);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const c = queue[q]!;
    const i = c % nx;
    const j = (c - i) / nx;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const nb = jj * nx + ii;
        if (dist[nb] === -1) {
          dist[nb] = dist[c]! + 1;
          queue.push(nb);
        }
      }
    }
  }
  return dist;
}

/**
 * Boxes for every non-walkable cell bordering the room (two cells deep, so nothing tunnels
 * through), merged into rectangles of equal height; raised floor (steps) as low boxes; and a
 * floor slab under it all.
 */
function collisionBoxes(grid: Grid, room: Component, height: number): Box[] {
  const { nx, nz, cell, x0, z0 } = grid;
  const { member } = room;
  // Everything not walkable inside the room's footprint (furniture interiors too) and two cells
  // beyond its edge, so nothing tunnels through.
  const shell = new Uint8Array(nx * nz);
  for (let j = Math.max(0, room.minJ - 2); j <= Math.min(nz - 1, room.maxJ + 2); j++) {
    for (let i = Math.max(0, room.minI - 2); i <= Math.min(nx - 1, room.maxI + 2); i++) {
      shell[j * nx + i] = 1;
    }
  }
  // Height class per cell: 0 = nothing to build.
  const heights = new Float32Array(nx * nz);
  for (let c = 0; c < nx * nz; c++) {
    if (member[c]) {
      const raised = grid.floor[c]!;
      // Steps and raised floors you walk on top of; small bumps (rugs) stay flat.
      if (raised > 0.07) heights[c] = Math.round(raised / 0.05) * 0.05;
    } else if (shell[c]) {
      heights[c] = grid.blocked[c]
        ? Math.min(
            height,
            Math.max(HEIGHT_STEP_M * 2, Math.ceil(grid.top[c]! / HEIGHT_STEP_M) * HEIGHT_STEP_M),
          )
        : height; // unscanned space: wall it off to the ceiling
    }
  }
  const boxes: Box[] = [];
  const done = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const h = heights[j * nx + i]!;
      if (!h || done[j * nx + i]) continue;
      let w = 1;
      while (i + w < nx && !done[j * nx + i + w] && heights[j * nx + i + w] === h) w++;
      let d = 1;
      grow: while (j + d < nz) {
        for (let k = 0; k < w; k++) {
          const c = (j + d) * nx + i + k;
          if (done[c] || heights[c] !== h) break grow;
        }
        d++;
      }
      for (let dj = 0; dj < d; dj++) for (let k = 0; k < w; k++) done[(j + dj) * nx + i + k] = 1;
      boxes.push({
        center: [x0 + (i + w / 2) * cell, h / 2, z0 + (j + d / 2) * cell],
        halfExtents: [(w * cell) / 2, h / 2, (d * cell) / 2],
      });
    }
  }
  boxes.push({
    center: [x0 + (nx * cell) / 2, -0.15, z0 + (nz * cell) / 2],
    halfExtents: [(nx * cell) / 2, 0.15, (nz * cell) / 2],
  });
  return boxes;
}

function pickSpawns(grid: Grid, room: Component): Array<{ position: Vec3; yaw: number }> {
  const { nx, cell, x0, z0 } = grid;
  const dist = clearance(grid, room.member);
  const centroid = [0, 0];
  for (const c of room.cells) {
    centroid[0]! += c % nx;
    centroid[1]! += Math.floor(c / nx);
  }
  centroid[0]! /= room.cells.length;
  centroid[1]! /= room.cells.length;
  const toCentroid = (c: number) =>
    Math.hypot((c % nx) - centroid[0]!, Math.floor(c / nx) - centroid[1]!);
  const ranked = [...room.cells].sort(
    (a, b) => dist[b]! - dist[a]! || toCentroid(a) - toCentroid(b),
  );
  const best = ranked[0]!;
  // Enough room to stand with company: up to ~0.7 m clearance, or the best the room has.
  const minClear = Math.min(dist[best]!, Math.ceil(0.7 / cell));
  const minApart = 1.5 / cell;
  const chosen = [best];
  for (const c of ranked) {
    if (chosen.length >= 4 || dist[c]! < minClear) break;
    const far = chosen.every(
      (o) => Math.hypot((c % nx) - (o % nx), Math.floor(c / nx) - Math.floor(o / nx)) >= minApart,
    );
    if (far) chosen.push(c);
  }
  const wide = room.maxI - room.minI >= room.maxJ - room.minJ;
  return chosen.map((c) => {
    const i = c % nx;
    const j = Math.floor(c / nx);
    const dx = centroid[0]! - i;
    const dz = centroid[1]! - j;
    // Face the middle of the room, or along its length when standing in the middle.
    const yaw = Math.hypot(dx, dz) * cell > 0.5 ? Math.atan2(dx, dz) : wide ? Math.PI / 2 : 0;
    return {
      position: [
        x0 + (i + 0.5) * cell,
        grid.floor[c]! > 0.07 ? grid.floor[c]! : 0,
        z0 + (j + 0.5) * cell,
      ] as Vec3,
      yaw,
    };
  });
}

/** Whether any of the room's walkable cells lies within `radius` of (x, z). */
function nearRoom(grid: Grid, room: Component, x: number, z: number, radius: number): boolean {
  const { nx, nz, cell, x0, z0 } = grid;
  const r = Math.ceil(radius / cell);
  const ci = Math.floor((x - x0) / cell);
  const cj = Math.floor((z - z0) / cell);
  for (let j = Math.max(0, cj - r); j <= Math.min(nz - 1, cj + r); j++) {
    for (let i = Math.max(0, ci - r); i <= Math.min(nx - 1, ci + r); i++) {
      if (room.member[j * nx + i] && Math.hypot(i - ci, j - cj) <= r) return true;
    }
  }
  return false;
}

/** Box corners → triangles (12 per box), with positions mapped through `toFile`. */
export function boxesToTriangles(boxes: readonly Box[], toFile: (p: Vec3) => Vec3) {
  const positions = new Float32Array(boxes.length * 8 * 3);
  const indices = new Uint32Array(boxes.length * 36);
  // Faces wound counter-clockwise seen from outside.
  const FACES = [
    [0, 2, 3, 1], // -x
    [4, 5, 7, 6], // +x
    [0, 1, 5, 4], // -y
    [2, 6, 7, 3], // +y
    [0, 4, 6, 2], // -z
    [1, 3, 7, 5], // +z
  ];
  boxes.forEach((b, n) => {
    for (let corner = 0; corner < 8; corner++) {
      const p = toFile([
        b.center[0] + (corner & 4 ? 1 : -1) * b.halfExtents[0],
        b.center[1] + (corner & 2 ? 1 : -1) * b.halfExtents[1],
        b.center[2] + (corner & 1 ? 1 : -1) * b.halfExtents[2],
      ]);
      positions.set(p, (n * 8 + corner) * 3);
    }
    FACES.forEach(([a, b2, c, d], f) => {
      const base = n * 8;
      indices.set(
        [base + a!, base + b2!, base + c!, base + a!, base + c!, base + d!],
        n * 36 + f * 6,
      );
    });
  });
  return { positions, indices };
}
