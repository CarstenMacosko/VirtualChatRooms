import { z } from "zod";
import { AvatarRecipe } from "./avatar";
import { RoomSummary, SceneAssets } from "./rooms";

/** Rooms, live sessions ("gatherings"), invites and guest links (PLAN.md § 4.4). */

export const SessionStatus = z.enum(["live", "ended"]);
export const InviteStatus = z.enum(["ringing", "accepted", "declined", "missed"]);
export type InviteStatus = z.infer<typeof InviteStatus>;

export const SessionInfo = z.object({
  id: z.string(),
  status: SessionStatus,
  room: RoomSummary,
  host: z.object({ id: z.string(), displayName: z.string() }),
  invites: z.array(z.object({ userId: z.string(), displayName: z.string(), status: InviteStatus })),
  createdAt: z.string(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const StartSessionRequest = z.object({
  roomId: z.string(),
  inviteUserIds: z.array(z.string()).default([]),
  inviteGroupIds: z.array(z.string()).default([]),
  /** Ring every accepted contact. */
  inviteAll: z.boolean().default(false),
});
export type StartSessionRequest = z.input<typeof StartSessionRequest>;

export const InviteMoreRequest = z.object({ userIds: z.array(z.string()).min(1) });
export type InviteMoreRequest = z.infer<typeof InviteMoreRequest>;

/** Role the API assigns when someone joins; co-hosts are promoted later, inside the session. */
export const JoinRole = z.enum(["owner", "member", "guest"]);
export type JoinRole = z.infer<typeof JoinRole>;

export const JoinSessionResponse = z.object({
  sessionId: z.string(),
  role: JoinRole,
  room: RoomSummary,
  /** A scanned room's manifest and signed asset URLs; null for the built-in sample room. */
  scene: SceneAssets.nullable().default(null),
  /** Short-lived ticket the realm server accepts for this one session. */
  realmTicket: z.string(),
});
export type JoinSessionResponse = z.infer<typeof JoinSessionResponse>;

export const GuestLinkResponse = z.object({
  token: z.string(),
  /** Path to share, e.g. /join/<token>; the web app prefixes its origin. */
  path: z.string(),
  expiresAt: z.string(),
});
export type GuestLinkResponse = z.infer<typeof GuestLinkResponse>;

export const GuestLinkInfo = z.object({
  hostName: z.string(),
  roomName: z.string(),
  live: z.boolean(),
});
export type GuestLinkInfo = z.infer<typeof GuestLinkInfo>;

export const GuestJoinRequest = z.object({
  displayName: z.string().trim().min(1).max(40),
  /** Guests keep their avatar on their own device and bring it along; nothing is stored. */
  avatar: AvatarRecipe.optional(),
});
export type GuestJoinRequest = z.infer<typeof GuestJoinRequest>;

/** Claims in a realm ticket (JWT, audience "realm"). */
export const RealmTicketClaims = z.object({
  sub: z.string(),
  name: z.string(),
  kind: z.enum(["user", "guest"]),
  sessionId: z.string(),
  role: JoinRole,
  /** Their avatar, so the realm can show it to everyone without asking the API. */
  avatar: AvatarRecipe.nullable().default(null),
});
export type RealmTicketClaims = z.input<typeof RealmTicketClaims>;

/** How long an unanswered ring lasts before it counts as missed. */
export const RING_TIMEOUT_MS = 45_000;

/** JWT audiences: realm tickets (API → realm) and internal calls (realm → API). */
export const REALM_TICKET_AUDIENCE = "vcr-realm";
export const INTERNAL_AUDIENCE = "vcr-api-internal";
export const REALM_ISSUER = "vcr-realm";

/** `GET /sessions`: live gatherings you host or were invited to, newest first. */
export const SessionsResponse = z.object({ sessions: z.array(SessionInfo) });
export type SessionsResponse = z.infer<typeof SessionsResponse>;

/** `GET /dev/share`: the public link `pnpm share` is serving right now, if any. */
export const ShareInfo = z.object({ url: z.string().nullable() });
export type ShareInfo = z.infer<typeof ShareInfo>;
