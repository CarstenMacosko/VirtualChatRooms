import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { PointCloud, SplatColumns } from "./splatFile";

/**
 * Turning a plain point cloud into Gaussian splats that render as a closed surface. A point
 * cloud has no sizes, so a renderer draws each point as a fixed speck that thins out into the
 * background a few meters away. Here each point becomes a flat disc (a "surfel") lying in the
 * surface its nearest neighbors span, stretched along that surface as far as they are spread,
 * so neighboring discs overlap and the scan's colors cover the walls instead of dotting them.
 */

/** Neighbors that describe the surface around a point. */
const NEIGHBORS = 10;
/** Disc standard deviation per unit of the neighbors' spread: enough for discs to overlap. */
const SPREAD_TO_SIGMA = 0.85;
/** Longest disc axis ÷ shortest in-surface axis, so edges stay thin but discs never become needles. */
const MAX_ANISOTROPY = 4;
const OPACITY = 0.95;
/** Points between progress reports (and turns of the event loop). */
const BATCH = 50_000;

export interface SurfelOptions {
  onProgress?: (fraction: number) => void;
}

export async function pointCloudToSplats(
  cloud: PointCloud,
  opts: SurfelOptions = {},
): Promise<SplatColumns> {
  const { count, positions } = cloud;
  const spacing = estimateSpacing(positions, count);
  const grid = new Grid(positions, count, spacing);
  await yieldToEventLoop();

  const scales = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const opacity = new Float32Array(count).fill(OPACITY);
  const idx = new Uint32Array(NEIGHBORS);
  const d2 = new Float64Array(NEIGHBORS);
  const cov = new Float64Array(9);
  const vecs = new Float64Array(9);
  const q = new Float64Array(4);
  const maxSigma = 2 * spacing;

  for (let i = 0; i < count; i++) {
    if (i % BATCH === BATCH - 1) {
      opts.onProgress?.(i / count);
      await yieldToEventLoop();
    }
    const found = grid.nearest(i, NEIGHBORS, idx, d2);
    if (found < 3) {
      // A stray point: a small round splat.
      scales.fill(0.3 * spacing, i * 3, i * 3 + 3);
      rotations[i * 4 + 3] = 1;
      continue;
    }

    // Covariance of the point and its neighbors about their mean.
    let mx = positions[i * 3]!;
    let my = positions[i * 3 + 1]!;
    let mz = positions[i * 3 + 2]!;
    for (let j = 0; j < found; j++) {
      mx += positions[idx[j]! * 3]!;
      my += positions[idx[j]! * 3 + 1]!;
      mz += positions[idx[j]! * 3 + 2]!;
    }
    const m = found + 1;
    mx /= m;
    my /= m;
    mz /= m;
    cov.fill(0);
    for (let j = -1; j < found; j++) {
      const o = (j < 0 ? i : idx[j]!) * 3;
      const x = positions[o]! - mx;
      const y = positions[o + 1]! - my;
      const z = positions[o + 2]! - mz;
      cov[0]! += x * x;
      cov[1]! += x * y;
      cov[2]! += x * z;
      cov[4]! += y * y;
      cov[5]! += y * z;
      cov[8]! += z * z;
    }
    for (const k of [0, 1, 2, 4, 5, 8]) cov[k]! /= m;
    cov[3] = cov[1]!;
    cov[6] = cov[2]!;
    cov[7] = cov[5]!;

    // Axes: the two the neighbors spread along, then the surface normal.
    const order = eigenSym3(cov, vecs);
    const spread = (k: number) => Math.sqrt(Math.max(0, cov[order[k]! * 4]!));
    const s1 = Math.min(maxSigma, Math.max(SPREAD_TO_SIGMA * spread(0), 0.05 * spacing));
    const s2 = Math.min(s1, Math.max(SPREAD_TO_SIGMA * spread(1), s1 / MAX_ANISOTROPY));
    const s3 = Math.min(0.5 * s2, Math.max(spread(2), 0.1 * s2));
    scales[i * 3] = s1;
    scales[i * 3 + 1] = s2;
    scales[i * 3 + 2] = s3;

    const a = order[0]!;
    const b = order[1]!;
    // Columns e1, e2 and e3 = e1 × e2 (right-handed, so it's a rotation).
    const e1x = vecs[a]!;
    const e1y = vecs[3 + a]!;
    const e1z = vecs[6 + a]!;
    const e2x = vecs[b]!;
    const e2y = vecs[3 + b]!;
    const e2z = vecs[6 + b]!;
    quatFromBasis(
      e1x,
      e1y,
      e1z,
      e2x,
      e2y,
      e2z,
      e1y * e2z - e1z * e2y,
      e1z * e2x - e1x * e2z,
      e1x * e2y - e1y * e2x,
      q,
    );
    rotations.set(q, i * 4);
  }
  opts.onProgress?.(1);
  return { count, positions, scales, rotations, opacity, colors: cloud.colors };
}

/** Points in cubic cells, for nearest-neighbor queries. */
class Grid {
  private readonly min: [number, number, number];
  private readonly dims: [number, number, number];
  /** Cell key → dense cell id. */
  private readonly ids = new Map<number, number>();
  /** Points sorted by cell; cell `id`'s are `order[start[id]] … order[start[id + 1] - 1]`. */
  private readonly order: Uint32Array;
  private readonly start: Uint32Array;

  constructor(
    private readonly positions: Float32Array,
    private readonly count: number,
    readonly cell: number,
  ) {
    const { min, max } = bounds(positions, count);
    this.min = min;
    this.dims = [0, 1, 2].map((a) => Math.floor((max[a]! - min[a]!) / cell) + 1) as [
      number,
      number,
      number,
    ];
    const cellOf = new Uint32Array(count);
    const counts: number[] = [];
    for (let i = 0; i < count; i++) {
      const key = this.keyAt(i);
      let id = this.ids.get(key);
      if (id === undefined) {
        id = counts.length;
        this.ids.set(key, id);
        counts.push(0);
      }
      cellOf[i] = id;
      counts[id]!++;
    }
    this.start = new Uint32Array(counts.length + 1);
    for (let id = 0; id < counts.length; id++) this.start[id + 1] = this.start[id]! + counts[id]!;
    const next = this.start.slice(0, counts.length);
    this.order = new Uint32Array(count);
    for (let i = 0; i < count; i++) this.order[next[cellOf[i]!]!++] = i;
  }

  private coord(v: number, axis: number) {
    return Math.min(this.dims[axis]! - 1, Math.floor((v - this.min[axis]!) / this.cell));
  }

  private keyAt(i: number) {
    const p = this.positions;
    const [nx, ny] = this.dims;
    return (
      this.coord(p[i * 3]!, 0) +
      nx * (this.coord(p[i * 3 + 1]!, 1) + ny * this.coord(p[i * 3 + 2]!, 2))
    );
  }

  /**
   * Up to `k` nearest other points to point `i` within the surrounding 3×3×3 cells (exact for
   * neighbors closer than one cell), closest first: indices into `idx`, squared distances into
   * `d2`. Returns how many were found.
   */
  nearest(i: number, k: number, idx: Uint32Array, d2: Float64Array): number {
    const p = this.positions;
    const x = p[i * 3]!;
    const y = p[i * 3 + 1]!;
    const z = p[i * 3 + 2]!;
    const [nx, ny, nz] = this.dims;
    const cx = this.coord(x, 0);
    const cy = this.coord(y, 1);
    const cz = this.coord(z, 2);
    let found = 0;
    for (let gz = Math.max(0, cz - 1); gz <= Math.min(nz - 1, cz + 1); gz++) {
      for (let gy = Math.max(0, cy - 1); gy <= Math.min(ny - 1, cy + 1); gy++) {
        for (let gx = Math.max(0, cx - 1); gx <= Math.min(nx - 1, cx + 1); gx++) {
          const id = this.ids.get(gx + nx * (gy + ny * gz));
          if (id === undefined) continue;
          for (let s = this.start[id]!, end = this.start[id + 1]!; s < end; s++) {
            const j = this.order[s]!;
            if (j === i) continue;
            const dx = p[j * 3]! - x;
            const dy = p[j * 3 + 1]! - y;
            const dz = p[j * 3 + 2]! - z;
            const d = dx * dx + dy * dy + dz * dz;
            if (found === k && d >= d2[k - 1]!) continue;
            let at = found < k ? found++ : k - 1;
            for (; at > 0 && d2[at - 1]! > d; at--) {
              d2[at] = d2[at - 1]!;
              idx[at] = idx[at - 1]!;
            }
            d2[at] = d;
            idx[at] = j;
          }
        }
      }
    }
    return found;
  }
}

function bounds(positions: Float32Array, count: number) {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i * 3 + a]!;
      if (v < min[a]!) min[a] = v;
      if (v > max[a]!) max[a] = v;
    }
  }
  return { min, max };
}

/**
 * The typical distance from a point to its NEIGHBORS-th nearest neighbor, from a sample. It
 * sizes the grid's cells, so most neighborhoods fit in the 3×3×3 cells around a point.
 */
export function estimateSpacing(positions: Float32Array, count: number): number {
  const { min, max } = bounds(positions, count);
  const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
  const samples = Math.min(count, 2000);
  const idx = new Uint32Array(NEIGHBORS);
  const d2 = new Float64Array(NEIGHBORS);
  for (let cell = extent / 64; cell <= extent * 2; cell *= 2) {
    const grid = new Grid(positions, count, cell);
    const distances: number[] = [];
    for (let s = 0; s < samples; s++) {
      const i = Math.floor((s * count) / samples);
      if (grid.nearest(i, NEIGHBORS, idx, d2) < NEIGHBORS) continue;
      const d = Math.sqrt(d2[NEIGHBORS - 1]!);
      if (d <= cell) distances.push(d); // farther ones might have missed closer points
    }
    if (distances.length >= samples / 2) {
      distances.sort((a, b) => a - b);
      // No smaller than 1/50,000 of the scan, so a few far-off stray points can't blow up the grid.
      return Math.max(distances[distances.length >> 1]!, extent / 50_000);
    }
  }
  return extent / 100;
}

/**
 * Eigen-decomposes symmetric 3×3 `m` (row-major) by Jacobi rotations: afterwards its diagonal
 * holds the eigenvalues and the columns of `v` the eigenvectors. Returns the column indices
 * from the largest eigenvalue to the smallest.
 */
export function eigenSym3(m: Float64Array, v: Float64Array): [number, number, number] {
  v.fill(0);
  v[0] = v[4] = v[8] = 1;
  const scale = Math.abs(m[0]!) + Math.abs(m[4]!) + Math.abs(m[8]!);
  for (let sweep = 0; sweep < 16; sweep++) {
    const off = m[1]! * m[1]! + m[2]! * m[2]! + m[5]! * m[5]!;
    if (off <= 1e-24 * scale * scale) break;
    for (const [p, r] of PAIRS) {
      const apq = m[p * 3 + r]!;
      if (apq === 0) continue;
      const theta = (m[r * 4]! - m[p * 4]!) / (2 * apq);
      const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const kp = m[k * 3 + p]!;
        const kq = m[k * 3 + r]!;
        m[k * 3 + p] = c * kp - s * kq;
        m[k * 3 + r] = s * kp + c * kq;
      }
      for (let k = 0; k < 3; k++) {
        const pk = m[p * 3 + k]!;
        const qk = m[r * 3 + k]!;
        m[p * 3 + k] = c * pk - s * qk;
        m[r * 3 + k] = s * pk + c * qk;
      }
      for (let k = 0; k < 3; k++) {
        const kp = v[k * 3 + p]!;
        const kq = v[k * 3 + r]!;
        v[k * 3 + p] = c * kp - s * kq;
        v[k * 3 + r] = s * kp + c * kq;
      }
    }
  }
  return ([0, 1, 2] as [number, number, number]).sort((a, b) => m[b * 4]! - m[a * 4]!);
}

const PAIRS = [
  [0, 1],
  [0, 2],
  [1, 2],
] as const;

/** The rotation taking x, y, z to the given orthonormal columns, as [x, y, z, w]. */
function quatFromBasis(
  m00: number,
  m10: number,
  m20: number,
  m01: number,
  m11: number,
  m21: number,
  m02: number,
  m12: number,
  m22: number,
  out: Float64Array,
) {
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    out[3] = 0.25 / s;
    out[0] = (m21 - m12) * s;
    out[1] = (m02 - m20) * s;
    out[2] = (m10 - m01) * s;
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
    out[3] = (m21 - m12) / s;
    out[0] = 0.25 * s;
    out[1] = (m01 + m10) / s;
    out[2] = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
    out[3] = (m02 - m20) / s;
    out[0] = (m01 + m10) / s;
    out[1] = 0.25 * s;
    out[2] = (m12 + m21) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
    out[3] = (m10 - m01) / s;
    out[0] = (m02 + m20) / s;
    out[1] = (m12 + m21) / s;
    out[2] = 0.25 * s;
  }
}
