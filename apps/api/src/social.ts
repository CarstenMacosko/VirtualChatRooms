import { randomInt } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { FRIEND_CODE_ALPHABET, type ContactsResponse } from "@vcr/protocol";
import type { Database } from "./db/client";
import { contactGroupMembers, contactGroups, contacts, users } from "./db/schema";
import type { LiveHub } from "./live";

/**
 * Contacts are directed rows: an accepted friendship is two accepted rows (one each way), a
 * request is a single pending row from the requester.
 */

export function generateFriendCode() {
  let code = "";
  for (let i = 0; i < 8; i++) code += FRIEND_CODE_ALPHABET[randomInt(FRIEND_CODE_ALPHABET.length)];
  return code;
}

/** Returns the user's friend code, assigning one on first use. */
export async function ensureFriendCode(db: Database, userId: string): Promise<string> {
  const [row] = await db
    .select({ friendCode: users.friendCode })
    .from(users)
    .where(eq(users.id, userId));
  if (row?.friendCode) return row.friendCode;
  // 31^8 ≈ 8.5e11 codes, so a collision is rare; retry a few times just in case.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateFriendCode();
    try {
      await db.update(users).set({ friendCode: code }).where(eq(users.id, userId));
      return code;
    } catch {
      // unique violation: try another code
    }
  }
  throw new Error("could not assign a friend code");
}

/** Ids of everyone `userId` has an accepted friendship with. */
export async function acceptedContactIds(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: contacts.contactUserId })
    .from(contacts)
    .where(and(eq(contacts.userId, userId), eq(contacts.status, "accepted")));
  return rows.map((r) => r.id);
}

export async function loadContacts(
  db: Database,
  live: LiveHub,
  userId: string,
): Promise<ContactsResponse> {
  const accepted = await db
    .select({
      userId: contacts.contactUserId,
      label: contacts.label,
      displayName: users.displayName,
    })
    .from(contacts)
    .innerJoin(users, eq(users.id, contacts.contactUserId))
    .where(and(eq(contacts.userId, userId), eq(contacts.status, "accepted")));

  const incoming = await db
    .select({ userId: contacts.userId, displayName: users.displayName })
    .from(contacts)
    .innerJoin(users, eq(users.id, contacts.userId))
    .where(and(eq(contacts.contactUserId, userId), eq(contacts.status, "pending")));

  const outgoing = await db
    .select({ userId: contacts.contactUserId, displayName: users.displayName })
    .from(contacts)
    .innerJoin(users, eq(users.id, contacts.contactUserId))
    .where(and(eq(contacts.userId, userId), eq(contacts.status, "pending")));

  const groupRows = await db
    .select()
    .from(contactGroups)
    .where(eq(contactGroups.ownerId, userId))
    .orderBy(contactGroups.createdAt);
  const memberRows = groupRows.length
    ? await db
        .select()
        .from(contactGroupMembers)
        .where(
          inArray(
            contactGroupMembers.groupId,
            groupRows.map((g) => g.id),
          ),
        )
    : [];

  const byName = (a: { displayName: string }, b: { displayName: string }) =>
    a.displayName.localeCompare(b.displayName);
  return {
    contacts: accepted
      .map((c) => ({ ...c, online: live.isOnline(c.userId) }))
      .sort((a, b) => Number(b.online) - Number(a.online) || byName(a, b)),
    incoming: incoming.sort(byName),
    outgoing: outgoing.sort(byName),
    groups: groupRows.map((g) => ({
      id: g.id,
      name: g.name,
      memberIds: memberRows.filter((m) => m.groupId === g.id).map((m) => m.userId),
    })),
  };
}

/** Removes the friendship (or request) in both directions, and each other from groups. */
export async function removeContact(db: Database, userId: string, otherId: string) {
  await db.transaction(async (tx) => {
    for (const [a, b] of [
      [userId, otherId],
      [otherId, userId],
    ] as const) {
      await tx.delete(contacts).where(and(eq(contacts.userId, a), eq(contacts.contactUserId, b)));
      const groups = await tx
        .select({ id: contactGroups.id })
        .from(contactGroups)
        .where(eq(contactGroups.ownerId, a));
      if (groups.length) {
        await tx.delete(contactGroupMembers).where(
          and(
            inArray(
              contactGroupMembers.groupId,
              groups.map((g) => g.id),
            ),
            eq(contactGroupMembers.userId, b),
          ),
        );
      }
    }
  });
}
