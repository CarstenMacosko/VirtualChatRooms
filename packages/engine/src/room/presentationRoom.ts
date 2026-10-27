import type { Seat } from "@vcr/protocol";
import type { Vec3 } from "../math";
import { box, type BuiltInRoom, type RoomPart, seat } from "./builtInRoom";

/**
 * A big presentation hall: a stage with a projector screen that shows whatever someone in the
 * call shares, rows of chairs facing it, standing desks along one side, and a lounge corner with a
 * game table at the back. The room spans x ∈ [−W, W], z ∈ [−D, D]; the screen is at −Z.
 */

const W = 7;
const D = 9;
const H = 5;
/** The stage: 20 cm up, low enough to step onto. */
const STAGE_TOP = 0.2;
const STAGE_FRONT = -6.2;

const WALL = "#dfe3e8";
const ACCENT = "#2d3b52";
const CHAIR = "#33507a";
const METAL = "#9aa3ad";
const OAK = "#b98a5a";

/** The projector screen: 16:9, centered on the front wall above the stage. */
export const PROJECTOR_SCREEN = {
  center: [0, 2.75, -D + 0.08] as Vec3,
  size: [6.4, 3.6] as [number, number],
  yaw: 0,
};

/** A chair at (x, z) facing `yaw`. */
function chair(x: number, z: number, yaw: number): RoomPart[] {
  const back = [-Math.sin(yaw) * 0.22, -Math.cos(yaw) * 0.22];
  return [
    box([x, 0.225, z], [0.5, 0.45, 0.5], CHAIR, "fabric", { yaw }),
    box([x + back[0]!, 0.7, z + back[1]!], [0.5, 0.55, 0.08], CHAIR, "fabric", { yaw }),
  ];
}

/** A standing desk at (x, z), its long side along Z, with a monitor facing −X and a stool. */
function standingDesk(x: number, z: number): RoomPart[] {
  return [
    box([x, 1.04, z], [0.75, 0.04, 1.4], OAK, "wood"),
    box([x + 0.25, 0.51, z - 0.6], [0.06, 1.02, 0.06], METAL, "metal"),
    box([x + 0.25, 0.51, z + 0.6], [0.06, 1.02, 0.06], METAL, "metal"),
    box([x + 0.25, 0.02, z], [0.6, 0.04, 1.3], METAL, "metal", { collide: false }),
    box([x + 0.2, 1.36, z], [0.04, 0.38, 0.62], "#14181f", "metal", { collide: false }),
    // The stool, on the walkway side.
    {
      kind: "cylinder",
      center: [x - 0.75, 0.37, z],
      radius: 0.05,
      height: 0.74,
      color: METAL,
      finish: "metal",
      collide: true,
    },
    {
      kind: "cylinder",
      center: [x - 0.75, 0.76, z],
      radius: 0.2,
      height: 0.05,
      color: ACCENT,
      finish: "leather",
    },
  ];
}

/** A two-seat lounge sofa at (x, z) facing `toward` along X (+1: +X, −1: −X). */
function loungeSofa(x: number, z: number, toward: 1 | -1): RoomPart[] {
  return [
    box([x, 0.21, z], [0.85, 0.42, 1.7], "#c25b3c", "fabric"),
    box([x - toward * 0.34, 0.62, z], [0.17, 0.8, 1.7], "#c25b3c", "fabric"),
  ];
}

const ROWS = [-3.4, -2.2, -1.0];
const ROW_XS = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5];
const DESK_ZS = [-3.2, -1.2, 0.8, 2.8];

const PARTS: RoomPart[] = [
  // Floor, ceiling and walls.
  box([0, -0.05, 0], [2 * W, 0.1, 2 * D], "#ffffff", "carpet", {
    collide: false,
    picture: "carpet",
  }),
  box([0, H + 0.05, 0], [2 * W, 0.1, 2 * D], "#f5f6f7", "trim", { collide: false }),
  box([0, H / 2, -D - 0.15], [2 * W + 0.6, H, 0.3], ACCENT, "paint"),
  box([0, H / 2, D + 0.15], [2 * W + 0.6, H, 0.3], WALL, "paint"),
  box([-W - 0.15, H / 2, 0], [0.3, H, 2 * D], WALL, "paint"),
  box([W + 0.15, H / 2, 0], [0.3, H, 2 * D], WALL, "paint"),
  // Skirting along the long walls.
  box([-W + 0.01, 0.06, 0], [0.02, 0.12, 2 * D], "#c3c9d1", "trim", { collide: false }),
  box([W - 0.01, 0.06, 0], [0.02, 0.12, 2 * D], "#c3c9d1", "trim", { collide: false }),

  // Ceiling light panels.
  ...[-6, -2, 2, 6].flatMap((z) =>
    [-3.5, 0, 3.5].map((x) =>
      box([x, H - 0.02, z], [1.4, 0.04, 0.7], "#fffaf0", "glow", { collide: false }),
    ),
  ),

  // City windows down the west wall; acoustic panels on the east wall above the desks.
  ...[-5.5, -2, 1.5, 5].map((z): RoomPart => ({
    kind: "panel",
    center: [-W + 0.02, 2.3, z],
    size: [2.6, 2.8],
    yaw: Math.PI / 2,
    picture: "cityWindow",
    color: "#ffffff",
    finish: "glow",
  })),
  ...[-4.2, -1.4, 1.4, 4.2].map((z): RoomPart => ({
    kind: "panel",
    center: [W - 0.02, 2.9, z],
    size: [2.2, 1.6],
    yaw: -Math.PI / 2,
    picture: "acoustic",
    color: "#ffffff",
    finish: "fabric",
  })),
  // Doors at the back.
  ...[-3.5, 3.5].map((x): RoomPart => ({
    kind: "panel",
    center: [x, 1.15, D - 0.02],
    size: [1.1, 2.3],
    yaw: Math.PI,
    picture: "door",
    color: "#ffffff",
    finish: "trim",
  })),

  // The stage, the projector screen above it, a lectern, and the projector on the ceiling.
  box(
    [0, STAGE_TOP / 2, (STAGE_FRONT - D) / 2],
    [10, STAGE_TOP, D + STAGE_FRONT],
    "#3a3f48",
    "wood",
  ),
  box([0, STAGE_TOP - 0.01, STAGE_FRONT + 0.03], [10, 0.02, 0.06], "#c9a24a", "brass", {
    collide: false,
  }),
  box(
    [PROJECTOR_SCREEN.center[0], PROJECTOR_SCREEN.center[1], -D + 0.04],
    [PROJECTOR_SCREEN.size[0] + 0.24, PROJECTOR_SCREEN.size[1] + 0.24, 0.04],
    "#111418",
    "metal",
    { collide: false },
  ),
  { kind: "screen", ...PROJECTOR_SCREEN, color: "#f4f5f7", finish: "glow" },
  box([-3.3, STAGE_TOP + 0.55, -7.2], [0.6, 1.1, 0.45], "#4a2c1a", "darkWood"),
  box([-3.3, STAGE_TOP + 1.12, -7.27], [0.7, 0.04, 0.5], "#3a2214", "darkWood", {
    collide: false,
    yaw: 0.2,
  }),
  box([0, H - 0.35, 0.5], [0.45, 0.18, 0.5], "#e8eaed", "metal", { collide: false }),
  box([0, H - 0.15, 0.5], [0.04, 0.3, 0.04], METAL, "metal", { collide: false }),
  box([0, H - 0.35, 0.245], [0.12, 0.12, 0.01], "#cfe6ff", "glow", { collide: false }),

  // Rows of chairs facing the screen.
  ...ROWS.flatMap((z) => ROW_XS.flatMap((x) => chair(x, z, Math.PI))),

  // Standing desks along the east wall.
  ...DESK_ZS.flatMap((z) => standingDesk(5.6, z)),

  // The lounge corner at the back: two sofas and a coffee table with a puzzle.
  ...loungeSofa(-4.6, 5.6, 1),
  ...loungeSofa(-1.6, 5.6, -1),
  box([-3.1, 0.4, 5.6], [1.3, 0.05, 0.75], OAK, "wood", { yaw: Math.PI / 2 }),
  box([-3.1, 0.19, 5.6], [1.15, 0.38, 0.6], "#8a6340", "wood", { yaw: Math.PI / 2 }),
  { kind: "sphere", center: [-6.3, 0.9, 8.2], radius: 0.5, color: "#3f6b3a", finish: "fabric" },
  {
    kind: "cylinder",
    center: [-6.3, 0.25, 8.2],
    radius: 0.3,
    radiusTop: 0.26,
    height: 0.5,
    color: "#e6e1d6",
    finish: "marble",
    collide: true,
  },
  { kind: "sphere", center: [6.3, 0.9, 8.2], radius: 0.5, color: "#3f6b3a", finish: "fabric" },
  {
    kind: "cylinder",
    center: [6.3, 0.25, 8.2],
    radius: 0.3,
    radiusTop: 0.26,
    height: 0.5,
    color: "#e6e1d6",
    finish: "marble",
    collide: true,
  },
];

const rowSeats: Seat[] = ROWS.flatMap((z, row) =>
  ROW_XS.map((x, i) => seat(1 + row * ROW_XS.length + i, [x, 0.45, z - 0.02], Math.PI)),
);
const firstStool = rowSeats.length + 1;

export const PRESENTATION_ROOM: BuiltInRoom = {
  id: "presentation",
  name: "Presentation hall",
  bounds: { min: [-W, 0, -D], max: [W, H, D] },
  /** Behind the chairs, looking at the screen. */
  spawnPoints: [{ position: [0, 0, 2.2], yaw: Math.PI }],
  seats: [
    ...rowSeats,
    // Stools at the standing desks, facing the desk (+X).
    ...DESK_ZS.map((z, i) => seat(firstStool + i, [4.85, 0.78, z], Math.PI / 2)),
    // The lounge sofas, two seats each, facing each other across the coffee table.
    ...[5.2, 6.0].map((z, i) =>
      seat(firstStool + DESK_ZS.length + i, [-4.5, 0.42, z], Math.PI / 2, "sofa"),
    ),
    ...[5.2, 6.0].map((z, i) =>
      seat(firstStool + DESK_ZS.length + 2 + i, [-1.7, 0.42, z], -Math.PI / 2, "sofa"),
    ),
  ],
  tables: [
    {
      id: "lounge-table",
      name: "Lounge table",
      center: [-3.1, 0.425, 5.6],
      yaw: Math.PI / 2,
      size: [1.3, 0.75],
      source: "user",
      games: ["jigsaw"],
    },
  ],
  lighting: { ambientColor: "#f3f6ff", intensity: 1.2 },
  lights: [
    { position: [0, 4.2, -3], intensity: 14, color: "#ffffff", distance: 14 },
    { position: [0, 4.2, 4], intensity: 12, color: "#fff6ea", distance: 14 },
  ],
  parts: PARTS,
};
