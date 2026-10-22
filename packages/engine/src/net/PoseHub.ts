import { decodePose, decodeRelayedPose } from "@vcr/protocol";
import { type InterpolatedPose, RemotePoseBuffer } from "./PoseBuffer";

/**
 * Routes relayed pose packets to one interpolation buffer per remote participant, and sends the
 * local pose through whatever transport is currently connected (realm relay now, LiveKit later).
 */
export class PoseHub {
  private buffers = new Map<string, RemotePoseBuffer>();
  private sender: ((bytes: Uint8Array) => void) | null = null;
  /** Packets that failed to decode, e.g. from a client on a newer wire version. */
  dropped = 0;

  setSender(sender: ((bytes: Uint8Array) => void) | null) {
    this.sender = sender;
  }

  send(bytes: Uint8Array) {
    this.sender?.(bytes);
  }

  ingest(relayed: Uint8Array, now: number) {
    try {
      const { from, pose } = decodeRelayedPose(relayed);
      let buffer = this.buffers.get(from);
      if (!buffer) {
        buffer = new RemotePoseBuffer();
        this.buffers.set(from, buffer);
      }
      buffer.push(decodePose(pose), now);
    } catch {
      this.dropped++;
    }
  }

  sample(id: string, now: number): InterpolatedPose | null {
    return this.buffers.get(id)?.sample(now) ?? null;
  }

  /** Forget everyone not in `ids` (they left the session). */
  retain(ids: ReadonlySet<string>) {
    for (const id of this.buffers.keys()) if (!ids.has(id)) this.buffers.delete(id);
  }

  clear() {
    this.buffers.clear();
  }
}
