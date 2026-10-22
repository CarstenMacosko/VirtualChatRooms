/**
 * Envelope for poses relayed through the realm server: the server prefixes each pose with the
 * sender's realm session id so receivers know whose avatar it moves.
 *
 *   u8  idLength
 *   ..  sender session id (UTF-8)
 *   ..  pose bytes (pose.ts wire format)
 *
 * Phase 1 relays poses through the realm server. Phase 2 moves them onto LiveKit's lossy data
 * channel (ADR 0006), where the sender identity comes from LiveKit and this envelope goes away.
 */

/** Largest pose packet the server will relay (the full pose with every optional field is 113 bytes). */
export const MAX_POSE_BYTES = 256;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeRelayedPose(from: string, pose: Uint8Array): Uint8Array {
  const id = encoder.encode(from);
  if (id.byteLength > 255) throw new RangeError("sender id too long");
  const out = new Uint8Array(1 + id.byteLength + pose.byteLength);
  out[0] = id.byteLength;
  out.set(id, 1);
  out.set(pose, 1 + id.byteLength);
  return out;
}

export function decodeRelayedPose(bytes: Uint8Array): { from: string; pose: Uint8Array } {
  const idLength = bytes[0];
  if (idLength === undefined || bytes.byteLength < 1 + idLength) {
    throw new RangeError("relayed pose is truncated");
  }
  return {
    from: decoder.decode(bytes.subarray(1, 1 + idLength)),
    pose: bytes.subarray(1 + idLength),
  };
}
