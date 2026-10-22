import { pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/** Phase 0 tables (PLAN.md § 3.2). Later phases add avatars, rooms, sessions and invites. */

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    /** "dev" in Phase 0; the managed auth provider's name later. */
    authProvider: text("auth_provider").notNull(),
    authProviderId: text("auth_provider_id").notNull(),
    avatarId: text("avatar_id"),
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
