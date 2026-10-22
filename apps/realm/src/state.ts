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
    // Added in later phases: groupId (side conversations), seatId (sitting).
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
