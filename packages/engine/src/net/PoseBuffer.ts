import { type AvatarPose, isNewerSeq, type LocoState, type Quat } from "@vcr/protocol";
import { lerp, lerpAngle, type Vec3 } from "../math";

export interface InterpolatedPose {
  position: Vec3;
  yaw: number;
  loco: LocoState;
  /** Horizontal speed, m/s, derived from the snapshots (drives walk/run animation). */
  speed: number;
  head?: Quat;
  seatId?: number;
  face?: Uint8Array;
  /** True when nothing has arrived for a while (the sender probably left or froze). */
  stale: boolean;
}

export interface PoseBufferOptions {
  /** How far behind real time remote avatars are shown, to absorb jitter. */
  delayMs: number;
  /** How long to keep moving along the last known velocity when packets stop. */
  maxExtrapolateMs: number;
  /** Jumps larger than this between snapshots are treated as teleports (no sliding). */
  snapDistance: number;
  staleAfterMs: number;
  capacity: number;
}

/** A packet this many sequence numbers behind the last one means the sender restarted. */
const RESTART_SEQ_GAP = 64;

const DEFAULTS: PoseBufferOptions = {
  delayMs: 100,
  maxExtrapolateMs: 250,
  snapDistance: 4,
  staleAfterMs: 5000,
  capacity: 32,
};

interface Snapshot {
  pose: AvatarPose;
  t: number;
}

/**
 * Snapshot interpolation for one remote avatar (PLAN.md § 4.3). Packets carry the sender's clock;
 * we estimate the offset to our clock and render ~100 ms in the past, interpolating between the
 * two surrounding snapshots, and briefly extrapolating if packets stop.
 */
export class RemotePoseBuffer {
  private snapshots: Snapshot[] = [];
  private clockOffset: number | null = null;
  private lastSeq: number | null = null;
  private lastReceivedAt = -Infinity;
  private readonly opts: PoseBufferOptions;

  constructor(options: Partial<PoseBufferOptions> = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  push(pose: AvatarPose, receivedAt: number) {
    if (this.lastSeq !== null && !isNewerSeq(pose.seq, this.lastSeq)) {
      // A duplicate (the same pose via LiveKit and the relay) or a late packet is a few behind. A
      // seq far behind means their sender started over (they switched views or reloaded): take it,
      // or we'd drop everything they send until the count caught up, minutes at 2 Hz.
      if (seqDistance(this.lastSeq, pose.seq) <= RESTART_SEQ_GAP) return;
      this.snapshots = [];
      this.clockOffset = null;
    }
    this.lastSeq = pose.seq;
    this.lastReceivedAt = receivedAt;

    // Offset = our clock − their clock + one-way delay. Follow drops immediately (a faster path
    // appeared) and rises slowly (so one delayed packet doesn't shift everyone's timeline).
    const offset = receivedAt - pose.t;
    if (this.clockOffset === null || offset < this.clockOffset) this.clockOffset = offset;
    else this.clockOffset += (offset - this.clockOffset) * 0.02;

    this.snapshots.push({ pose, t: pose.t });
    if (this.snapshots.length > this.opts.capacity) this.snapshots.shift();
  }

  get hasData() {
    return this.snapshots.length > 0;
  }

  sample(now: number): InterpolatedPose | null {
    const snaps = this.snapshots;
    if (snaps.length === 0 || this.clockOffset === null) return null;
    const stale = now - this.lastReceivedAt > this.opts.staleAfterMs;
    const renderT = now - this.clockOffset - this.opts.delayMs;

    const first = snaps[0]!;
    const last = snaps[snaps.length - 1]!;
    if (renderT <= first.t || snaps.length === 1) {
      return this.result(renderT <= first.t ? first.pose : last.pose, 0, stale);
    }

    if (renderT >= last.t) {
      const prev = snaps[snaps.length - 2]!;
      const span = last.t - prev.t;
      const velocity = this.velocity(prev.pose, last.pose, span);
      if (this.isTeleport(prev.pose, last.pose) || span <= 0)
        return this.result(last.pose, 0, stale);
      const ahead = Math.min(renderT - last.t, this.opts.maxExtrapolateMs) / 1000;
      const position: Vec3 = [
        last.pose.position[0] + velocity[0] * ahead,
        last.pose.position[1] + velocity[1] * ahead,
        last.pose.position[2] + velocity[2] * ahead,
      ];
      return { ...this.result(last.pose, Math.hypot(velocity[0], velocity[2]), stale), position };
    }

    // Find the pair surrounding renderT, dropping snapshots we've fully passed.
    let i = 0;
    while (snaps[i + 1]!.t < renderT) i++;
    if (i > 0) snaps.splice(0, i);
    const a = snaps[0]!;
    const b = snaps[1]!;
    const span = b.t - a.t;
    const speedVec = this.velocity(a.pose, b.pose, span);
    const speed = Math.hypot(speedVec[0], speedVec[2]);
    if (this.isTeleport(a.pose, b.pose) || span <= 0) return this.result(b.pose, 0, stale);

    const k = (renderT - a.t) / span;
    return {
      ...this.result(k < 0.5 ? a.pose : b.pose, speed, stale),
      position: [
        lerp(a.pose.position[0], b.pose.position[0], k),
        lerp(a.pose.position[1], b.pose.position[1], k),
        lerp(a.pose.position[2], b.pose.position[2], k),
      ],
      yaw: lerpAngle(a.pose.yaw, b.pose.yaw, k),
    };
  }

  private velocity(a: AvatarPose, b: AvatarPose, spanMs: number): Vec3 {
    if (spanMs <= 0) return [0, 0, 0];
    const s = 1000 / spanMs;
    return [
      (b.position[0] - a.position[0]) * s,
      (b.position[1] - a.position[1]) * s,
      (b.position[2] - a.position[2]) * s,
    ];
  }

  private isTeleport(a: AvatarPose, b: AvatarPose) {
    const d = Math.hypot(
      b.position[0] - a.position[0],
      b.position[1] - a.position[1],
      b.position[2] - a.position[2],
    );
    return d > this.opts.snapDistance;
  }

  private result(pose: AvatarPose, speed: number, stale: boolean): InterpolatedPose {
    const out: InterpolatedPose = {
      position: [...pose.position],
      yaw: pose.yaw,
      loco: pose.loco,
      speed,
      stale,
    };
    if (pose.head) out.head = pose.head;
    if (pose.seatId !== undefined) out.seatId = pose.seatId;
    if (pose.face) out.face = pose.face;
    return out;
  }
}

/** How far `b` is behind `a`, modulo 2^16. */
const seqDistance = (a: number, b: number) => (a - b + 0x10000) & 0xffff;
