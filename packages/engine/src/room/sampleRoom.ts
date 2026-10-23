import type { Seat, Table } from "@vcr/protocol";
import { mulberry32, type Vec3 } from "../math";
import type { BoxCollider } from "../locomotion/physics";

/**
 * A procedurally generated living room, built from simple shapes so every client produces the
 * exact same splats and the collision boxes match what you see. It stands in for a scanned room
 * until room capture lands (Phase 4) and keeps working offline.
 */

type Face = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
type RGB = [number, number, number];
/** Color at a point on a surface; `uv` is in meters along the face. */
type Paint = (p: Vec3, uv: [number, number]) => RGB;

interface BoxShape {
  kind: "box";
  center: Vec3;
  size: Vec3;
  faces: Face[];
  paint: Paint;
  collide: boolean;
}

interface SphereShape {
  kind: "sphere";
  center: Vec3;
  radius: number;
  paint: Paint;
  /** Splat size multiplier; foliage uses fuzzier, larger splats. */
  fluff: number;
}

type Shape = BoxShape | SphereShape;

/** Receives each generated splat. `quat` is [x, y, z, w]; `scale` is per-axis std dev in meters. */
export type SplatSink = (
  center: Vec3,
  scale: Vec3,
  quat: [number, number, number, number],
  opacity: number,
  color: RGB,
) => void;

// --- palette & surface paints -------------------------------------------------------------

const solid =
  (c: RGB): Paint =>
  () =>
    c;

const woodFloor: Paint = (p) => {
  // Planks 0.18 m wide running along X, each with its own tone, plus fine grain.
  const plank = Math.floor((p[2] + 10) / 0.18);
  const tone = mulberry32(plank * 7919)() * 0.12 - 0.06;
  const grain = Math.sin(p[0] * 40 + plank * 3.1) * 0.015;
  const seam = (p[2] + 10) % 0.18 < 0.008 ? -0.12 : 0;
  return [0.62 + tone + grain + seam, 0.45 + tone * 0.8 + grain + seam, 0.3 + tone * 0.5 + seam];
};

const wallPaint =
  (base: RGB, window?: { minU: number; maxU: number; minY: number; maxY: number }): Paint =>
  (p, [u]) => {
    if (p[1] < 0.1) return [0.93, 0.93, 0.9]; // baseboard
    if (window && u > window.minU && u < window.maxU && p[1] > window.minY && p[1] < window.maxY) {
      const frame =
        u - window.minU < 0.06 ||
        window.maxU - u < 0.06 ||
        p[1] - window.minY < 0.06 ||
        window.maxY - p[1] < 0.06 ||
        Math.abs(u - (window.minU + window.maxU) / 2) < 0.03;
      if (frame) return [0.95, 0.95, 0.93];
      const sky = (p[1] - window.minY) / (window.maxY - window.minY);
      return [0.62 + 0.25 * sky, 0.8 + 0.12 * sky, 0.98]; // daylight
    }
    return base;
  };

const rugPaint: Paint = (p) => {
  const stripe = Math.floor((p[0] + 10) / 0.25) % 2 === 0;
  const border = Math.abs(p[0] - 0.3) > 1.35 || Math.abs(p[2] - 0.2) > 0.85;
  if (border) return [0.55, 0.22, 0.2];
  return stripe ? [0.85, 0.78, 0.62] : [0.74, 0.62, 0.46];
};

const books: Paint = (p) => {
  const shelf = Math.floor(p[1] / 0.36);
  if (p[1] % 0.36 < 0.03) return [0.45, 0.32, 0.22]; // shelf board
  const book = Math.floor((p[2] + 10) / 0.045);
  const r = mulberry32(book * 31 + shelf * 977)();
  const palette: RGB[] = [
    [0.7, 0.2, 0.2],
    [0.2, 0.35, 0.6],
    [0.85, 0.7, 0.3],
    [0.25, 0.5, 0.35],
    [0.9, 0.88, 0.8],
    [0.35, 0.25, 0.45],
  ];
  return palette[Math.floor(r * palette.length)]!;
};

const SOFA: RGB = [0.22, 0.47, 0.5];
const WOOD: RGB = [0.45, 0.31, 0.2];
const WALL: RGB = [0.92, 0.89, 0.84];
const ACCENT_WALL: RGB = [0.78, 0.84, 0.8];

const box = (
  center: Vec3,
  size: Vec3,
  paint: Paint,
  opts: { faces?: Face[]; collide?: boolean } = {},
): BoxShape => ({
  kind: "box",
  center,
  size,
  paint,
  faces: opts.faces ?? ["+x", "-x", "+y", "+z", "-z"],
  collide: opts.collide ?? true,
});

// --- layout (meters; floor at y = 0, room spans x ∈ [-4, 4], z ∈ [-3, 3], 2.7 m ceiling) ---

const W = 4;
const D = 3;
const H = 2.7;

const SHAPES: Shape[] = [
  box([0, -0.05, 0], [2 * W, 0.1, 2 * D], woodFloor, { faces: ["+y"] }),
  box([0, H + 0.05, 0], [2 * W, 0.1, 2 * D], solid([0.96, 0.95, 0.93]), {
    faces: ["-y"],
  }),
  box(
    [0, H / 2, -D - 0.05],
    [2 * W, H, 0.1],
    wallPaint(WALL, { minU: -1.3, maxU: 1.3, minY: 0.9, maxY: 2.2 }),
    {
      faces: ["+z"],
    },
  ),
  box([0, H / 2, D + 0.05], [2 * W, H, 0.1], wallPaint(WALL), { faces: ["-z"] }),
  box([-W - 0.05, H / 2, 0], [0.1, H, 2 * D], wallPaint(ACCENT_WALL), { faces: ["+x"] }),
  box([W + 0.05, H / 2, 0], [0.1, H, 2 * D], wallPaint(WALL), { faces: ["-x"] }),

  // Rug (walk-over, no collision).
  box([0.3, 0.006, 0.2], [3, 0.012, 2], rugPaint, { faces: ["+y"], collide: false }),

  // Sofa against the north wall, facing +Z.
  box([0, 0.22, -2.15], [2.2, 0.44, 0.9], solid(SOFA)),
  box([0, 0.62, -2.52], [2.2, 0.8, 0.18], solid(SOFA)),
  box([-1.05, 0.33, -2.15], [0.2, 0.66, 0.9], solid([0.2, 0.43, 0.46])),
  box([1.05, 0.33, -2.15], [0.2, 0.66, 0.9], solid([0.2, 0.43, 0.46])),

  // Coffee table (one collider for the whole volume; you can't crawl under it).
  box([0.2, 0.42, -0.6], [1.2, 0.05, 0.6], solid(WOOD)),
  box([0.2, 0.2, -0.6], [1.1, 0.4, 0.5], solid([0.38, 0.26, 0.17]), {
    faces: ["+x", "-x", "+z", "-z"],
  }),

  // Armchair on the west side, facing +X.
  box([-2.6, 0.22, 0.4], [0.9, 0.44, 0.9], solid([0.75, 0.55, 0.3])),
  box([-3.0, 0.6, 0.4], [0.18, 0.8, 0.9], solid([0.7, 0.5, 0.27])),

  // Bookshelf on the east wall.
  box([W - 0.18, 0.95, -1.4], [0.36, 1.9, 1.3], books, { faces: ["-x", "+y", "+z", "-z"] }),

  // Raised reading nook in the south-west corner: a 15 cm step to walk up onto.
  box([-3.0, 0.075, 2.3], [2.0, 0.15, 1.4], solid([0.55, 0.4, 0.27])),
  box([-3.2, 0.4, 2.55], [0.9, 0.5, 0.6], solid([0.85, 0.82, 0.75])),

  // Plant: pot plus foliage.
  box([3.3, 0.22, 2.4], [0.4, 0.44, 0.4], solid([0.75, 0.42, 0.3])),
  { kind: "sphere", center: [3.3, 0.95, 2.4], radius: 0.42, paint: foliage(), fluff: 2.2 },

  // Floor lamp by the sofa.
  box([1.55, 0.75, -2.45], [0.05, 1.5, 0.05], solid([0.15, 0.15, 0.15])),
  {
    kind: "sphere",
    center: [1.55, 1.6, -2.45],
    radius: 0.22,
    paint: solid([1, 0.92, 0.7]),
    fluff: 1,
  },
];

function foliage(): Paint {
  return (p) => {
    const n = Math.sin(p[0] * 31) * Math.cos(p[1] * 27) * Math.sin(p[2] * 23);
    return [0.18 + 0.08 * n, 0.45 + 0.15 * n, 0.2 + 0.05 * n];
  };
}

export const SAMPLE_ROOM = {
  id: "sample-living-room",
  name: "Sample living room",
  bounds: { min: [-W, 0, -D] as Vec3, max: [W, H, D] as Vec3 },
  spawnPoints: [{ position: [0.3, 0, 1.2] as Vec3, yaw: Math.PI }],
  /** The sofa's three cushions and the armchair. */
  seats: [
    { id: 1, position: [-0.6, 0.44, -2.05], yaw: 0, height: 0.44, kind: "sofa", source: "user" },
    { id: 2, position: [0, 0.44, -2.05], yaw: 0, height: 0.44, kind: "sofa", source: "user" },
    { id: 3, position: [0.6, 0.44, -2.05], yaw: 0, height: 0.44, kind: "sofa", source: "user" },
    {
      id: 4,
      position: [-2.55, 0.44, 0.4],
      yaw: Math.PI / 2,
      height: 0.44,
      kind: "chair",
      source: "user",
    },
  ] satisfies Seat[],
  /** The coffee table's top. */
  tables: [
    {
      id: "coffee-table",
      name: "Coffee table",
      center: [0.2, 0.445, -0.6],
      yaw: 0,
      size: [1.2, 0.6],
      source: "user",
      games: ["jigsaw"],
    },
  ] satisfies Table[],
  lighting: { ambientColor: "#fff4e6", intensity: 1.1 },
};

export function sampleRoomColliders(): BoxCollider[] {
  return SHAPES.filter((s): s is BoxShape => s.kind === "box" && s.collide).map((s) => ({
    center: s.center,
    halfExtents: [s.size[0] / 2, s.size[1] / 2, s.size[2] / 2],
  }));
}

const FACE_FRAMES: Record<
  Face,
  { normal: Vec3; u: Vec3; v: Vec3; quat: [number, number, number, number] }
> = {
  // quat rotates the splat's local Z (its thin axis) onto the face normal.
  "+y": {
    normal: [0, 1, 0],
    u: [1, 0, 0],
    v: [0, 0, 1],
    quat: [-Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  },
  "-y": {
    normal: [0, -1, 0],
    u: [1, 0, 0],
    v: [0, 0, 1],
    quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  },
  "+x": { normal: [1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], quat: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
  "-x": {
    normal: [-1, 0, 0],
    u: [0, 0, 1],
    v: [0, 1, 0],
    quat: [0, -Math.SQRT1_2, 0, Math.SQRT1_2],
  },
  "+z": { normal: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], quat: [0, 0, 0, 1] },
  "-z": { normal: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], quat: [0, 1, 0, 0] },
};

/**
 * Emits the room's splats. `spacing` (meters between splats) trades detail for speed: the device
 * profile picks it. Returns the number of splats emitted.
 */
export function buildSampleRoomSplats(spacing: number, sink: SplatSink): number {
  const rand = mulberry32(1234);
  let count = 0;
  const jitter = (c: number) => c + (rand() - 0.5) * 0.08 * c;

  for (const shape of SHAPES) {
    if (shape.kind === "sphere") {
      const n = Math.ceil((4 * Math.PI * shape.radius ** 2) / spacing ** 2);
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < n; i++) {
        const y = 1 - (2 * (i + 0.5)) / n;
        const r = Math.sqrt(1 - y * y);
        const theta = golden * i;
        const wobble = 1 + (rand() - 0.5) * 0.15 * shape.fluff;
        const p: Vec3 = [
          shape.center[0] + Math.cos(theta) * r * shape.radius * wobble,
          shape.center[1] + y * shape.radius * wobble,
          shape.center[2] + Math.sin(theta) * r * shape.radius * wobble,
        ];
        const s = spacing * 0.6 * shape.fluff;
        const [cr, cg, cb] = shape.paint(p, [0, 0]);
        sink(p, [s, s, s], [0, 0, 0, 1], 0.95, [jitter(cr), jitter(cg), jitter(cb)]);
        count++;
      }
      continue;
    }

    const half: Vec3 = [shape.size[0] / 2, shape.size[1] / 2, shape.size[2] / 2];
    for (const face of shape.faces) {
      const f = FACE_FRAMES[face];
      const axis = (vec: Vec3) => vec.findIndex((c) => c !== 0);
      const ni = axis(f.normal);
      const ui = axis(f.u);
      const vi = axis(f.v);
      const sign = f.normal[ni]!;
      const extentU = shape.size[ui]!;
      const extentV = shape.size[vi]!;
      const nu = Math.max(1, Math.round(extentU / spacing));
      const nv = Math.max(1, Math.round(extentV / spacing));
      const su = extentU / nu;
      const sv = extentV / nv;
      for (let iu = 0; iu < nu; iu++) {
        for (let iv = 0; iv < nv; iv++) {
          const p: Vec3 = [...shape.center];
          p[ni] = shape.center[ni]! + sign * half[ni]!;
          const u = -half[ui]! + (iu + 0.5 + (rand() - 0.5) * 0.6) * su;
          const v = -half[vi]! + (iv + 0.5 + (rand() - 0.5) * 0.6) * sv;
          p[ui] = shape.center[ui]! + u;
          p[vi] = shape.center[vi]! + v;
          const [cr, cg, cb] = shape.paint(p, [p[ui]!, p[vi]!]);
          sink(p, [su * 0.6, sv * 0.6, 0.003], f.quat, 0.97, [jitter(cr), jitter(cg), jitter(cb)]);
          count++;
        }
      }
    }
  }
  return count;
}
