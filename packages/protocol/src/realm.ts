import { z } from "zod";
import { SessionId } from "./api";

/** Contracts between clients and the Colyseus realm server (PLAN.md § 3.4). */

export const REALM_ROOM_NAME = "session";

export const ParticipantRole = z.enum(["owner", "cohost", "member", "guest"]);
export type ParticipantRole = z.infer<typeof ParticipantRole>;

export const RealmJoinOptions = z.object({
  token: z.string().min(1),
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
}

export const EmoteId = z.enum(["wave", "laugh", "heart", "thumbsUp", "dance"]);
export type EmoteId = z.infer<typeof EmoteId>;

export const RealmMessage = {
  emote: "emote",
  /** Binary avatar pose (see pose.ts). Client → server: raw pose; server → clients: relayed pose. */
  pose: "pose",
} as const;

export const ClientMessages = {
  [RealmMessage.emote]: z.object({ emote: EmoteId }),
} as const;

export const ServerMessages = {
  [RealmMessage.emote]: z.object({ from: z.string(), emote: EmoteId }),
} as const;
export type EmoteBroadcast = z.infer<(typeof ServerMessages)["emote"]>;
