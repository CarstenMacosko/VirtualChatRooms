import type { Seat, Table } from "@vcr/protocol";

/**
 * Seat and table suggestions for an imported scan (PLAN.md § 4.1, ADR 0020), from the same world
 * points the rest of the analysis uses (meters, +Y up, floor at 0):
 *
 * 1. **Height map.** A grid over the floor (4–8 cm cells, finer when the scan is denser) keeps a
 *    small height histogram per cell; a cell's top is the highest height with enough points under
 *    1.5 m, so the odd floater doesn't count and walls read as tall.
 * 2. **Flat patches.** Region growing over smooth cells at sitting or table height, each patch
 *    staying within a few centimeters of its mean, then split into rectangles (an L-shaped sofa
 *    is two).
 * 3. **Seats** are rectangles 0.3–0.6 m up with a backrest along one side (rising to sofa-back
 *    height, below wall height) and a drop to the floor opposite. They face away from the
 *    backrest, one per ~0.6 m of length.
 * 4. **Tables** are flat rectangles 0.35–0.92 m up on legs (the scan sees the floor under them),
 *    with no backrest, open on a side and not along a wall.
 *
 * Everything found is `source: "auto"`. It errs towards missing furniture: the owner can add what
 * it misses, and a seat inside a bookshelf is worse than no seat.
 */

type Vec2 = [number, number];

export interface FurnitureOptions {
  /** Walkable floor area (m²), for the scan's point density. */
  floorArea: number;
  /** Whether there's walkable floor within `radius` of (x, z): furniture you can't reach is skipped. */
  nearFloor?: (x: number, z: number, radius: number) => boolean;
  /** Subtracted from X and Z of what's found (the room's center). */
  origin?: Vec2;
}

export interface Furniture {
  seats: Seat[];
  tables: Table[];
}

const MAX_SEATS = 24;
const MAX_TABLES = 6;
/** Height histogram: 2 cm bins from just under the floor to 1.5 m. */
const BIN = 0.02;
const Y0 = -0.1;
const BINS = 80;
/** Anything this tall is a wall, a shelf or a person-sized thing, not a backrest. */
const TALL = 1.3;
const SEAT_HEIGHT = [0.3, 0.6] as const;
const TABLE_HEIGHT = [0.35, 0.92] as const;
/** Seat depth (front to backrest); deeper is a bed. */
const SEAT_DEPTH = [0.35, 1.0] as const;
const SEAT_PITCH = 0.6;
const SOFA_LENGTH = 1.1;
/** How far the region growing lets a patch stray from its mean height. */
const PATCH_TOLERANCE = 0.045;
/** Smallest surface worth a look (m²). */
const MIN_AREA = 0.12;

type Side = "back" | "wall" | "drop" | "flat" | "low";

/** A direction out of a patch; `lengthwise` when it's along the patch's long axis. */
interface Heading {
  dir: Vec2;
  lengthwise: boolean;
}

interface HeightMap {
  cell: number;
  nx: number;
  nz: number;
  x0: number;
  z0: number;
  /** Top of each cell's content (NaN where there's nothing). */
  top: Float32Array;
  /** Bottom of each cell's content. */
  bottom: Float32Array;
}

interface Patch {
  id: number;
  cells: number[];
  height: number;
  /** Spread of the cells' tops (10th to 90th percentile). */
  spread: number;
  /** The smallest rectangle around the cells: center, unit long axis and its perpendicular. */
  center: Vec2;
  major: Vec2;
  minor: Vec2;
  length: number;
  width: number;
  /** Cell area over rectangle area. */
  fill: number;
}

/** A seat before it's numbered (detector coordinates). */
interface Spot {
  x: number;
  z: number;
  height: number;
  yaw: number;
  kind: Seat["kind"];
}

export function detectFurniture(world: Float32Array, opts: FurnitureOptions): Furniture {
  const map = heightMap(world, opts.floorArea);
  if (!map) return { seats: [], tables: [] };
  const label = new Int32Array(map.nx * map.nz).fill(-1);
  const near = opts.nearFloor ?? (() => true);
  const [ox, oz] = opts.origin ?? [0, 0];

  const groups: Array<{ score: number; spots: Spot[] }> = [];
  const tables: Patch[] = [];
  for (const patch of flatPatches(map, label)) {
    for (const p of rectanglesOf(map, patch)) {
      const seats = seatsOn(map, label, p, near, patch.length >= SOFA_LENGTH);
      if (seats) groups.push(seats);
      else if (isTable(map, label, p, near)) tables.push(p);
    }
  }

  // Best-backed first; a seat closer than a person's width to one already taken is the same
  // seat seen from another rectangle.
  groups.sort((a, b) => b.score - a.score);
  const spots: Spot[] = [];
  for (const g of groups) {
    for (const s of g.spots) {
      if (spots.length < MAX_SEATS && spots.every((o) => Math.hypot(o.x - s.x, o.z - s.z) >= 0.45))
        spots.push(s);
    }
  }

  tables.sort((a, b) => b.length * b.width - a.length * a.width);
  const kept = tables.slice(0, MAX_TABLES);
  const nameOf = (p: Patch) => (p.height < 0.6 ? "Coffee table" : "Table");
  return {
    seats: spots.map((s, i) => ({
      id: i + 1,
      position: [round(s.x - ox), round(s.height), round(s.z - oz)],
      yaw: round(s.yaw),
      height: round(s.height),
      kind: s.kind,
      source: "auto",
    })),
    tables: kept.map((p, i) => {
      const same = kept.filter((o) => nameOf(o) === nameOf(p));
      // Local X runs along the long side; turning X by yaw about +Y gives (cos yaw, −sin yaw).
      let yaw = Math.atan2(-p.major[1], p.major[0]);
      if (yaw > Math.PI / 2) yaw -= Math.PI;
      if (yaw <= -Math.PI / 2) yaw += Math.PI;
      return {
        id: `auto-table-${i + 1}`,
        name: same.length > 1 ? `${nameOf(p)} ${same.indexOf(p) + 1}` : nameOf(p),
        center: [round(p.center[0] - ox), round(p.height), round(p.center[1] - oz)],
        yaw: round(yaw),
        size: [round(p.length), round(p.width)],
        source: "auto",
        games: [],
      };
    }),
  };
}

// --- 1. height map --------------------------------------------------------------------------

function heightMap(world: Float32Array, floorArea: number): HeightMap | null {
  const n = world.length / 3;
  let [xlo, xhi, zlo, zhi] = [Infinity, -Infinity, Infinity, -Infinity];
  let floorPoints = 0;
  for (let k = 0; k < n; k++) {
    const y = world[k * 3 + 1]!;
    if (y < Y0 || y >= Y0 + BINS * BIN) continue;
    const x = world[k * 3]!;
    const z = world[k * 3 + 2]!;
    xlo = Math.min(xlo, x);
    xhi = Math.max(xhi, x);
    zlo = Math.min(zlo, z);
    zhi = Math.max(zhi, z);
    if (Math.abs(y) < 0.05) floorPoints++;
  }
  if (!(xhi > xlo && zhi > zlo) || floorArea <= 0) return null;
  // A handful of points per cell on a horizontal surface.
  const density = floorPoints / floorArea;
  const cell = Math.min(0.08, Math.max(0.04, Math.sqrt(4 / Math.max(density, 1))));
  const nx = Math.ceil((xhi - xlo) / cell) + 1;
  const nz = Math.ceil((zhi - zlo) / cell) + 1;
  if (nx * nz * BINS > 40_000_000) return null; // far bigger than a room
  const hist = new Uint16Array(nx * nz * BINS);
  for (let k = 0; k < n; k++) {
    const b = Math.floor((world[k * 3 + 1]! - Y0) / BIN);
    if (b < 0 || b >= BINS) continue;
    const i = Math.floor((world[k * 3]! - xlo) / cell);
    const j = Math.floor((world[k * 3 + 2]! - zlo) / cell);
    const at = (j * nx + i) * BINS + b;
    if (hist[at]! < 0xffff) hist[at]! += 1;
  }
  const minPoints = Math.max(2, Math.round(0.25 * density * cell * cell));
  const top = new Float32Array(nx * nz).fill(NaN);
  for (let c = 0; c < nx * nz; c++) {
    for (let b = BINS - 1; b >= 0; b--) {
      const here = hist[c * BINS + b]!;
      const below = b > 0 ? hist[c * BINS + b - 1]! : 0;
      if (here >= minPoints) {
        top[c] = Y0 + (b + 0.5) * BIN;
        break;
      }
      // A surface right on a bin boundary splits between two bins.
      if (here > 0 && here + below >= minPoints) {
        top[c] = Y0 + b * BIN;
        break;
      }
    }
  }
  // The lowest thing in each cell: the floor, or a shelf or crossbar under a table top.
  const bottom = new Float32Array(nx * nz).fill(NaN);
  const some = Math.max(1, minPoints >> 1);
  for (let c = 0; c < nx * nz; c++) {
    for (let b = 0; b < BINS; b++) {
      if (hist[c * BINS + b]! >= some) {
        bottom[c] = Y0 + (b + 0.5) * BIN;
        break;
      }
    }
  }
  return { cell, nx, nz, x0: xlo, z0: zlo, top, bottom };
}

function cellAt(map: HeightMap, x: number, z: number): number {
  const i = Math.floor((x - map.x0) / map.cell);
  const j = Math.floor((z - map.z0) / map.cell);
  if (i < 0 || j < 0 || i >= map.nx || j >= map.nz) return -1;
  return j * map.nx + i;
}

// --- 2. flat patches ------------------------------------------------------------------------

const FOUR = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

function flatPatches(map: HeightMap, label: Int32Array): Patch[] {
  const { nx, nz, cell, top } = map;
  const band = (t: number) => t >= SEAT_HEIGHT[0] - 0.05 && t <= TABLE_HEIGHT[1] + 0.05;
  // Seeds are the smoothest cells: their neighbors are all within a bin or so.
  const rough = new Float32Array(nx * nz).fill(Infinity);
  const seeds: number[] = [];
  for (let c = 0; c < nx * nz; c++) {
    const t = top[c]!;
    if (!band(t)) continue;
    const i = c % nx;
    const j = (c - i) / nx;
    let r = 0;
    for (const [di, dj] of FOUR) {
      const ii = i + di;
      const jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
      const nt = top[jj * nx + ii]!;
      if (Number.isFinite(nt)) r = Math.max(r, Math.abs(nt - t));
    }
    rough[c] = r;
    if (r <= 0.025) seeds.push(c);
  }
  seeds.sort((a, b) => rough[a]! - rough[b]! || a - b);

  const minCells = Math.ceil(MIN_AREA / (cell * cell));
  const patches: Patch[] = [];
  for (const seed of seeds) {
    if (label[seed] !== -1) continue;
    const id = patches.length;
    const cells = [seed];
    label[seed] = id;
    let sum = top[seed]!;
    for (let q = 0; q < cells.length; q++) {
      const c = cells[q]!;
      const i = c % nx;
      const j = (c - i) / nx;
      for (const [di, dj] of FOUR) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
        const nb = jj * nx + ii;
        const t = top[nb]!;
        if (label[nb] !== -1 || !band(t)) continue;
        if (Math.abs(t - top[c]!) > 0.03 || Math.abs(t - sum / cells.length) > PATCH_TOLERANCE) {
          continue;
        }
        label[nb] = id;
        cells.push(nb);
        sum += t;
      }
    }
    if (cells.length < minCells) {
      // Too small to be furniture (marked −2 so its cells don't seed again).
      for (const c of cells) label[c] = -2;
      continue;
    }
    patches.push(describePatch(map, id, cells));
  }
  return patches;
}

/**
 * A patch built by a constructor rather than an object literal. Node 24's V8 (13.6, x64 and arm64)
 * miscompiles the literal once Maglev optimizes describePatch: every patch made from it shared
 * one set of number fields, so describing patch 3 rewrote the height and size of patches 0–2,
 * and seats came and went between identical runs (the furniture test, mostly on CI).
 * `--no-maglev` makes it go away too; a constructor doesn't clone the literal's boilerplate.
 */
class PatchRecord implements Patch {
  constructor(
    public id: number,
    public cells: number[],
    public height: number,
    public spread: number,
    public center: Vec2,
    public major: Vec2,
    public minor: Vec2,
    public length: number,
    public width: number,
    public fill: number,
  ) {}
}

function describePatch(map: HeightMap, id: number, cells: number[]): Patch {
  const { nx, cell, x0, z0, top } = map;
  const xs = cells.map((c) => x0 + ((c % nx) + 0.5) * cell);
  const zs = cells.map((c) => z0 + (Math.floor(c / nx) + 0.5) * cell);
  const tops = cells.map((c) => top[c]!).sort((a, b) => a - b);
  const q = (f: number) => tops[Math.min(tops.length - 1, Math.floor(f * tops.length))]!;
  // The smallest rectangle around the cells, over every heading (1° steps).
  let best = { area: Infinity, angle: 0, a: [0, 0] as Vec2, b: [0, 0] as Vec2 };
  for (let deg = 0; deg < 90; deg++) {
    const angle = (deg * Math.PI) / 180;
    const [c, s] = [Math.cos(angle), Math.sin(angle)];
    let [amin, amax, bmin, bmax] = [Infinity, -Infinity, Infinity, -Infinity];
    for (let k = 0; k < xs.length; k++) {
      const pa = c * xs[k]! + s * zs[k]!;
      const pb = -s * xs[k]! + c * zs[k]!;
      amin = Math.min(amin, pa);
      amax = Math.max(amax, pa);
      bmin = Math.min(bmin, pb);
      bmax = Math.max(bmax, pb);
    }
    const area = (amax - amin + cell) * (bmax - bmin + cell);
    if (area < best.area - 1e-9) best = { area, angle, a: [amin, amax], b: [bmin, bmax] };
  }
  const [c, s] = [Math.cos(best.angle), Math.sin(best.angle)];
  const ext: Vec2 = [best.a[1] - best.a[0] + cell, best.b[1] - best.b[0] + cell];
  const ma = (best.a[0] + best.a[1]) / 2;
  const mb = (best.b[0] + best.b[1]) / 2;
  const long = ext[0] >= ext[1];
  return new PatchRecord(
    id,
    cells,
    q(0.5),
    q(0.9) - q(0.1),
    [c * ma - s * mb, s * ma + c * mb],
    long ? [c, s] : [-s, c],
    long ? [-s, c] : [c, s],
    Math.max(...ext),
    Math.min(...ext),
    (cells.length * cell * cell) / best.area,
  );
}

/**
 * A patch as rectangles: itself if it's close to one, else the biggest rectangles that fit in it
 * (an L-shaped sofa, a table with a bench pushed against it), largest first. Thin L shapes fit
 * a turned bounding box as well as a square one, so the split also tries the room's own axes
 * (walls are squared to X and Z, and furniture mostly follows them).
 */
function rectanglesOf(map: HeightMap, p: Patch): Patch[] {
  const own = rasterize(map, p, Math.atan2(p.major[1], p.major[0]));
  if (own.solid >= 0.75) return [{ ...p, fill: Math.max(p.fill, own.solid) }];
  let best: Patch[] = [];
  let bestArea = 0;
  for (const raster of [own, rasterize(map, p, 0)]) {
    const rects = splitRaster(map, p, raster);
    const area = rects.length ? rects[0]!.length * rects[0]!.width : 0;
    if (area > bestArea) [best, bestArea] = [rects, area];
  }
  return best;
}

interface Raster {
  mask: Uint8Array;
  nu: number;
  nv: number;
  /** A map cell's raster cell. */
  local: (c: number) => Vec2;
  /** Share of the raster inside the patch's outline (holes count as inside). */
  solid: number;
}

/** The patch's cells on a grid turned by `angle`; holes in the patch are filled in. */
function rasterize(map: HeightMap, p: Patch, angle: number): Raster {
  const { nx, cell, x0, z0 } = map;
  const [cs, sn] = [Math.cos(angle), Math.sin(angle)];
  const frame = (c: number): Vec2 => {
    const x = x0 + ((c % nx) + 0.5) * cell;
    const z = z0 + (Math.floor(c / nx) + 0.5) * cell;
    return [cs * x + sn * z, -sn * x + cs * z];
  };
  let [amin, bmin, amax, bmax] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const c of p.cells) {
    const [a, b] = frame(c);
    [amin, bmin, amax, bmax] = [
      Math.min(amin, a),
      Math.min(bmin, b),
      Math.max(amax, a),
      Math.max(bmax, b),
    ];
  }
  const nu = Math.ceil((amax - amin) / cell) + 1;
  const nv = Math.ceil((bmax - bmin) / cell) + 1;
  const local = (c: number): Vec2 => {
    const [a, b] = frame(c);
    return [
      Math.min(nu - 1, Math.round((a - amin) / cell)),
      Math.min(nv - 1, Math.round((b - bmin) / cell)),
    ];
  };
  const mask = new Uint8Array(nu * nv);
  for (const c of p.cells) {
    const [u, v] = local(c);
    mask[v * nu + u] = 1;
  }
  // Turned grids leave pinholes between rasterized cells.
  for (let v = 1; v < nv - 1; v++) {
    for (let u = 1; u < nu - 1; u++) {
      const at = v * nu + u;
      if ((mask[at - 1] && mask[at + 1]) || (mask[at - nu] && mask[at + nu])) mask[at] = 2;
    }
  }
  // Holes (whatever stands on a table) count as surface: only the outline decides the shape.
  const outside = new Uint8Array(nu * nv);
  const queue: number[] = [];
  for (let at = 0; at < nu * nv; at++) {
    const u = at % nu;
    const v = (at - u) / nu;
    if (!mask[at] && (u === 0 || v === 0 || u === nu - 1 || v === nv - 1)) {
      outside[at] = 1;
      queue.push(at);
    }
  }
  for (let q = 0; q < queue.length; q++) {
    const at = queue[q]!;
    const u = at % nu;
    for (const nb of [u > 0 ? at - 1 : -1, u < nu - 1 ? at + 1 : -1, at - nu, at + nu]) {
      if (nb >= 0 && nb < nu * nv && !mask[nb] && !outside[nb]) {
        outside[nb] = 1;
        queue.push(nb);
      }
    }
  }
  let solid = 0;
  for (let at = 0; at < nu * nv; at++) {
    if (!outside[at]) {
      solid++;
      mask[at] ||= 3;
    }
  }
  return { mask, nu, nv, local, solid: solid / (nu * nv) };
}

/** Takes the largest rectangle out of the raster, then the next, up to four. */
function splitRaster(map: HeightMap, p: Patch, { mask: original, nu, nv, local }: Raster): Patch[] {
  const mask = original.slice();
  const out: Patch[] = [];
  let left = p.cells;
  const minSide = Math.ceil(0.3 / map.cell);
  for (let pass = 0; pass < 4 && left.length; pass++) {
    const r = largestRectangle(mask, nu, nv, minSide);
    if (!r) break;
    const inside: number[] = [];
    const outside: number[] = [];
    for (const c of left) {
      const [u, v] = local(c);
      (u >= r.u && u < r.u + r.w && v >= r.v && v < r.v + r.h ? inside : outside).push(c);
    }
    for (let v = r.v; v < r.v + r.h; v++) mask.fill(0, v * nu + r.u, v * nu + r.u + r.w);
    left = outside;
    if (inside.length * map.cell * map.cell >= MIN_AREA) {
      out.push({ ...describePatch(map, p.id, inside), fill: 1 });
    }
  }
  return out;
}

/**
 * The largest all-set rectangle in a mask at least `minSide` cells each way (row histograms with
 * a stack: every maximal rectangle comes up once).
 */
function largestRectangle(mask: Uint8Array, nu: number, nv: number, minSide: number) {
  const heights = new Int32Array(nu);
  let best: { u: number; v: number; w: number; h: number } | null = null;
  for (let v = 0; v < nv; v++) {
    for (let u = 0; u < nu; u++) heights[u] = mask[v * nu + u] ? heights[u]! + 1 : 0;
    const stack: number[] = [];
    for (let u = 0; u <= nu; u++) {
      const h = u < nu ? heights[u]! : 0;
      while (stack.length && heights[stack.at(-1)!]! >= h) {
        const top = stack.pop()!;
        const height = heights[top]!;
        const start = stack.length ? stack.at(-1)! + 1 : 0;
        const width = u - start;
        if (height < minSide || width < minSide) continue;
        if (!best || width * height > best.w * best.h) {
          best = { u: start, v: v - height + 1, w: width, h: height };
        }
      }
      stack.push(u);
    }
  }
  return best;
}

// --- 3. seats --------------------------------------------------------------------------------

/**
 * What lies beyond a patch along `dir`, walking out from `origin` (on the patch, `edge` meters
 * from its edge): a backrest (rising to sofa-back height within 30 cm), a wall (rising past it),
 * a drop to the floor, more of the same surface, or something low (an armrest, a side table, a
 * step down onto another table). `top` is how high a backrest rises.
 */
function sideAlong(
  map: HeightMap,
  label: Int32Array,
  p: Patch,
  origin: Vec2,
  dir: Vec2,
  edge: number,
): { side: Side; top: number } {
  const h = p.height;
  const step = map.cell / 2;
  const backMin = Math.max(0.62, h + 0.17);
  let gap = 0;
  let lower = 0;
  let rise = -1;
  let maxTop = -Infinity;
  let wall = false;
  const result = (side: Side) => ({ side, top: maxTop });
  // Start a little inside the edge: what stands on a table's middle isn't its side.
  for (let s = Math.max(0, edge - 0.15); s <= edge + 0.6; s += step) {
    const c = cellAt(map, origin[0] + dir[0] * s, origin[1] + dir[1] * s);
    if (c < 0) return result(rise < 0 ? "drop" : "low");
    const t = map.top[c]!;
    if (rise < 0) {
      if (label[c] === p.id || Math.abs(t - h) <= 0.06) {
        if (s > edge + 0.15) return result("flat");
        gap = 0;
        lower = 0;
        continue;
      }
      if (!Number.isFinite(t)) {
        gap += step;
        if (gap > 0.12) return result("drop");
        continue;
      }
      if (t < h - 0.15) return result("drop");
      if (t < h) {
        // A rounded front edge on the way down, or a lower surface it rests on.
        lower += step;
        if (lower > 0.12) return result("low");
        continue;
      }
      rise = s;
    }
    if (s > rise + 0.3) break;
    if (!Number.isFinite(t)) continue;
    if (t >= TALL) {
      wall = true;
      break;
    }
    maxTop = Math.max(maxTop, t);
  }
  if (rise < 0) return result("flat");
  if (maxTop >= backMin && maxTop <= 1.25) return result("back");
  return result(wall ? "wall" : "low");
}

/** How one side of a patch looks, sampled along its length. */
function sideProfile(map: HeightMap, label: Int32Array, p: Patch, { dir, lengthwise }: Heading) {
  const along: Vec2 = [-dir[1], dir[0]];
  const half = (lengthwise ? p.length : p.width) / 2;
  const halfAlong = (lengthwise ? p.width : p.length) / 2;
  const counts: Record<Side, number> = { back: 0, wall: 0, drop: 0, flat: 0, low: 0 };
  let samples = 0;
  let backTop = 0;
  let tall = 0;
  const inset = Math.min(0.1, halfAlong / 2);
  for (let t = -halfAlong + inset; t <= halfAlong - inset + 1e-9; t += map.cell) {
    const origin: Vec2 = [p.center[0] + along[0] * t, p.center[1] + along[1] * t];
    const { side, top } = sideAlong(map, label, p, origin, dir, half);
    counts[side]++;
    if (side === "back") backTop += top;
    if (tallWithin(map, origin, dir, half, half + 0.3)) tall++;
    samples++;
  }
  const share = (side: Side) => counts[side] / Math.max(1, samples);
  return {
    share,
    half,
    halfAlong,
    /** Mean height of the backrest where there is one. */
    backTop: backTop / Math.max(1, counts.back),
    /** Share of the side with something tall (a wall) just beyond it. */
    tall: tall / Math.max(1, samples),
  };
}

function tallWithin(map: HeightMap, origin: Vec2, dir: Vec2, from: number, to: number): boolean {
  for (let s = from; s <= to; s += map.cell / 2) {
    const c = cellAt(map, origin[0] + dir[0] * s, origin[1] + dir[1] * s);
    if (c >= 0 && map.top[c]! >= TALL) return true;
  }
  return false;
}

function seatsOn(
  map: HeightMap,
  label: Int32Array,
  p: Patch,
  near: NonNullable<FurnitureOptions["nearFloor"]>,
  /** Part of a sofa-sized surface (one arm of an L-shaped sofa). */
  sofa: boolean,
): { score: number; spots: Spot[] } | null {
  if (p.height < SEAT_HEIGHT[0] || p.height > SEAT_HEIGHT[1]) return null;
  if (p.fill < 0.7 || p.spread > 0.06 || p.length > 3.5) return null;
  // Which side is the backrest? Along the long sides, or any side of a squarish seat, where
  // the back rises higher than the arms.
  const headings = headingsOf(p).slice(0, p.length / p.width < 1.3 ? 4 : 2);
  let best: { heading: Heading; back: number; top: number } | null = null;
  for (const heading of headings) {
    const side = sideProfile(map, label, p, heading);
    const back = side.share("back");
    if (back >= 0.6 && (!best || side.backTop > best.top)) {
      best = { heading, back, top: side.backTop };
    }
  }
  if (!best) return null;
  const back = best.heading.dir;
  const front = neg(back);
  const profile = sideProfile(map, label, p, { dir: front, lengthwise: best.heading.lengthwise });
  if (profile.share("drop") < 0.5) return null;
  const depth = profile.half * 2;
  const length = profile.halfAlong * 2;
  if (depth < SEAT_DEPTH[0] || depth > SEAT_DEPTH[1] || length < 0.35) return null;

  const kind = sofa || length >= SOFA_LENGTH ? "sofa" : "chair";
  const count = length >= SOFA_LENGTH ? Math.max(2, Math.round(length / SEAT_PITCH)) : 1;
  const pitch = length / count;
  const along: Vec2 = [-back[1], back[0]];
  // Hips rest a little in front of the backrest.
  const fromBack = Math.min(depth / 2, 0.28);
  const yaw = Math.atan2(front[0], front[1]);
  const spots: Spot[] = [];
  for (let k = 0; k < count; k++) {
    const t = (k + 0.5) * pitch - length / 2;
    const x = p.center[0] + along[0] * t + back[0] * (depth / 2 - fromBack);
    const z = p.center[1] + along[1] * t + back[1] * (depth / 2 - fromBack);
    // The seat is really there, and you can get up from it onto open floor.
    let onSeat = 0;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const c = cellAt(map, x + di * map.cell, z + dj * map.cell);
        if (c >= 0 && (label[c] === p.id || Math.abs(map.top[c]! - p.height) <= 0.06)) onSeat++;
      }
    }
    if (onSeat < 6) continue;
    if (sideAlong(map, label, p, [x, z], front, depth - fromBack).side !== "drop") continue;
    const reach = depth - fromBack + 0.3;
    if (!near(x + front[0] * reach, z + front[1] * reach, 0.3)) continue;
    spots.push({ x, z, height: p.height, yaw, kind });
  }
  if (!spots.length) return null;
  return { score: best.back * p.cells.length, spots };
}

// --- 4. tables -------------------------------------------------------------------------------

function isTable(
  map: HeightMap,
  label: Int32Array,
  p: Patch,
  near: NonNullable<FurnitureOptions["nearFloor"]>,
): boolean {
  if (p.height < TABLE_HEIGHT[0] || p.height > TABLE_HEIGHT[1]) return false;
  if (p.fill < 0.7 || p.spread > 0.04) return false;
  if (p.length * p.width < 0.15 || p.width < 0.3 || p.length > 3 || p.width > 1.6) return false;
  // A top on legs: the scan sees the floor (or a shelf) under most of it. Ottomans, beds and
  // sofa seats are solid down to the floor.
  const under = p.cells.filter((c) => map.bottom[c]! < p.height - 0.2).length;
  if (under < 0.6 * p.cells.length) return false;
  let open = false;
  for (const heading of headingsOf(p)) {
    const side = sideProfile(map, label, p, heading);
    if (side.share("back") >= 0.3) return false;
    // Along a wall: things pushed against one are usually counters, shelves or beds. (Someone
    // sitting at a table only covers part of a side.)
    if (side.tall >= 0.6) return false;
    if (side.share("drop") >= 0.5) open = true;
  }
  return open && near(p.center[0], p.center[1], p.length / 2 + 0.5);
}

/** Out of the long sides first, then the short ones. */
const headingsOf = (p: Patch): Heading[] => [
  { dir: p.minor, lengthwise: false },
  { dir: neg(p.minor), lengthwise: false },
  { dir: p.major, lengthwise: true },
  { dir: neg(p.major), lengthwise: true },
];

const neg = (v: Vec2): Vec2 => [-v[0], -v[1]];
const round = (v: number) => Math.round(v * 1000) / 1000 + 0; // no -0
