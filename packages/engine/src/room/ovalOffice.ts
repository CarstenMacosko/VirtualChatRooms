import type { Vec3 } from "../math";
import {
  box,
  type BuiltInRoom,
  type Finish,
  onOval,
  type PanelPart,
  type Picture,
  type RoomPart,
  seat,
} from "./builtInRoom";

/**
 * The built-in room everyone starts in: an Oval Office–inspired study. Inspired by the real
 * room's layout (the desk in the window bay, sofas facing each other, the fireplace), not a copy:
 * the rug's medallion is a plain star, not the Presidential Seal.
 */

/** The oval's half widths along X and Z, and the ceiling height (meters; floor at y = 0). */
const RX = 4.4;
const RZ = 5.4;
const H = 4.6;

const CREAM = "#e9dec4";
const TRIM = "#f6f2e8";
const GOLD = "#c9a24a";
const DARK_WOOD = "#4a2c1a";
const WOOD = "#7a5234";
const SOFA = "#e6d9b8";
const CHAIR = "#8a3a2c";

/** The sofas' distance from the middle: room to stand between them and the coffee table. */
const SOFA_X = 1.5;

const onWall = (angle: number, inset = 0, y = 0) => onOval(RX, RZ, angle, inset, y);

const onWallPanel = (
  angle: number,
  y: number,
  size: [number, number],
  picture: Picture,
  finish: Finish = "trim",
): PanelPart => {
  const { position, yaw } = onWall(angle, 0.03, y);
  return { kind: "panel", center: position, size, yaw, picture, color: "#ffffff", finish };
};

/** A sofa along Z at `x`, facing `toward` (+1: +X, −1: −X). */
function sofa(x: number, z: number, toward: 1 | -1): RoomPart[] {
  return [
    box([x, 0.22, z], [0.9, 0.44, 2.2], SOFA, "fabric"),
    box([x - toward * 0.36, 0.64, z], [0.18, 0.84, 2.2], SOFA, "fabric"),
    box([x, 0.33, z - 1.05], [0.9, 0.66, 0.2], SOFA, "fabric"),
    box([x, 0.33, z + 1.05], [0.9, 0.66, 0.2], SOFA, "fabric"),
    // Gold piping along the seat front.
    box([x + toward * 0.455, 0.42, z], [0.02, 0.03, 1.9], GOLD, "brass", { collide: false }),
  ];
}

/** An armchair at (x, z) facing +Z. */
function armchair(x: number, z: number): RoomPart[] {
  return [
    box([x, 0.22, z], [0.8, 0.44, 0.8], CHAIR, "fabric"),
    box([x, 0.66, z - 0.33], [0.8, 0.88, 0.16], CHAIR, "fabric"),
    box([x - 0.36, 0.34, z], [0.12, 0.68, 0.8], CHAIR, "fabric"),
    box([x + 0.36, 0.34, z], [0.12, 0.68, 0.8], CHAIR, "fabric"),
  ];
}

/** A side table with a lamp. */
function lampTable(x: number, z: number): RoomPart[] {
  return [
    box([x, 0.3, z], [0.5, 0.6, 0.5], DARK_WOOD, "darkWood"),
    {
      kind: "cylinder",
      center: [x, 0.78, z],
      radius: 0.07,
      height: 0.36,
      color: GOLD,
      finish: "brass",
    },
    {
      kind: "cylinder",
      center: [x, 1.08, z],
      radius: 0.22,
      radiusTop: 0.15,
      height: 0.26,
      color: "#fff3d6",
      finish: "glow",
    },
  ];
}

/**
 * A flag on a pole at (x, z), facing `yaw`, hanging off the pole away from the room's middle
 * (so it never hangs into the view of someone standing in front of the desk).
 */
function flag(x: number, z: number, yaw: number): RoomPart[] {
  const out = Math.sign(x) || 1;
  return [
    {
      kind: "cylinder",
      center: [x, 1.25, z],
      radius: 0.025,
      height: 2.5,
      color: GOLD,
      finish: "brass",
      collide: true,
    },
    { kind: "sphere", center: [x, 2.55, z], radius: 0.06, color: GOLD, finish: "brass" },
    {
      kind: "cylinder",
      center: [x, 0.04, z],
      radius: 0.18,
      height: 0.08,
      color: GOLD,
      finish: "brass",
    },
    {
      kind: "panel",
      center: [x + out * 0.42, 1.95, z],
      size: [0.8, 1.05],
      yaw,
      picture: "flag",
      color: "#ffffff",
      finish: "fabric",
    },
  ];
}

const PARTS: RoomPart[] = [
  // Floor, rug and ceiling.
  { kind: "oval", y: 0, radii: [RX, RZ], picture: "parquet", color: "#ffffff", finish: "wood" },
  { kind: "oval", y: 0.006, radii: [3.2, 3.9], picture: "rug", color: "#ffffff", finish: "fabric" },
  {
    kind: "oval",
    y: H,
    radii: [RX, RZ],
    picture: "ceiling",
    color: "#ffffff",
    finish: "trim",
    down: true,
  },

  // The oval wall: cream above, white wainscot, a chair rail, baseboard and crown molding.
  { kind: "wallBand", radii: [RX, RZ], y0: 0, y1: H, color: CREAM, finish: "paint", collide: true },
  {
    kind: "wallBand",
    radii: [RX - 0.012, RZ - 0.012],
    y0: 0,
    y1: 0.95,
    color: TRIM,
    finish: "trim",
  },
  {
    kind: "wallBand",
    radii: [RX - 0.035, RZ - 0.035],
    y0: 0.93,
    y1: 1.0,
    color: TRIM,
    finish: "trim",
  },
  {
    kind: "wallBand",
    radii: [RX - 0.03, RZ - 0.03],
    y0: 0,
    y1: 0.16,
    color: "#ece6d8",
    finish: "trim",
  },
  {
    kind: "wallBand",
    radii: [RX - 0.07, RZ - 0.07],
    y0: H - 0.32,
    y1: H,
    color: TRIM,
    finish: "trim",
  },

  // Three tall windows in the bay behind the desk with gold drapes between; one more each side.
  ...[-0.4, 0, 0.4].map((a) => onWallPanel(a, 1.95, [1.15, 2.9], "window", "glow")),
  ...[-0.62, -0.2, 0.2, 0.62].map((a) => {
    const { position, yaw } = onWall(a, 0.09, 2.05);
    return box(position, [0.34, 3.4, 0.08], GOLD, "fabric", { collide: false, yaw });
  }),
  onWallPanel(Math.PI / 2, 1.95, [1.15, 2.9], "window", "glow"),
  onWallPanel(-Math.PI / 2, 1.95, [1.15, 2.9], "window", "glow"),

  // Four doors set into the curve.
  ...[1.05, -1.05, 2.25, -2.25].map((a) => onWallPanel(a, 1.3, [1.05, 2.6], "door")),

  // Fireplace and a painting above it, flanked by built-in bookcases.
  box([0, 0.62, -RZ + 0.24], [1.9, 1.24, 0.34], "#f1ede4", "marble"),
  box([0, 1.27, -RZ + 0.27], [2.1, 0.06, 0.42], "#f1ede4", "marble", { collide: false }),
  {
    kind: "panel",
    center: [0, 0.48, -RZ + 0.415],
    size: [0.95, 0.8],
    yaw: 0,
    picture: "firebox",
    color: "#ffffff",
    finish: "glow",
  },
  {
    kind: "panel",
    center: [0, 2.35, -RZ + 0.08],
    size: [1.3, 1.0],
    yaw: 0,
    picture: "painting",
    color: "#ffffff",
    finish: "trim",
  },
  ...[2.72, -2.72].map((a) => onWallPanel(a, 1.45, [1.0, 2.1], "books")),

  // Two sofas facing each other across the coffee table, which is the game table.
  ...sofa(-SOFA_X, -0.4, 1),
  ...sofa(SOFA_X, -0.4, -1),
  box([0, 0.425, -0.4], [0.75, 0.05, 1.4], DARK_WOOD, "darkWood"),
  box([0, 0.2, -0.4], [0.62, 0.4, 1.26], "#3a2214", "darkWood"),
  ...lampTable(-SOFA_X, -1.95),
  ...lampTable(SOFA_X, -1.95),

  // Armchairs by the fireplace.
  ...armchair(-0.8, -2.65),
  ...armchair(0.8, -2.65),

  // The desk in the window bay, its chair, and the flags behind it.
  box([0, 0.38, 3.3], [1.85, 0.76, 0.95], DARK_WOOD, "darkWood"),
  box([0, 0.775, 3.3], [1.95, 0.04, 1.03], "#3a2214", "darkWood", { collide: false }),
  box([0, 0.32, 3.3 - 0.48], [1.5, 0.5, 0.02], WOOD, "wood", { collide: false }),
  box([0, 0.25, 4.3], [0.62, 0.5, 0.6], "#2a1a12", "leather"),
  box([0, 0.9, 4.58], [0.62, 0.85, 0.12], "#2a1a12", "leather"),
  ...flag(-1.3, 4.45, Math.PI),
  ...flag(1.3, 4.45, Math.PI),

  // Plants on plinths where the doors leave room.
  ...[1.62, -1.62].flatMap((a): RoomPart[] => {
    const [x, , z] = onWall(a, 0.45).position;
    return [
      {
        kind: "cylinder",
        center: [x, 0.25, z],
        radius: 0.24,
        radiusTop: 0.2,
        height: 0.5,
        color: "#b9b2a4",
        finish: "marble",
        collide: true,
      },
      { kind: "sphere", center: [x, 0.85, z], radius: 0.42, color: "#3f6b3a", finish: "fabric" },
    ];
  }),
];

/** A sofa's three seats, front to back along Z. */
const sofaSeats = (x: number, toward: 1 | -1, first: number) =>
  [-0.62, 0, 0.62].map((dz, i) =>
    seat(first + i, [x - toward * 0.1, 0.44, -0.4 + dz], (toward * Math.PI) / 2, "sofa"),
  );

export const OVAL_OFFICE: BuiltInRoom = {
  id: "oval-office",
  name: "Oval Office",
  bounds: { min: [-RX, 0, -RZ] as Vec3, max: [RX, H, RZ] as Vec3 },
  /** Between the desk and the sofas, looking across the room to the fireplace. */
  spawnPoints: [{ position: [0, 0, 1.8], yaw: Math.PI }],
  seats: [
    ...sofaSeats(-SOFA_X, 1, 1),
    ...sofaSeats(SOFA_X, -1, 4),
    seat(7, [-0.8, 0.44, -2.55], 0),
    seat(8, [0.8, 0.44, -2.55], 0),
    seat(9, [0, 0.5, 4.25], Math.PI),
  ],
  /** The coffee table between the sofas. */
  tables: [
    {
      id: "coffee-table",
      name: "Coffee table",
      center: [0, 0.45, -0.4],
      yaw: Math.PI / 2,
      size: [1.4, 0.75],
      source: "user",
      games: ["jigsaw"],
    },
  ],
  lighting: { ambientColor: "#fff6e6", intensity: 1.1 },
  lights: [
    // Daylight from the window bay, and the lamps' warm glow over the sofas.
    { position: [0, 3.2, 3.6], intensity: 9, color: "#fff4e0", distance: 9 },
    { position: [0, 3.6, -1.2], intensity: 7, color: "#ffe7c4", distance: 9 },
  ],
  parts: PARTS,
};
