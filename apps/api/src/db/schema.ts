import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/** PLAN.md § 3.2. Phase 3 adds avatars and room scans. */

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    /** "dev" in Phase 0; the managed auth provider's name later. */
    authProvider: text("auth_provider").notNull(),
    authProviderId: text("auth_provider_id").notNull(),
    avatarId: text("avatar_id"),
    /** What other people type to add you as a contact. Assigned on first sign-in. */
    friendCode: text("friend_code").unique(),
    /** When the user confirmed they are 13+. The birth date itself is never stored. */
    ageConfirmed13PlusAt: timestamp("age_confirmed_13_plus_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_auth_identity").on(t.authProvider, t.authProviderId)],
);

export const contactStatus = pgEnum("contact_status", ["pending", "accepted", "blocked"]);

export const contacts = pgTable(
  "contacts",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    contactUserId: text("contact_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The owner's name for this contact, e.g. "Mom". */
    label: text("label"),
    status: contactStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.contactUserId] })],
);

/**
 * A contact group, e.g. "Family". Owned by one user; members are that user's accepted contacts.
 */
export const contactGroups = pgTable("contact_groups", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const contactGroupMembers = pgTable(
  "contact_group_members",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => contactGroups.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

export const roomKind = pgEnum("room_kind", ["sample", "scan"]);
export const roomStatus = pgEnum("room_status", ["uploading", "processing", "ready", "failed"]);

/** A space someone owns. Sample rooms ship with the app; scans are imported (Phase 4). */
export const rooms = pgTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: roomKind("kind").notNull(),
    status: roomStatus("status").notNull().default("ready"),
    /** 0–1 while processing. */
    progress: real("progress"),
    /** Why processing failed, as a sentence for the owner. */
    error: text("error"),
    /** Object-storage key of the room manifest; null for sample rooms and unprocessed scans. */
    manifestKey: text("manifest_key"),
    /** What post-processing found (`ScanDetails` in @vcr/protocol). */
    scan: jsonb("scan"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rooms_owner").on(t.ownerId)],
);

export const captureSource = pgEnum("capture_source", ["video", "splat_upload"]);
export const captureProvider = pgEnum("capture_provider", ["kiri", "byo"]);
export const captureStatus = pgEnum("capture_status", [
  "uploading",
  "queued",
  "reconstructing",
  "postprocessing",
  "ready",
  "failed",
]);

/** One run of the capture pipeline for a room (PLAN.md § 3.2, § 4.1). */
export const captureJobs = pgTable(
  "capture_jobs",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    source: captureSource("source").notNull(),
    provider: captureProvider("provider").notNull(),
    providerTaskId: text("provider_task_id"),
    /** The uploaded file (video or splat). */
    sourceKey: text("source_key").notNull(),
    /** Multipart upload id while the file is uploading. */
    uploadId: text("upload_id"),
    /** Expected upload size in bytes. */
    sourceBytes: real("source_bytes"),
    status: captureStatus("status").notNull(),
    progress: real("progress"),
    error: text("error"),
    /** Post-processing overrides from the owner (`up`, `heightMeters`). */
    options: jsonb("options"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("capture_jobs_room").on(t.roomId), index("capture_jobs_status").on(t.status)],
);

export const sessionStatus = pgEnum("session_status", ["live", "ended"]);

/** One live gathering in a room. Only the room's owner can start one (PLAN.md § 4.4). */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: sessionStatus("status").notNull().default("live"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("sessions_host_status").on(t.hostId, t.status)],
);

export const inviteStatus = pgEnum("invite_status", ["ringing", "accepted", "declined", "missed"]);

export const sessionInvites = pgTable(
  "session_invites",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    inviteeId: text("invitee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: inviteStatus("status").notNull().default("ringing"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.sessionId, t.inviteeId] }),
    index("session_invites_invitee").on(t.inviteeId),
  ],
);

/**
 * A link that lets someone without an account (e.g. a child on a parent's device) join one live
 * session as a guest. Guests themselves are never stored.
 */
export const guestLinks = pgTable("guest_links", {
  token: text("token").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Browsers that asked to be told about calls while the app is closed (Web Push). */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    endpoint: text("endpoint").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("push_subscriptions_user").on(t.userId)],
);

/**
 * A person's avatar, stored as the creator's recipe (`AvatarRecipe` in @vcr/protocol). Clients
 * build the VRM from it; a baked VRM in object storage (`vrmKey`) arrives with Phase 4 storage.
 */
export const avatars = pgTable(
  "avatars",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    recipe: jsonb("recipe").notNull(),
    vrmKey: text("vrm_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // One avatar per person for now; the id leaves room for an outfit wardrobe later.
  (t) => [uniqueIndex("avatars_owner").on(t.ownerId)],
);

export const linkKind = pgEnum("link_kind", ["device", "invite", "call"]);

/**
 * Device sign-in, invite and "call me" links (`LinkKind` in @vcr/protocol). Tokens are the
 * secret: whoever has the link can use it, so device links are single-use and short-lived.
 */
export const links = pgTable(
  "links",
  {
    token: text("token").primaryKey(),
    kind: linkKind("kind").notNull(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("links_owner_kind").on(t.ownerId, t.kind)],
);

export const callStatus = pgEnum("call_status", [
  "ringing",
  "accepted",
  "declined",
  "missed",
  "cancelled",
]);

/** Someone calling through a call link. Nothing about the caller is kept beyond their name. */
export const calls = pgTable(
  "calls",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    linkToken: text("link_token")
      .notNull()
      .references(() => links.token, { onDelete: "cascade" }),
    callerName: text("caller_name").notNull(),
    /** Proves the caller is the one polling or hanging up. */
    secret: text("secret").notNull(),
    status: callStatus("status").notNull().default("ringing"),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    guestToken: text("guest_token"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("calls_owner_status").on(t.ownerId, t.status)],
);
