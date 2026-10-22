import { type AvatarPose, encodePose, LocoState } from "@vcr/protocol";

export interface PoseSenderOptions {
  movingHz: number;
  idleHz: number;
}

type OutgoingPose = Omit<AvatarPose, "seq" | "t">;

const FRAME_SLACK_MS = 8;

/**
 * Decides when to send the local avatar's pose: 15 Hz while moving, 2 Hz while idle (so late
 * joiners still see everyone), and immediately when the locomotion state changes.
 */
export class PoseSender {
  private seq = 0;
  private lastSentAt = -Infinity;
  private last: OutgoingPose | null = null;
  private readonly opts: PoseSenderOptions;

  constructor(
    private readonly send: (bytes: Uint8Array) => void,
    options: Partial<PoseSenderOptions> = {},
  ) {
    this.opts = { movingHz: 15, idleHz: 2, ...options };
  }

  /** Returns true if a packet was sent. `now` is a monotonic clock in ms. */
  update(now: number, pose: OutgoingPose): boolean {
    const moving = pose.loco !== LocoState.idle || this.changed(pose);
    const interval = 1000 / (moving ? this.opts.movingHz : this.opts.idleHz);
    const locoChanged = this.last !== null && this.last.loco !== pose.loco;
    // Half a frame of slack so 60 fps updates hit 15 Hz instead of rounding down to 12.
    if (!locoChanged && now - this.lastSentAt < interval - FRAME_SLACK_MS) return false;

    this.send(encodePose({ ...pose, seq: this.seq, t: Math.round(now) >>> 0 }));
    this.seq = (this.seq + 1) & 0xffff;
    this.lastSentAt = now;
    this.last = pose;
    return true;
  }

  private changed(pose: OutgoingPose) {
    if (!this.last) return true;
    const p = pose.position;
    const q = this.last.position;
    return (
      Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) > 0.005 ||
      Math.abs(pose.yaw - this.last.yaw) > 0.01
    );
  }
}
