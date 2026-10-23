import { seededRandom } from "../random";

/**
 * Piece shapes. Every cut between two neighboring cells is one curve with a tab, bulging into
 * one cell or the other, and its shape comes from the puzzle's seed. Both neighbors trace the
 * same curve (one forwards, one backwards), so pieces always fit and together tile the board.
 *
 * Coordinates here are grid units: one cell is 1 × 1, x runs along the columns and z along the
 * rows (row 0 is the top of the picture). Outlines are relative to the piece's cell center.
 */

/** (x, z) in grid units. */
export type Point = [number, number];

export type Segment =
  { kind: "line"; to: Point } | { kind: "cubic"; c1: Point; c2: Point; to: Point };

export interface Outline {
  start: Point;
  segments: Segment[];
}

/** One cut's shape, across a unit edge from (0, 0) to (1, 0); +v bulges into the second cell. */
interface CutShape {
  /** +1 or -1: which neighbor gets the tab. */
  side: number;
  tab: number;
  jitter: [number, number, number, number, number];
}

/** Tab size and wobble, as fractions of the edge (Draradech's classic jigsaw curve). */
const TAB_SIZE = 0.1;
const TAB_SIZE_VARIATION = 0.015;
const JITTER = 0.04;

export interface PuzzleCuts {
  cols: number;
  rows: number;
  /** Cut between rows r-1 and r, across column c: index (r - 1) * cols + c. */
  across: CutShape[];
  /** Cut between columns c-1 and c, down row r: index r * (cols - 1) + (c - 1). */
  down: CutShape[];
}

/** The shapes of every cut in a cols × rows puzzle, deterministic from `seed`. */
export function puzzleCuts(seed: number, cols: number, rows: number): PuzzleCuts {
  // A different stream from the scatter's, so changing one never changes the other.
  const random = seededRandom(seed ^ 0x5eed);
  const cut = (): CutShape => {
    const j = () => (random() * 2 - 1) * JITTER;
    return {
      side: random() < 0.5 ? -1 : 1,
      tab: TAB_SIZE + (random() * 2 - 1) * TAB_SIZE_VARIATION,
      jitter: [j(), j(), j(), j(), j()],
    };
  };
  const across = Array.from({ length: (rows - 1) * cols }, cut);
  const down = Array.from({ length: rows * (cols - 1) }, cut);
  return { cols, rows, across, down };
}

/** The cut's control points across the unit edge: (u along it, v bulging out). */
function cutPoints({ side, tab: t, jitter: [a, b, c, d, e] }: CutShape): Point[] {
  const points: Point[] = [
    [0, 0],
    [0.2, a],
    [0.5 + b + d, -t + c],
    [0.5 - t + b, t + c],
    [0.5 - 2 * t + b - d, 3 * t + c],
    [0.5 + 2 * t + b - d, 3 * t + c],
    [0.5 + t + b, t + c],
    [0.5 + b + d, -t + c],
    [0.8, e],
    [1, 0],
  ];
  return points.map(([u, v]) => [u, v * side]);
}

/** A cut as three cubic curves in global grid coordinates, from its start to its end. */
function cutCurve(cuts: PuzzleCuts, kind: "across" | "down", r: number, c: number): Point[] {
  if (kind === "across") {
    const shape = cuts.across[(r - 1) * cuts.cols + c]!;
    return cutPoints(shape).map(([u, v]) => [c + u, r + v]);
  }
  const shape = cuts.down[r * (cuts.cols - 1) + (c - 1)]!;
  return cutPoints(shape).map(([u, v]) => [c + v, r + u]);
}

/** Cubic segments from a 10-point curve (start + 3 × 3), optionally traced backwards. */
function curveSegments(points: Point[], reverse: boolean): Segment[] {
  const p = reverse ? [...points].reverse() : points;
  const segments: Segment[] = [];
  for (let i = 1; i < p.length; i += 3) {
    segments.push({ kind: "cubic", c1: p[i]!, c2: p[i + 1]!, to: p[i + 2]! });
  }
  return segments;
}

/**
 * The outline of piece `index` (row-major: index = row · cols + col), clockwise when x points
 * right and z points down the picture, relative to its cell center.
 */
export function pieceOutline(cuts: PuzzleCuts, index: number): Outline {
  const { cols, rows } = cuts;
  const c = index % cols;
  const r = Math.floor(index / cols);
  const segments: Segment[] = [];
  // Top: (c, r) → (c + 1, r)
  if (r > 0) segments.push(...curveSegments(cutCurve(cuts, "across", r, c), false));
  else segments.push({ kind: "line", to: [c + 1, r] });
  // Right: (c + 1, r) → (c + 1, r + 1)
  if (c < cols - 1) segments.push(...curveSegments(cutCurve(cuts, "down", r, c + 1), false));
  else segments.push({ kind: "line", to: [c + 1, r + 1] });
  // Bottom: (c + 1, r + 1) → (c, r + 1)
  if (r < rows - 1) segments.push(...curveSegments(cutCurve(cuts, "across", r + 1, c), true));
  else segments.push({ kind: "line", to: [c, r + 1] });
  // Left: (c, r + 1) → (c, r)
  if (c > 0) segments.push(...curveSegments(cutCurve(cuts, "down", r, c), true));
  else segments.push({ kind: "line", to: [c, r] });

  const cx = c + 0.5;
  const cz = r + 0.5;
  const local = ([x, z]: Point): Point => [x - cx, z - cz];
  return {
    start: local([c, r]),
    segments: segments.map((s) =>
      s.kind === "line"
        ? { kind: "line", to: local(s.to) }
        : { kind: "cubic", c1: local(s.c1), c2: local(s.c2), to: local(s.to) },
    ),
  };
}

/** The outline as a polygon, with `steps` points per curve (lines stay single points). */
export function flattenOutline(outline: Outline, steps = 8): Point[] {
  const points: Point[] = [outline.start];
  let from = outline.start;
  for (const s of outline.segments) {
    if (s.kind === "line") {
      points.push(s.to);
    } else {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const k = 1 - t;
        const w0 = k * k * k;
        const w1 = 3 * k * k * t;
        const w2 = 3 * k * t * t;
        const w3 = t * t * t;
        points.push([
          w0 * from[0] + w1 * s.c1[0] + w2 * s.c2[0] + w3 * s.to[0],
          w0 * from[1] + w1 * s.c1[1] + w2 * s.c2[1] + w3 * s.to[1],
        ]);
      }
    }
    from = s.to;
  }
  points.pop(); // the last point closes the loop back onto the start
  return points;
}

/** Whether (x, z) is inside `polygon` (even–odd rule). */
export function pointInPolygon(polygon: readonly Point[], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i]!;
    const [xj, zj] = polygon[j]!;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Signed area (positive when clockwise with z pointing down). */
export function polygonArea(polygon: readonly Point[]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    sum += polygon[j]![0] * polygon[i]![1] - polygon[i]![0] * polygon[j]![1];
  }
  return sum / 2;
}
