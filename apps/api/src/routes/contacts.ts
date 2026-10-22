import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { AddContactRequest, SaveGroupRequest, UpdateContactRequest } from "@vcr/protocol";
import type { Services } from "../app";
import { requireSession } from "../auth";
import { contactGroupMembers, contactGroups, contacts, users } from "../db/schema";
import { type IdParams, parseBody, sendError } from "../http";
import { acceptedContactIds, loadContacts, removeContact } from "../social";

type UserParams = { Params: { userId: string } };

export function contactRoutes(app: FastifyInstance, ctx: Services) {
  const { db, env, live } = ctx;
  const auth = { preHandler: requireSession(env.SESSION_TOKEN_SECRET) };
  const me = (req: { session: { sub: string } | null }) => req.session!.sub;
  const changed = (userId: string) => live.send(userId, { type: "contacts-changed" });

  const findRow = async (from: string, to: string) => {
    const [row] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.userId, from), eq(contacts.contactUserId, to)));
    return row;
  };

  /** Turns their pending request into a friendship (two accepted rows). */
  const acceptBetween = async (userId: string, requesterId: string) => {
    await db.transaction(async (tx) => {
      await tx
        .update(contacts)
        .set({ status: "accepted" })
        .where(and(eq(contacts.userId, requesterId), eq(contacts.contactUserId, userId)));
      await tx
        .insert(contacts)
        .values({ userId, contactUserId: requesterId, status: "accepted" })
        .onConflictDoUpdate({
          target: [contacts.userId, contacts.contactUserId],
          set: { status: "accepted" },
        });
    });
  };

  app.get("/contacts", auth, async (req) => loadContacts(db, live, me(req)));

  // Add by friend code. If they already asked to add you, this accepts their request instead.
  app.post("/contacts", auth, async (req, reply) => {
    const body = parseBody(AddContactRequest, req, reply);
    if (!body) return;
    const [target] = await db.select().from(users).where(eq(users.friendCode, body.friendCode));
    if (!target) return sendError(reply, 404, "not_found", "No one has that friend code.");
    if (target.id === me(req)) {
      return sendError(reply, 400, "invalid_request", "That's your own friend code.");
    }

    const theirs = await findRow(target.id, me(req));
    if (theirs?.status === "pending") {
      await acceptBetween(me(req), target.id);
    } else if (!(await findRow(me(req), target.id))) {
      await db.insert(contacts).values({ userId: me(req), contactUserId: target.id });
    }
    changed(target.id);
    return loadContacts(db, live, me(req));
  });

  app.post<UserParams>("/contacts/:userId/accept", auth, async (req, reply) => {
    const theirs = await findRow(req.params.userId, me(req));
    if (theirs?.status !== "pending") {
      return sendError(reply, 404, "not_found", "No pending request from that person.");
    }
    await acceptBetween(me(req), req.params.userId);
    changed(req.params.userId);
    return loadContacts(db, live, me(req));
  });

  // Unfriend, decline a request, or cancel your own request: all remove both directions.
  app.delete<UserParams>("/contacts/:userId", auth, async (req) => {
    await removeContact(db, me(req), req.params.userId);
    changed(req.params.userId);
    return loadContacts(db, live, me(req));
  });

  app.patch<UserParams>("/contacts/:userId", auth, async (req, reply) => {
    const body = parseBody(UpdateContactRequest, req, reply);
    if (!body) return;
    const updated = await db
      .update(contacts)
      .set({ label: body.label || null })
      .where(
        and(
          eq(contacts.userId, me(req)),
          eq(contacts.contactUserId, req.params.userId),
          eq(contacts.status, "accepted"),
        ),
      )
      .returning();
    if (!updated.length) return sendError(reply, 404, "not_found", "Not one of your contacts.");
    return loadContacts(db, live, me(req));
  });

  /** Writes a group's name and members, keeping only people who are accepted contacts. */
  const saveGroup = async (ownerId: string, groupId: string, body: SaveGroupRequest) => {
    const allowed = new Set(await acceptedContactIds(db, ownerId));
    const memberIds = [...new Set(body.memberIds)].filter((id) => allowed.has(id));
    await db.transaction(async (tx) => {
      await tx
        .insert(contactGroups)
        .values({ id: groupId, ownerId, name: body.name })
        .onConflictDoUpdate({ target: contactGroups.id, set: { name: body.name } });
      await tx.delete(contactGroupMembers).where(eq(contactGroupMembers.groupId, groupId));
      if (memberIds.length) {
        await tx
          .insert(contactGroupMembers)
          .values(memberIds.map((userId) => ({ groupId, userId })));
      }
    });
  };

  const ownGroup = async (ownerId: string, groupId: string) => {
    const [group] = await db
      .select()
      .from(contactGroups)
      .where(and(eq(contactGroups.id, groupId), eq(contactGroups.ownerId, ownerId)));
    return group;
  };

  app.post("/contact-groups", auth, async (req, reply) => {
    const body = parseBody(SaveGroupRequest, req, reply);
    if (!body) return;
    await saveGroup(me(req), `grp_${randomUUID()}`, body);
    return reply.code(201).send(await loadContacts(db, live, me(req)));
  });

  app.put<IdParams>("/contact-groups/:id", auth, async (req, reply) => {
    const body = parseBody(SaveGroupRequest, req, reply);
    if (!body) return;
    if (!(await ownGroup(me(req), req.params.id))) {
      return sendError(reply, 404, "not_found", "No such group.");
    }
    await saveGroup(me(req), req.params.id, body);
    return loadContacts(db, live, me(req));
  });

  app.delete<IdParams>("/contact-groups/:id", auth, async (req, reply) => {
    if (!(await ownGroup(me(req), req.params.id))) {
      return sendError(reply, 404, "not_found", "No such group.");
    }
    await db.delete(contactGroups).where(eq(contactGroups.id, req.params.id));
    return loadContacts(db, live, me(req));
  });
}
