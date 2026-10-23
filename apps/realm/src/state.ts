import { schema, t, type SchemaType } from "@colyseus/schema";

/** Authoritative session state, delta-synced to every client (PLAN.md § 3.4). */

export const Participant = schema(
  {
    userId: t.string(),
    name: t.string(),
    /** ParticipantRole from @vcr/protocol */
    role: t.string(),
    muted: t.boolean().default(false),
    cameraOn: t.boolean().default(false),
    /** Connected to LiveKit; see ParticipantView.onMedia. */
    onMedia: t.boolean().default(false),
    /** AvatarRecipe JSON; "" until they make one. */
    avatar: t.string().default(""),
    handRaised: t.boolean().default(false),
    /** Realm session id of someone whose group they're listening in on; "" for none. */
    listeningTo: t.string().default(""),
    // Added in later phases: seatId (sitting).
  },
  "Participant",
);
export type Participant = SchemaType<typeof Participant>;

export const SessionState = schema(
  {
    participants: t.map(Participant),
    locked: t.boolean().default(false),
    // Added in later phases: groups, seats, games.
  },
  "SessionState",
);
export type SessionState = SchemaType<typeof SessionState>;
