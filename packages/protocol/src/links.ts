import { z } from "zod";

/**
 * Links that bring other devices and people in without a sign-in provider (until Clerk keys are
 * set, and as conveniences after):
 *
 * - **device**: sign this account in on another device (your phone). Single use, 10 minutes.
 * - **invite**: a friend opens it, makes an account (or uses theirs) and you become contacts.
 * - **call**: your personal "call me" link. Anyone can open it, type a name and ring you; if you
 *   answer they join as a guest.
 */
export const LinkKind = z.enum(["device", "invite", "call"]);
export type LinkKind = z.infer<typeof LinkKind>;

export const DEVICE_LINK_TTL_MS = 10 * 60_000;
export const INVITE_LINK_TTL_MS = 7 * 24 * 60 * 60_000;

export const LinkResponse = z.object({
  kind: LinkKind,
  token: z.string(),
  /** Path to share, e.g. /call/<token>; the web app prefixes the public origin. */
  path: z.string(),
  /** Null for links that last until reset (call links). */
  expiresAt: z.string().nullable(),
});
export type LinkResponse = z.infer<typeof LinkResponse>;

/** `GET /links/:token`: what a link is, for the page that opens it. */
export const LinkInfo = z.object({
  kind: LinkKind,
  ownerName: z.string(),
  /** Call links: whether the owner has the app open right now. */
  ownerOnline: z.boolean(),
  /** Invite links: whether new accounts can be made here (no sign-in provider configured). */
  canCreateAccount: z.boolean(),
});
export type LinkInfo = z.infer<typeof LinkInfo>;

/** `POST /links/:token/accept` (invite): a new account, unless you're already signed in. */
export const AcceptInviteRequest = z.object({
  displayName: z.string().trim().min(1).max(40).optional(),
  birthDate: z.iso.date().optional(),
});
export type AcceptInviteRequest = z.infer<typeof AcceptInviteRequest>;

// --- Calls through a call link ---

export const CallStatus = z.enum(["ringing", "accepted", "declined", "missed", "cancelled"]);
export type CallStatus = z.infer<typeof CallStatus>;

export const StartCallRequest = z.object({ displayName: z.string().trim().min(1).max(40) });
export type StartCallRequest = z.infer<typeof StartCallRequest>;

/** The caller's handle on their call: `secret` proves it's them when polling or hanging up. */
export const StartCallResponse = z.object({ callId: z.string(), secret: z.string() });
export type StartCallResponse = z.infer<typeof StartCallResponse>;

export const CallState = z.object({
  status: CallStatus,
  /** Once answered: the guest link token to join the gathering with. */
  guestToken: z.string().nullable(),
});
export type CallState = z.infer<typeof CallState>;

/** `POST /calls/:id/answer`: the gathering the caller is joining (yours, new or ongoing). */
export const AnswerCallResponse = z.object({ sessionId: z.string() });
export type AnswerCallResponse = z.infer<typeof AnswerCallResponse>;

/** How long a call through a call link rings before it counts as missed. */
export const CALL_RING_MS = 45_000;
