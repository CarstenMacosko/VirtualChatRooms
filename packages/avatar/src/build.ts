import type { AvatarRecipe, HairStyle } from "@vcr/protocol";
import { type BoneSpec, type MaterialSpec, writeVrm } from "./glb";
import {
  capsule,
  clamp01,
  ellipsoid,
  lerp,
  type Part,
  patch,
  shapedSphere,
  type Shaper,
  torus,
  type V3,
} from "./mesh";
import { mixHex } from "./palette";

/**
 * Builds a stylized, Bitmoji-spirited avatar (big head, big readable eyes, simple mitten hands,
 * toon shading) as a VRM 1.0 file from a recipe. Everything is original procedural geometry,
 * so there are no third-party assets to license (PLAN.md § 4.2).
 *
 * Coordinates: meters, Y up, the avatar faces +Z, its left is +X (VRM 1.0 conventions).
 */

/** Face morph targets, in the order the Face mesh stores them. */
export const FACE_TARGETS = [
  "blinkLeft",
  "blinkRight",
  "aa",
  "ih",
  "ou",
  "ee",
  "oh",
  "happy",
  "angry",
  "sad",
  "surprised",
  "relaxed",
] as const;
type FaceTarget = (typeof FACE_TARGETS)[number];

/** Bumped when generated geometry changes, so caches of built avatars can tell versions apart. */
export const GENERATOR_VERSION = 2;

export function buildAvatarVrm(recipe: AvatarRecipe): Uint8Array {
  const shape = new AvatarShape(recipe);
  return writeVrm({
    name: "VirtualChatRooms avatar",
    bones: shape.bones(),
    materials: shape.materials(),
    meshes: [
      { name: "Body", parts: shape.bodyParts() },
      { name: "Face", parts: shape.faceParts(), targets: FACE_TARGETS },
    ],
    expressions: {
      blink: [
        { mesh: "Face", target: "blinkLeft", weight: 1 },
        { mesh: "Face", target: "blinkRight", weight: 1 },
      ],
      ...Object.fromEntries(FACE_TARGETS.map((t) => [t, [{ mesh: "Face", target: t, weight: 1 }]])),
    },
  });
}

const isJacket = (top: AvatarRecipe["outfit"]["top"]): top is "tuxedo" | "suit" =>
  top === "tuxedo" || top === "suit";

const FACE_FRONT = (n: V3) => n[2] > 0.42 && n[1] < 0.55;

class AvatarShape {
  /** Overall size: everything is built at base size, then scaled by this. */
  readonly scale: number;
  /** Body width multiplier (build slider). */
  private readonly wide: number;
  // Head ellipsoid and its jaw taper.
  private readonly cy = 1.57;
  private readonly rx: number;
  private readonly ry: number;
  private readonly rz = 0.165;
  private readonly jawFactor: number;
  // Face features.
  private readonly eyeY: number;
  private readonly eyeX: number;
  private readonly eyeW: number;
  private readonly eyeH: number;
  private readonly mouthY: number;
  private readonly mouthW: number;
  private readonly shoulderX: number;
  private readonly legX: number;

  constructor(private readonly r: AvatarRecipe) {
    const f = r.face;
    this.scale = lerp(0.9, 1.07, r.body.height);
    this.wide = lerp(0.86, 1.2, r.body.build);
    this.rx = lerp(0.142, 0.174, f.width);
    this.ry = lerp(0.168, 0.198, f.length);
    this.jawFactor = lerp(0.6, 0.88, f.jaw);
    this.eyeY = this.cy + 0.008;
    this.eyeX = lerp(0.044, 0.068, f.eyeSpacing);
    this.eyeW = lerp(0.026, 0.043, f.eyeSize);
    this.eyeH = this.eyeW * 1.22;
    this.mouthY = this.cy - this.ry * 0.53;
    this.mouthW = lerp(0.028, 0.05, f.mouthWidth);
    this.shoulderX = 0.165 * this.wide;
    this.legX = 0.08 * this.wide;
  }

  bones(): BoneSpec[] {
    const s = this.scale;
    const sx = this.shoulderX;
    const lx = this.legX;
    const left: BoneSpec[] = [
      { name: "leftUpperArm", parent: "chest", at: [sx, 1.3, 0] },
      { name: "leftLowerArm", parent: "leftUpperArm", at: [sx + 0.22, 1.3, 0] },
      { name: "leftHand", parent: "leftLowerArm", at: [sx + 0.41, 1.3, 0] },
      { name: "leftUpperLeg", parent: "hips", at: [lx, 0.85, 0] },
      { name: "leftLowerLeg", parent: "leftUpperLeg", at: [lx, 0.47, 0] },
      { name: "leftFoot", parent: "leftLowerLeg", at: [lx, 0.09, 0] },
    ];
    const right = left.map((b) => ({
      name: b.name.replace("left", "right"),
      parent: b.parent?.replace("left", "right") ?? null,
      at: [-b.at[0], b.at[1], b.at[2]] as V3,
    }));
    const all: BoneSpec[] = [
      { name: "hips", parent: null, at: [0, 0.88, 0] },
      { name: "spine", parent: "hips", at: [0, 0.98, 0] },
      { name: "chest", parent: "spine", at: [0, 1.16, 0] },
      { name: "neck", parent: "chest", at: [0, 1.34, 0] },
      { name: "head", parent: "neck", at: [0, 1.4, 0] },
      ...left,
      ...right,
    ];
    return all.map((b) => ({ ...b, at: [b.at[0] * s, b.at[1] * s, b.at[2] * s] }));
  }

  materials(): MaterialSpec[] {
    const r = this.r;
    const hair = r.hair.style === "bald" ? r.skin : r.hair.color;
    return [
      { name: "Skin", color: r.skin, outline: true },
      { name: "Hair", color: r.hair.color, outline: true, doubleSided: true },
      {
        name: "FacialHair",
        color: r.facialHair === "stubble" ? mixHex(r.skin, r.hair.color, 0.45) : r.hair.color,
      },
      { name: "Top", color: r.outfit.topColor, outline: true, doubleSided: true },
      { name: "Bottom", color: r.outfit.bottomColor, outline: true, doubleSided: true },
      { name: "Shoes", color: r.outfit.shoesColor, outline: true },
      // The formal jackets: shirt front and cuffs, bow tie and buttons, satin lapels.
      { name: "Shirt", color: "#f6f5f1", outline: true },
      { name: "Tie", color: "#16141b", outline: true },
      { name: "Lapel", color: mixHex(r.outfit.topColor, "#ffffff", 0.14) },
      { name: "Hat", color: r.hat.color, outline: true, doubleSided: true },
      { name: "Frame", color: "#26222b" },
      { name: "EyeWhite", color: "#fbfbfd", shade: "#d9d9e6" },
      { name: "Iris", color: r.eyeColor },
      { name: "Ink", color: "#1b1720", shade: "#1b1720" },
      { name: "Mouth", color: "#5c1f2a", shade: "#3e141c" },
      { name: "Brow", color: mixHex(hair, "#1a1410", r.hair.style === "bald" ? 0.55 : 0.3) },
    ];
  }

  // --- head ------------------------------------------------------------------------------

  /** The head surface (or a hair/hat shell `scale` times its size), with the jaw taper. */
  private headShell(scale = 1, lift = 0, back = 0): Shaper {
    return (n) => {
      let x = n[0] * this.rx;
      const y = n[1] * this.ry;
      let z = n[2] * this.rz;
      if (n[1] < 0) {
        const t = (-n[1]) ** 1.4;
        x *= lerp(1, this.jawFactor, t);
        z *= lerp(1, 0.9, t);
      }
      return [x * scale, this.cy + y * scale + lift, z * scale + back];
    };
  }

  /** Front surface depth of the head at (x, y), for laying features onto the face. */
  private faceZ(x: number, y: number): number {
    const ny = (y - this.cy) / this.ry;
    let fx = 1;
    let fz = 1;
    if (ny < 0) {
      const t = (-ny) ** 1.4;
      fx = lerp(1, this.jawFactor, t);
      fz = lerp(1, 0.9, t);
    }
    const nx = x / (this.rx * fx);
    return Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) * this.rz * fz;
  }

  // --- face (morph targets) --------------------------------------------------------------

  faceParts(): Part[] {
    return this.scaled([
      ...this.eye(1),
      ...this.eye(-1),
      this.brow(1),
      this.brow(-1),
      this.mouth(),
    ]);
  }

  /** One eye: white, iris, pupil, highlight and a hidden lid line that blinks and smiles. */
  private eye(side: 1 | -1): Part[] {
    const ex = this.eyeX * side;
    const { eyeY: ey, eyeW: ew, eyeH: eh } = this;
    const zw = this.faceZ(ex, ey) - 0.007;
    const closeY = ey - eh * 0.3;
    const blink: FaceTarget = side === 1 ? "blinkLeft" : "blinkRight";
    /** Squashes a feature toward the closed-eye line; `amount` 1 is fully shut. */
    const squash =
      (base: Shaper, amount: number, lift = 0): Shaper =>
      (n) => {
        const p = base(n);
        return [p[0], closeY + lift + (p[1] - closeY) * (1 - amount), p[2]];
      };
    const featureMorphs = (base: Shaper) => ({
      [blink]: squash(base, 0.93),
      happy: squash(base, 0.85, eh * 0.12),
      surprised: grow(base, [ex, ey, zw], 1.12),
      angry: squash(base, 0.25, -eh * 0.05),
      sad: squash(base, 0.2),
      relaxed: squash(base, 0.4),
    });
    const white = ellipsoid([ex, ey, zw], [ew, eh, 0.016]);
    const iris = ellipsoid([ex, ey - eh * 0.08, zw + 0.01], [ew * 0.62, eh * 0.6, 0.011]);
    const pupil = ellipsoid([ex, ey - eh * 0.08, zw + 0.016], [ew * 0.3, eh * 0.3, 0.007]);
    const glint = ellipsoid(
      [ex + ew * 0.24, ey + eh * 0.22, zw + 0.022],
      [ew * 0.17, ew * 0.17, 0.004],
    );
    // The lid sits inside the head until a blink (or a smile) pushes it out over the eye.
    const lidAt: V3 = [ex, closeY, zw - 0.03];
    const lid = ellipsoid(lidAt, [ew * 1.08, 0.0055, 0.004]);
    /** Pushes the lid out in front of the squashed eye, bent into an arch (^ when smiling). */
    const lidOf =
      (arch: number): Shaper =>
      (n) => {
        const p = lid(n);
        const t = (p[0] - ex) / (ew * 1.08);
        return [p[0], p[1] + arch * (1 - t * t), p[2] + 0.048];
      };
    const res = { rings: 10, segments: 18 };
    return [
      shapedSphere("EyeWhite", "head", white, res, featureMorphs(white)),
      shapedSphere("Iris", "head", iris, res, featureMorphs(iris)),
      shapedSphere("Ink", "head", pupil, { rings: 8, segments: 12 }, featureMorphs(pupil)),
      shapedSphere("EyeWhite", "head", glint, { rings: 6, segments: 8 }, featureMorphs(glint)),
      shapedSphere(
        "Ink",
        "head",
        lid,
        { rings: 6, segments: 14 },
        {
          [blink]: lidOf(-0.004),
          happy: lidOf(eh * 0.12 + 0.009),
        },
      ),
    ];
  }

  private brow(side: 1 | -1): Part {
    const bx = this.eyeX * side;
    const by = this.eyeY + this.eyeH + 0.022;
    const w = this.eyeW * 1.15;
    const z = this.faceZ(bx, by) + 0.001;
    const base: Shaper = (n) => {
      const p = ellipsoid([bx, by, z], [w, 0.0078, 0.006])(n);
      const t = (p[0] - bx) / w;
      return [p[0], p[1] + 0.006 * (1 - t * t), p[2]];
    };
    /** Raises the brow by `inner` at the nose end and `outer` at the temple end. */
    const tilt =
      (inner: number, outer: number): Shaper =>
      (n) => {
        const p = base(n);
        const t = clamp01(((p[0] - bx) * side) / (2 * w) + 0.5); // 0 inner → 1 outer
        return [p[0], p[1] + lerp(inner, outer, t), p[2]];
      };
    return shapedSphere(
      "Brow",
      "head",
      base,
      { rings: 6, segments: 16 },
      {
        angry: tilt(-0.014, 0.004),
        sad: tilt(0.013, -0.004),
        surprised: tilt(0.017, 0.015),
        happy: tilt(0.006, 0.006),
        relaxed: tilt(-0.002, -0.002),
      },
    );
  }

  private mouth(): Part {
    const { mouthY: my, mouthW: mw } = this;
    const at =
      (sx: number, sy: number, curve: number): Shaper =>
      (n) => {
        const x = n[0] * mw * sx;
        const y = my + n[1] * 0.0058 * sy + curve * (x / mw) ** 2;
        return [x, y, this.faceZ(x, y) + n[2] * 0.0045 - 0.0005];
      };
    return shapedSphere(
      "Mouth",
      "head",
      at(1, 1, 0.006),
      { rings: 8, segments: 24 },
      {
        aa: at(0.85, 4.4, 0),
        ih: at(1.05, 2.6, 0.004),
        ou: at(0.5, 2.9, 0),
        ee: at(1.2, 2.1, 0.006),
        oh: at(0.66, 4, 0),
        happy: at(1.15, 3, 0.022),
        sad: at(0.9, 1, -0.014),
        angry: at(0.85, 1.3, -0.01),
        surprised: at(0.56, 4.6, 0),
        relaxed: at(1, 1, 0.012),
      },
    );
  }

  // --- body ------------------------------------------------------------------------------

  bodyParts(): Part[] {
    return this.scaled([
      ...this.head(),
      ...this.hair(),
      ...this.facialHair(),
      ...this.torso(),
      ...this.arm(1),
      ...this.arm(-1),
      ...this.leg(1),
      ...this.leg(-1),
      ...this.glasses(),
      ...this.hat(),
    ]);
  }

  private head(): Part[] {
    const noseY = this.cy - this.ry * 0.2;
    const nose = lerp(0.014, 0.026, this.r.face.noseSize);
    return [
      shapedSphere("Skin", "head", this.headShell(), { rings: 22, segments: 32 }),
      shapedSphere(
        "Skin",
        "head",
        ellipsoid([0, noseY, this.faceZ(0, noseY) - 0.004], [nose, nose * 0.85, 0.016]),
        { rings: 8, segments: 12 },
      ),
      ...([1, -1] as const).map((side) =>
        shapedSphere(
          "Skin",
          "head",
          ellipsoid([side * this.rx * 0.96, this.cy - 0.012, -0.008], [0.022, 0.038, 0.026]),
          { rings: 8, segments: 12 },
        ),
      ),
      capsule("Skin", "neck", [0, 1.3, 0], [0, 1.43, 0], 0.052, 0.05),
    ];
  }

  private hair(): Part[] {
    const style = this.r.hair.style;
    const shell = (scale: number, keep: (n: V3) => boolean, deform?: (p: V3, n: V3) => V3) => {
      const base = this.headShell(scale);
      return shapedSphere("Hair", "head", deform ? (n) => deform(base(n), n) : base, {
        rings: 22,
        segments: 32,
        keep,
      });
    };
    const cap = (n: V3) => (n[1] > 0.08 || (n[2] < -0.25 && n[1] > -0.42)) && !FACE_FRONT(n);
    const fringe = (p: V3, n: V3): V3 =>
      n[2] > 0.25 && n[1] > 0.35 ? [p[0], p[1], p[2] + 0.014 * n[2]] : p;
    const { cy, rz } = this;
    switch (style as HairStyle) {
      case "bald":
        return [];
      case "buzz":
        return [shell(1.022, cap)];
      case "short":
        return [shell(1.07, cap, fringe)];
      case "swoop":
        return [
          shell(1.08, cap, (p, n) => {
            const q = fringe(p, n);
            const up = Math.max(0, n[1]) ** 2;
            return [q[0] + 0.022 * up, q[1] + 0.04 * up * (0.6 + 0.4 * n[2]), q[2] + 0.01 * up];
          }),
        ];
      case "curly": {
        const parts = [shell(1.03, cap)];
        const shellAt = this.headShell(1.06);
        for (const n of fibonacciSphere(150)) {
          if (!cap(n) || n[1] < -0.3) continue;
          const c = shellAt(n);
          parts.push(
            shapedSphere("Hair", "head", ellipsoid(c, [0.04, 0.04, 0.04]), {
              rings: 6,
              segments: 8,
            }),
          );
        }
        return parts;
      }
      case "bob":
      case "long": {
        const bob = shell(
          1.12,
          (n) => !(n[2] > 0.3 && n[1] < 0.52) && n[1] > -0.72,
          (p, n) => (n[1] < 0 ? [p[0] * (1 + 0.14 * -n[1]), p[1], p[2]] : p),
        );
        if (style === "bob") return [bob];
        const panel = ellipsoid([0, cy - 0.2, -0.085], [this.rx * 1.08, 0.25, 0.075]);
        return [bob, shapedSphere("Hair", "head", panel, { rings: 14, segments: 20 })];
      }
      case "ponytail":
        return [
          shell(1.07, cap, fringe),
          shapedSphere("Hair", "head", ellipsoid([0, cy + 0.02, -rz * 1.08], [0.03, 0.03, 0.03]), {
            rings: 8,
            segments: 10,
          }),
          shapedSphere(
            "Hair",
            "head",
            ellipsoid([0, cy - 0.09, -rz * 1.14 - 0.025], [0.047, 0.135, 0.05]),
            { rings: 12, segments: 14 },
          ),
        ];
      case "bun":
        return [
          shell(1.07, cap, fringe),
          shapedSphere(
            "Hair",
            "head",
            ellipsoid([0, cy + this.ry * 0.98, -rz * 0.3], [0.072, 0.066, 0.072]),
            { rings: 12, segments: 16 },
          ),
        ];
      case "afro": {
        const base = this.headShell(1.4, 0.045, -0.02);
        return [
          shapedSphere("Hair", "head", base, {
            rings: 22,
            segments: 32,
            keep: (n) => !(n[2] > 0.5 && n[1] < 0.4) && n[1] > -0.45,
          }),
        ];
      }
    }
  }

  private facialHair(): Part[] {
    const kind = this.r.facialHair;
    if (kind === "none") return [];
    const { mouthY: my, mouthW: mw } = this;
    if (kind === "mustache") {
      const y = my + 0.017;
      const shape: Shaper = (n) => {
        const x = n[0] * mw * 1.15;
        const yy = y + n[1] * 0.011 - 0.009 * (x / mw) ** 2;
        return [x, yy, this.faceZ(x, yy) + 0.002 + n[2] * 0.008];
      };
      return [shapedSphere("FacialHair", "head", shape, { rings: 8, segments: 18 })];
    }
    const scale = kind === "stubble" ? 1.012 : 1.03;
    const shell = this.headShell(scale);
    return [
      shapedSphere("FacialHair", "head", shell, {
        rings: 22,
        segments: 32,
        keep: (n) => {
          const region = n[1] < -0.14 || (Math.abs(n[0]) > 0.6 && n[1] < 0.1 && n[2] > -0.2);
          if (!region || n[2] < -0.25) return false;
          const p = shell(n);
          // Leave the mouth uncovered.
          return !(Math.abs(p[0]) < mw * 1.35 && Math.abs(p[1] - my) < 0.024 && p[2] > 0);
        },
      }),
    ];
  }

  private torso(): Part[] {
    const w = this.wide;
    const { top } = this.r.outfit;
    // A dress, or a jacket's skirts, cover the hips.
    const bottom = top === "dress" || isJacket(top) ? "Top" : "Bottom";
    const parts: Part[] = [
      shapedSphere("Top", "chest", ellipsoid([0, 1.2, 0], [0.158 * w, 0.17, 0.104 * w], 0.8)),
      shapedSphere("Top", "spine", ellipsoid([0, 1.04, 0], [0.152 * w, 0.15, 0.1 * w], 0.85)),
      shapedSphere(bottom, "hips", ellipsoid([0, 0.9, 0], [0.154 * w, 0.1, 0.103 * w], 0.85)),
    ];
    for (const side of [1, -1]) {
      // Shoulder caps hide the joint where the arm meets the chest.
      parts.push(
        shapedSphere(
          "Top",
          "chest",
          ellipsoid([side * (this.shoulderX - 0.01), 1.3, 0], [0.056, 0.052, 0.056]),
          {
            rings: 10,
            segments: 14,
          },
        ),
      );
    }
    if (top === "hoodie") {
      parts.push(
        shapedSphere("Top", "chest", ellipsoid([0, 1.39, -0.075], [0.13, 0.07, 0.07]), {
          rings: 10,
          segments: 18,
          keep: (n) => n[2] < 0.35,
        }),
      );
    }
    if (top === "sweater") {
      parts.push(torus("Top", "chest", [0, 1.355, 0], [0, 1, 0], 0.056, 0.014, [1, 0.95]));
    }
    if (isJacket(top)) parts.push(...this.jacketFront(top));
    if (top === "dress") parts.push(this.skirt("Top", 0.5));
    else if (this.r.outfit.bottom === "skirt") parts.push(this.skirt("Bottom", 0.6));
    return parts;
  }

  /**
   * What makes a jacket formal: the shirt showing in the jacket's V, buttons, and for a tuxedo
   * satin lapels and a bow tie. Thin shells laid just outside the chest.
   */
  private jacketFront(top: "tuxedo" | "suit"): Part[] {
    const w = this.wide;
    // The front of the torso (the chest and spine ellipsoids of `torso`) at (x, y).
    const surface = (x: number, y: number, cy: number, r: V3, box: number) => {
      const e = 2 / box;
      const rest = 1 - Math.abs(x / r[0]) ** e - Math.abs((y - cy) / r[1]) ** e;
      return rest > 0 ? r[2] * rest ** (1 / e) : 0;
    };
    const frontZ = (x: number, y: number) =>
      Math.max(
        surface(x, y, 1.2, [0.158 * w, 0.17, 0.104 * w], 0.8),
        surface(x, y, 1.04, [0.152 * w, 0.15, 0.1 * w], 0.85),
      );
    // The jacket's V: from the collar down to its point above the buttons.
    const [veeTop, veeBottom] = [1.35, 1.13];
    const veeY = (u: number) => lerp(veeTop, veeBottom, u);
    const veeHalf = (u: number) => lerp(0.06 * w, 0.003, u ** 0.9);
    const parts: Part[] = [
      patch("Shirt", "chest", 16, 6, (u, v) => {
        const y = veeY(u);
        const x = (2 * v - 1) * veeHalf(u);
        return [x, y, frontZ(x, y) + 0.004];
      }),
    ];
    // The bow tie sits on the collar.
    const collarZ = frontZ(0, 1.345) + 0.004;
    if (top === "tuxedo") {
      // Satin lapels along both sides of the V.
      for (const side of [1, -1]) {
        parts.push(
          patch("Lapel", "chest", 16, 3, (u, v) => {
            const y = veeY(u);
            const across = (side === 1 ? v : 1 - v) * lerp(0.032, 0.014, u) * w;
            const x = side * (veeHalf(u) + across);
            return [x, y, frontZ(x, y) + 0.0025];
          }),
        );
      }
      const bow = { rings: 8, segments: 12 };
      for (const side of [1, -1]) {
        parts.push(
          shapedSphere(
            "Tie",
            "chest",
            ellipsoid([side * 0.026, 1.345, collarZ + 0.012], [0.026, 0.017, 0.011]),
            bow,
          ),
        );
      }
      parts.push(
        shapedSphere(
          "Tie",
          "chest",
          ellipsoid([0, 1.345, collarZ + 0.016], [0.01, 0.01, 0.009]),
          bow,
        ),
        shapedSphere(
          "Tie",
          "spine",
          ellipsoid([0, 1.07, frontZ(0, 1.07) + 0.002], [0.009, 0.009, 0.006]),
          bow,
        ),
      );
    } else {
      for (const y of [1.1, 1.0]) {
        parts.push(
          shapedSphere(
            "Tie",
            "spine",
            ellipsoid([0, y, frontZ(0, y) + 0.002], [0.009, 0.009, 0.006]),
            {
              rings: 8,
              segments: 12,
            },
          ),
        );
      }
    }
    return parts;
  }

  /** An open, flared tube from the hips down to `hemY`. */
  private skirt(material: string, hemY: number): Part {
    const w = this.wide;
    const top = 0.93;
    const shape: Shaper = (n) => {
      const t = (1 - n[1]) / 2; // 0 at the waist → 1 at the hem
      const radius = lerp(0.15 * w, 0.255 * w, t ** 0.8);
      const len = Math.hypot(n[0], n[2]) || 1;
      return [(n[0] / len) * radius, lerp(top, hemY, t), (n[2] / len) * radius * 0.85];
    };
    return shapedSphere(material, "hips", shape, { rings: 10, segments: 28 });
  }

  private arm(side: 1 | -1): Part[] {
    const s = side === 1 ? "left" : "right";
    const x = (v: number) => v * side;
    const sx = this.shoulderX;
    const thick = Math.sqrt(this.wide);
    const { top } = this.r.outfit;
    const longSleeves = top === "hoodie" || top === "sweater" || isJacket(top);
    const y = 1.3;
    const parts: Part[] = [
      capsule(
        longSleeves ? "Top" : "Skin",
        `${s}UpperArm`,
        [x(sx), y, 0],
        [x(sx + 0.22), y, 0],
        0.05 * thick + (longSleeves ? 0.005 : 0),
        0.045 * thick + (longSleeves ? 0.005 : 0),
      ),
      capsule(
        longSleeves ? "Top" : "Skin",
        `${s}LowerArm`,
        [x(sx + 0.22), y, 0],
        [x(sx + 0.4), y, 0],
        0.044 * thick + (longSleeves ? 0.005 : 0),
        0.038 * thick + (longSleeves ? 0.006 : 0),
      ),
      shapedSphere(
        "Skin",
        `${s}Hand`,
        ellipsoid([x(sx + 0.455), y, 0.006], [0.056, 0.038, 0.048]),
        {
          rings: 10,
          segments: 14,
        },
      ),
    ];
    if (isJacket(top)) {
      // Shirt cuffs peeking out of the jacket sleeves.
      parts.push(
        torus("Shirt", `${s}LowerArm`, [x(sx + 0.398), y, 0], [1, 0, 0], 0.041 * thick, 0.007),
      );
    }
    if (!longSleeves) {
      parts.push(
        capsule(
          "Top",
          `${s}UpperArm`,
          [x(sx), y, 0],
          [x(sx + 0.11), y, 0],
          0.061 * thick,
          0.057 * thick,
        ),
      );
    }
    return parts;
  }

  private leg(side: 1 | -1): Part[] {
    const s = side === 1 ? "left" : "right";
    const lx = this.legX * side;
    const thick = Math.sqrt(this.wide);
    const { top, bottom } = this.r.outfit;
    const bare = top === "dress" || bottom === "skirt";
    const pants = !bare && bottom === "pants";
    const upper = pants ? "Bottom" : "Skin";
    const parts: Part[] = [
      capsule(upper, `${s}UpperLeg`, [lx, 0.86, 0], [lx, 0.47, 0], 0.062 * thick, 0.05 * thick),
      capsule(
        pants ? "Bottom" : "Skin",
        `${s}LowerLeg`,
        [lx, 0.47, 0],
        [lx, 0.11, 0],
        0.048 * thick,
        0.04 * thick,
      ),
      shapedSphere("Shoes", `${s}Foot`, ellipsoid([lx, 0.048, 0.035], [0.058, 0.05, 0.115], 0.6), {
        rings: 10,
        segments: 16,
      }),
    ];
    if (!bare && bottom === "shorts") {
      parts.push(
        capsule(
          "Bottom",
          `${s}UpperLeg`,
          [lx, 0.87, 0],
          [lx, 0.63, 0],
          0.07 * thick,
          0.062 * thick,
        ),
      );
    }
    return parts;
  }

  private glasses(): Part[] {
    const kind = this.r.glasses;
    if (kind === "none") return [];
    const { eyeX: ex, eyeY: ey, eyeW: ew } = this;
    const z = this.faceZ(ex, ey) + 0.028;
    const radius = ew * 1.45;
    const parts: Part[] = [];
    for (const side of [1, -1]) {
      const c: V3 = [side * ex, ey - 0.002, z];
      parts.push(
        kind === "round"
          ? torus("Frame", "head", c, [0, 0, 1], radius, 0.0045, [1, 1.08])
          : torus(
              "Frame",
              "head",
              c,
              [0, 0, 1],
              radius * 1.25,
              0.005,
              [1.05, 0.8],
              4,
              6,
              Math.PI / 4,
            ),
      );
      const outer = side * (ex + radius * (kind === "round" ? 1 : 1.05));
      parts.push(
        capsule(
          "Frame",
          "head",
          [outer, ey, z],
          [side * this.rx * 0.98, ey + 0.006, -0.03],
          0.0038,
          0.0038,
          6,
        ),
      );
    }
    parts.push(
      capsule(
        "Frame",
        "head",
        [ex - radius, ey + 0.004, z],
        [-(ex - radius), ey + 0.004, z],
        0.0038,
        0.0038,
        6,
      ),
    );
    return parts;
  }

  private hat(): Part[] {
    const kind = this.r.hat.style;
    if (kind === "none") return [];
    const style = this.r.hair.style;
    const size =
      style === "afro"
        ? 1.44
        : style === "bob" || style === "long"
          ? 1.16
          : style === "curly"
            ? 1.15
            : 1.12;
    const shell = this.headShell(size, style === "afro" ? 0.045 : 0, style === "afro" ? -0.02 : 0);
    const cut = kind === "beanie" ? 0.12 : 0.3;
    const parts: Part[] = [
      shapedSphere("Hat", "head", shell, { rings: 22, segments: 32, keep: (n) => n[1] > cut }),
    ];
    const ringY = shell([0, cut, Math.sqrt(1 - cut * cut)])[1];
    if (kind === "beanie") {
      const r = this.rx * size * Math.sqrt(1 - cut * cut);
      parts.push(
        torus("Hat", "head", [0, ringY, 0], [0, 1, 0], r, 0.02, [1, this.rz / this.rx], 32, 8),
      );
    } else {
      const front = shell([0, cut, Math.sqrt(1 - cut * cut)]);
      parts.push(
        shapedSphere("Hat", "head", ellipsoid([0, ringY, front[2] + 0.04], [0.12, 0.008, 0.1]), {
          rings: 8,
          segments: 20,
        }),
      );
    }
    return parts;
  }

  /** Applies the height slider to every part, including morph deltas. */
  private scaled(parts: Part[]): Part[] {
    const s = this.scale;
    for (const part of parts) {
      part.positions = part.positions.map((v) => v * s);
      for (const [name, d] of part.morphs)
        part.morphs.set(
          name,
          d.map((v) => v * s),
        );
    }
    return parts;
  }
}

/** Grows a feature about its center (surprised eyes). */
function grow(base: Shaper, center: V3, factor: number): Shaper {
  return (n) => {
    const p = base(n);
    return [center[0] + (p[0] - center[0]) * factor, center[1] + (p[1] - center[1]) * factor, p[2]];
  };
}

/** Evenly spread directions on the unit sphere. */
function fibonacciSphere(count: number): V3[] {
  const out: V3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    out.push([Math.sin(golden * i) * r, y, Math.cos(golden * i) * r]);
  }
  return out;
}
