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
    // Added in later phases: groupId (side conversations).
  },
  "Participant",
);
export type Participant = SchemaType<typeof Participant>;

/** Something on a game table (a jigsaw piece): see `TableItem` in @vcr/games-sdk. */
export const GameItem = schema(
  {
    x: t.float32(),
    z: t.float32(),
    flags: t.uint8().default(0),
    heldBy: t.string().default(""),
  },
  "GameItem",
);
export type GameItem = SchemaType<typeof GameItem>;

/** The game on one table (ADR 0021). Moving a piece patches that item's fields only. */
export const GameTable = schema(
  {
    /** TableGame id from @vcr/protocol */
    game: t.string(),
    /** The game's setup (its rules' encodeSetup); set once when the game starts. */
    setup: t.string(),
    revision: t.uint32().default(0),
    items: t.array(GameItem),
  },
  "GameTable",
);
export type GameTable = SchemaType<typeof GameTable>;

export const SessionState = schema(
  {
    participants: t.map(Participant),
    locked: t.boolean().default(false),
    /** Seat claims: seat id (as a string) → the sitter's realm session id (seats.ts). */
    seats: t.map("string"),
    /** Games by manifest table id. */
    games: t.map(GameTable),
    // Added in later phases: groups.
  },
  "SessionState",
);
export type SessionState = SchemaType<typeof SessionState>;
