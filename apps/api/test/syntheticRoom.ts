import { buildSampleRoomSplats } from "@vcr/engine";
import type { SplatRecord } from "../src/capture/splatFile";
import { qmul, qrotate } from "../src/capture/analyze";

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

/** How a synthetic scan's file coordinates relate to the sample room: file = t + s · R(world). */
export interface FileFrame {
  rotation?: Quat;
  scale?: number;
  translation?: Vec3;
}

export const quatAxisAngle = (axis: Vec3, angle: number): Quat => {
  const s = Math.sin(angle / 2) / Math.hypot(...axis);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
};

export function toFile(p: Vec3, frame: FileFrame): Vec3 {
  const r = qrotate(frame.rotation ?? [0, 0, 0, 1], p);
  const s = frame.scale ?? 1;
  const t = frame.translation ?? [0, 0, 0];
  return [t[0] + s * r[0], t[1] + s * r[1], t[2] + s * r[2]];
}

/**
 * The procedural sample living room (8 × 6 m, 2.7 m ceiling, sofa, table, shelf, a raised nook)
 * as a scan file would store it: in some other frame and scale, optionally without a ceiling
 * (phone scans often miss it) and with floaters.
 */
export function syntheticRoomSplats(
  opts: { spacing?: number; frame?: FileFrame; ceiling?: boolean; floaters?: number } = {},
): SplatRecord[] {
  const frame = opts.frame ?? {};
  const rotation = frame.rotation ?? [0, 0, 0, 1];
  const scale = frame.scale ?? 1;
  const splats: SplatRecord[] = [];
  buildSampleRoomSplats(opts.spacing ?? 0.05, (center, size, quat, opacity, color) => {
    if (opts.ceiling === false && center[1] > 2.6) return;
    splats.push({
      position: toFile(center, frame),
      scale: size.map((v) => v * scale) as Vec3,
      rotation: qmul(rotation, quat),
      opacity,
      color: color.map((c) => Math.min(1, Math.max(0, c))) as Vec3,
    });
  });
  // Floaters: faint and solid specks scattered through the air, as real scans have.
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < (opts.floaters ?? 0); i++) {
    const p: Vec3 = [(rand() - 0.5) * 10, rand() * 3, (rand() - 0.5) * 8];
    splats.push({
      position: toFile(p, frame),
      scale: [0.02 * scale, 0.02 * scale, 0.02 * scale],
      rotation: [0, 0, 0, 1],
      opacity: rand() < 0.8 ? 0.05 : 0.9,
      color: [0.5, 0.5, 0.5],
    });
  }
  return splats;
}
