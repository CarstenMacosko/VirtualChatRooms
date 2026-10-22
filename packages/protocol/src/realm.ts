import { z } from "zod";
import { SessionId } from "./api";

/** Contracts between clients and the Colyseus realm server (PLAN.md § 3.4). */

export const REALM_ROOM_NAME = "session";

export const ParticipantRole = z.enum(["owner", "cohost", "member", "guest"]);
export type ParticipantRole = z.infer<typeof ParticipantRole>;

export const RealmJoinOptions = z.object({
  /** Realm ticket from `POST /sessions/:id/join` or `POST /guest/:token/join` (sessions.ts). */
  ticket: z.string().min(1),
  sessionId: SessionId,
});
export type RealmJoinOptions = z.infer<typeof RealmJoinOptions>;

/** Plain-object view of a participant, as the client reads it from synced state. */
export interface ParticipantView {
  /** Realm session id of this connection. */
  id: string;
  /** Stable account id; the same person keeps it across reconnects. */
  userId: string;
  name: string;
  role: ParticipantRole;
  muted: boolean;
  cameraOn: boolean;
  /** Connected to LiveKit. Anyone who isn't still needs poses through the realm relay. */
  onMedia: boolean;
}

export const EmoteId = z.enum(["wave", "laugh", "heart", "thumbsUp", "dance"]);
export type EmoteId = z.infer<typeof EmoteId>;

export const RealmMessage = {
  emote: "emote",
  /**
   * Binary avatar pose (see pose.ts). Client → server: raw pose; server → clients: relayed pose.
   * Only used while LiveKit's data channel is unavailable (ADR 0006).
   */
  pose: "pose",
  /** Client → server: what the client is actually publishing. */
  mediaState: "mediaState",
  /** Server → client, right after joining: where and how to connect to LiveKit. */
  media: "media",
  /** Server → client: something happened to you, e.g. a host muted you. */
  notice: "notice",
  // Host controls (owner and co-hosts; see canModerate).
  hostMute: "hostMute",
  hostCameraOff: "hostCameraOff",
  hostRemove: "hostRemove",
  setLocked: "setLocked",
  /** Owner only. */
  setCoHost: "setCoHost",
  /** Owner only: end the gathering for everyone. */
  endSession: "endSession",
} as const;

const Target = z.object({ target: z.string() });

export const ClientMessages = {
  [RealmMessage.emote]: z.object({ emote: EmoteId }),
  [RealmMessage.mediaState]: z.object({
    micOn: z.boolean(),
    cameraOn: z.boolean(),
    connected: z.boolean(),
  }),
  [RealmMessage.hostMute]: Target,
  [RealmMessage.hostCameraOff]: Target,
  [RealmMessage.hostRemove]: Target,
  [RealmMessage.setLocked]: z.object({ locked: z.boolean() }),
  [RealmMessage.setCoHost]: Target.extend({ cohost: z.boolean() }),
  [RealmMessage.endSession]: z.object({}),
} as const;

export const NoticeKind = z.enum(["mutedByHost", "cameraOffByHost", "promoted", "demoted"]);
export type NoticeKind = z.infer<typeof NoticeKind>;

export const ServerMessages = {
  [RealmMessage.emote]: z.object({ from: z.string(), emote: EmoteId }),
  /** `url` is null when the realm has no LiveKit configured; voice and video are then off. */
  [RealmMessage.media]: z.object({ url: z.string().nullable(), token: z.string().nullable() }),
  [RealmMessage.notice]: z.object({ kind: NoticeKind, by: z.string() }),
} as const;
export type EmoteBroadcast = z.infer<(typeof ServerMessages)["emote"]>;
export type MediaGrant = z.infer<(typeof ServerMessages)["media"]>;
export type Notice = z.infer<(typeof ServerMessages)["notice"]>;

/**
 * WebSocket close codes the realm uses when it, not the network, ends your connection. Colyseus
 * reserves 4000–4010 for its own (e.g. 4002 is "closed with error"), so these sit well above.
 */
export const RealmCloseCode = {
  removed: 4401,
  sessionEnded: 4410,
} as const;

/** Error codes the realm rejects a join with (HTTP-style, as Colyseus matchmaking errors). */
export const RealmJoinError = {
  invalid: 400,
  badTicket: 401,
  removed: 403,
  ended: 410,
  locked: 423,
} as const;

/** How long a session survives with no owner or co-host present (PLAN.md § 4.4). */
export const HOST_GRACE_MS = 2 * 60_000;
/** How long a session waits for its owner to arrive the first time. */
export const HOST_ARRIVAL_MS = 5 * 60_000;

/** Whether `actor` may mute, turn off the camera of, or remove `target`. */
export function canModerate(actor: ParticipantRole, target: ParticipantRole): boolean {
  if (actor === "owner") return target !== "owner";
  if (actor === "cohost") return target === "member" || target === "guest";
  return false;
}
