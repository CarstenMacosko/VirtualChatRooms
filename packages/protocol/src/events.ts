import { z } from "zod";
import { InviteStatus } from "./sessions";

/**
 * Live events the API pushes to signed-in users over `GET /events` (server-sent events): incoming
 * calls, answers to your calls, and contact changes. Web Push covers the case where the app is
 * closed.
 */
export const LiveEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ring"),
    sessionId: z.string(),
    from: z.object({ id: z.string(), displayName: z.string() }),
    roomName: z.string(),
  }),
  z.object({ type: z.literal("ring-cancelled"), sessionId: z.string() }),
  z.object({
    type: z.literal("invite-response"),
    sessionId: z.string(),
    userId: z.string(),
    displayName: z.string(),
    status: InviteStatus,
  }),
  z.object({ type: z.literal("contacts-changed") }),
  z.object({ type: z.literal("session-ended"), sessionId: z.string() }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;

export const PushSubscriptionRequest = z.object({
  endpoint: z.url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
export type PushSubscriptionRequest = z.infer<typeof PushSubscriptionRequest>;

export const VapidKeyResponse = z.object({ publicKey: z.string().nullable() });
