/**
 * Binary codec for the high-rate avatar pose stream (LiveKit lossy data channel).
 * See PLAN.md § 3.4.
 *
 * Wire layout (little-endian):
 *   u8  wireVersion
 *   u8  flags            presence bitmask for the optional fields below
 *   u16 seq              wraps at 65536
 *   u32 t                sender clock, ms
 *   i16 x, y, z          centimeters, room-relative
 *   i16 yaw              radians mapped onto [-32767, 32767]
 *   u8  loco
 *   -- optional, in flag-bit order --
 *   [u16 seatId]                          FLAG_SEAT
 *   [4 × i16 head quaternion]             FLAG_HEAD
 *   [3 × i16 cm + 4 × i16 quat] left      FLAG_HAND_L
 *   [3 × i16 cm + 4 × i16 quat] right     FLAG_HAND_R
 *   [u8 n + n × u8 blendshape weights]    FLAG_FACE
 *
 * Forward compatibility: new optional fields must take the next unused flag bit and be appended
 * after every existing field. Older decoders then read the fields they know and ignore the
 * trailing bytes. Breaking layout changes bump POSE_WIRE_VERSION instead.
 */

export const POSE_WIRE_VERSION = 1;

export const LocoState = {
  idle: 0,
  walk: 1,
  run: 2,
  jump: 3,
  fall: 4,
  sitDown: 5,
  seated: 6,
  standUp: 7,
} as const;
export type LocoState = (typeof LocoState)[keyof typeof LocoState];

export const PoseFlag = {
  seat: 1 << 0,
  head: 1 << 1,
  handL: 1 << 2,
  handR: 1 << 3,
  face: 1 << 4,
} as const;

export type Vec3 = [number, number, number];
/** Unit quaternion as [x, y, z, w]. */
export type Quat = [number, number, number, number];

export interface HandPose {
  /** Meters, relative to the avatar root. */
  position: Vec3;
  rotation: Quat;
}

export interface AvatarPose {
  seq: number;
  t: number;
  /** Meters, room-relative. Encoded at 1 cm precision within ±327 m. */
  position: Vec3;
  /** Radians. */
  yaw: number;
  loco: LocoState;
  seatId?: number;
  /** Look direction now; VR headset orientation later. */
  head?: Quat;
  handL?: HandPose;
  handR?: HandPose;
  /** Facial blendshape weights, 0–255 each (ARKit order, 52 values when present). */
  face?: Uint8Array;
}

export class PoseDecodeError extends Error {
  override name = "PoseDecodeError";
}

const HEADER_BYTES = 1 + 1 + 2 + 4 + 6 + 2 + 1;
const QUAT_BYTES = 8;
const HAND_BYTES = 6 + QUAT_BYTES;
const I16_MAX = 32767;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const toCm = (meters: number) => clamp(Math.round(meters * 100), -I16_MAX, I16_MAX);

function wrapAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  let a = ((((rad + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
  if (a === -Math.PI) a = Math.PI;
  return a;
}

/** Normalizes and flips to w >= 0 (q and -q are the same rotation) so encoding is canonical. */
function canonicalQuat(q: Quat): Quat {
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const s = q[3] < 0 ? -1 / len : 1 / len;
  return [q[0] * s, q[1] * s, q[2] * s, q[3] * s];
}

export function encodedPoseSize(pose: AvatarPose): number {
  let size = HEADER_BYTES;
  if (pose.seatId !== undefined) size += 2;
  if (pose.head) size += QUAT_BYTES;
  if (pose.handL) size += HAND_BYTES;
  if (pose.handR) size += HAND_BYTES;
  if (pose.face) size += 1 + pose.face.length;
  return size;
}

export function encodePose(pose: AvatarPose): Uint8Array {
  if (pose.face && pose.face.length > 255) {
    throw new RangeError("face may hold at most 255 blendshape weights");
  }
  const bytes = new Uint8Array(encodedPoseSize(pose));
  const view = new DataView(bytes.buffer);
  let o = 0;

  let flags = 0;
  if (pose.seatId !== undefined) flags |= PoseFlag.seat;
  if (pose.head) flags |= PoseFlag.head;
  if (pose.handL) flags |= PoseFlag.handL;
  if (pose.handR) flags |= PoseFlag.handR;
  if (pose.face) flags |= PoseFlag.face;

  view.setUint8(o, POSE_WIRE_VERSION);
  o += 1;
  view.setUint8(o, flags);
  o += 1;
  view.setUint16(o, pose.seq & 0xffff, true);
  o += 2;
  view.setUint32(o, pose.t >>> 0, true);
  o += 4;
  for (const c of pose.position) {
    view.setInt16(o, toCm(c), true);
    o += 2;
  }
  view.setInt16(o, Math.round((wrapAngle(pose.yaw) / Math.PI) * I16_MAX), true);
  o += 2;
  view.setUint8(o, pose.loco);
  o += 1;

  const writeQuat = (q: Quat) => {
    for (const c of canonicalQuat(q)) {
      view.setInt16(o, Math.round(clamp(c, -1, 1) * I16_MAX), true);
      o += 2;
    }
  };
  const writeHand = (h: HandPose) => {
    for (const c of h.position) {
      view.setInt16(o, toCm(c), true);
      o += 2;
    }
    writeQuat(h.rotation);
  };

  if (pose.seatId !== undefined) {
    view.setUint16(o, pose.seatId, true);
    o += 2;
  }
  if (pose.head) writeQuat(pose.head);
  if (pose.handL) writeHand(pose.handL);
  if (pose.handR) writeHand(pose.handR);
  if (pose.face) {
    view.setUint8(o, pose.face.length);
    o += 1;
    bytes.set(pose.face, o);
    o += pose.face.length;
  }
  return bytes;
}

export function decodePose(bytes: Uint8Array): AvatarPose {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const need = (n: number) => {
    if (o + n > bytes.byteLength) throw new PoseDecodeError("pose packet is truncated");
  };

  need(HEADER_BYTES);
  const version = view.getUint8(o);
  o += 1;
  if (version !== POSE_WIRE_VERSION) {
    throw new PoseDecodeError(`unsupported pose wire version ${version}`);
  }
  const flags = view.getUint8(o);
  o += 1;
  const seq = view.getUint16(o, true);
  o += 2;
  const t = view.getUint32(o, true);
  o += 4;
  const position: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    position[i] = view.getInt16(o, true) / 100;
    o += 2;
  }
  const yaw = (view.getInt16(o, true) / I16_MAX) * Math.PI;
  o += 2;
  const loco = view.getUint8(o) as LocoState;
  o += 1;

  const readQuat = (): Quat => {
    need(QUAT_BYTES);
    const q: Quat = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      q[i] = view.getInt16(o, true) / I16_MAX;
      o += 2;
    }
    return canonicalQuat(q);
  };
  const readHand = (): HandPose => {
    need(HAND_BYTES);
    const p: Vec3 = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      p[i] = view.getInt16(o, true) / 100;
      o += 2;
    }
    return { position: p, rotation: readQuat() };
  };

  const pose: AvatarPose = { seq, t, position, yaw, loco };
  if (flags & PoseFlag.seat) {
    need(2);
    pose.seatId = view.getUint16(o, true);
    o += 2;
  }
  if (flags & PoseFlag.head) pose.head = readQuat();
  if (flags & PoseFlag.handL) pose.handL = readHand();
  if (flags & PoseFlag.handR) pose.handR = readHand();
  if (flags & PoseFlag.face) {
    need(1);
    const n = view.getUint8(o);
    o += 1;
    need(n);
    pose.face = bytes.slice(o, o + n);
    o += n;
  }
  // Any bytes left belong to fields added after this version of the codec; ignore them.
  return pose;
}

/** True if sequence number `a` is newer than `b`, accounting for uint16 wraparound. */
export function isNewerSeq(a: number, b: number): boolean {
  const diff = (a - b) & 0xffff;
  return diff !== 0 && diff < 0x8000;
}
