import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  GuestJoinRequest,
  type GuestLinkInfo,
  type GuestLinkResponse,
  InviteMoreRequest,
  type JoinSessionResponse,
  type RealmTicketClaims,
  type RoomsResponse,
  type SessionsResponse,
  StartSessionRequest,
} from "@vcr/protocol";
import type { Services } from "../app";
import { issueRealmTicket, requireRealm, requireSession } from "../auth";
import {
  contactGroupMembers,
  contactGroups,
  guestLinks,
  rooms,
  sessionInvites,
  sessions,
  users,
} from "../db/schema";
import { type IdParams, parseBody, sendError } from "../http";
import { acceptedContactIds } from "../social";
import { avatarOf } from "./avatar";

/** Guest links last the evening, and stop working as soon as the session ends. */
const GUEST_LINK_TTL_MS = 12 * 60 * 60_000;

type TokenParams = { Params: { token: string } };

export function sessionRoutes(app: FastifyInstance, ctx: Services) {
  const { db, env, gatherings } = ctx;
  const auth = { preHandler: requireSession(env.SESSION_TOKEN_SECRET) };
  const me = (req: { session: { sub: string } | null }) => req.session!.sub;

  const ticket = (claims: RealmTicketClaims) => issueRealmTicket(claims, env.SESSION_TOKEN_SECRET);

  const liveSession = async (id: string) => {
    const [row] = await db
      .select({ session: sessions, room: rooms })
      .from(sessions)
      .innerJoin(rooms, eq(rooms.id, sessions.roomId))
      .where(eq(sessions.id, id));
    return row;
  };

  const displayName = async (userId: string) => {
    const [row] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId));
    return row?.displayName ?? "Someone";
  };

  /** Inserts (or re-opens declined/missed) invites for accepted contacts, then rings them. */
  const invite = async (
    sessionId: string,
    hostId: string,
    roomName: string,
    candidateIds: Iterable<string>,
  ) => {
    const allowed = new Set(await acceptedContactIds(db, hostId));
    const ids = [...new Set(candidateIds)].filter((id) => allowed.has(id) && id !== hostId);
    if (!ids.length) return;
    const existing = await db
      .select()
      .from(sessionInvites)
      .where(and(eq(sessionInvites.sessionId, sessionId), inArray(sessionInvites.inviteeId, ids)));
    const alreadyIn = new Set(
      existing
        .filter((i) => i.status === "accepted" || i.status === "ringing")
        .map((i) => i.inviteeId),
    );
    const toRing = ids.filter((id) => !alreadyIn.has(id));
    if (!toRing.length) return;
    await db
      .insert(sessionInvites)
      .values(toRing.map((inviteeId) => ({ sessionId, inviteeId })))
      .onConflictDoUpdate({
        target: [sessionInvites.sessionId, sessionInvites.inviteeId],
        set: { status: "ringing", createdAt: new Date(), respondedAt: null },
      });
    gatherings.ring(
      sessionId,
      toRing,
      { id: hostId, displayName: await displayName(hostId) },
      roomName,
    );
  };

  app.get("/rooms", auth, async (req): Promise<RoomsResponse> => {
    let owned = await db
      .select()
      .from(rooms)
      .where(eq(rooms.ownerId, me(req)));
    // Everyone gets a sample room to start in; room scans arrive in Phase 3.
    if (!owned.length) {
      owned = await db
        .insert(rooms)
        .values({
          id: `rm_${randomUUID()}`,
          ownerId: me(req),
          name: "My living room",
          kind: "sample",
        })
        .returning();
    }
    return { rooms: owned.map((r) => ({ id: r.id, name: r.name, kind: r.kind })) };
  });

  // Start a gathering in one of your rooms and ring the people you chose.
  app.post("/sessions", auth, async (req, reply) => {
    const body = parseBody(StartSessionRequest, req, reply);
    if (!body) return;
    const [room] = await db
      .select()
      .from(rooms)
      .where(and(eq(rooms.id, body.roomId), eq(rooms.ownerId, me(req))));
    if (!room) return sendError(reply, 404, "not_found", "You can only host in your own rooms.");

    // One live gathering per host: starting a new one ends the last.
    const previous = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.hostId, me(req)), eq(sessions.status, "live")));
    for (const p of previous) await gatherings.end(p.id);

    const sessionId = `ses_${randomUUID()}`;
    await db.insert(sessions).values({ id: sessionId, roomId: room.id, hostId: me(req) });

    const candidates = new Set(body.inviteUserIds);
    if (body.inviteAll) {
      for (const id of await acceptedContactIds(db, me(req))) candidates.add(id);
    }
    if (body.inviteGroupIds.length) {
      const members = await db
        .select({ userId: contactGroupMembers.userId })
        .from(contactGroupMembers)
        .innerJoin(contactGroups, eq(contactGroups.id, contactGroupMembers.groupId))
        .where(
          and(
            inArray(contactGroupMembers.groupId, body.inviteGroupIds),
            eq(contactGroups.ownerId, me(req)),
          ),
        );
      for (const m of members) candidates.add(m.userId);
    }
    await invite(sessionId, me(req), room.name, candidates);
    return reply.code(201).send(await gatherings.info(sessionId));
  });

  app.get("/sessions", auth, async (req): Promise<SessionsResponse> => {
    return { sessions: await gatherings.liveFor(me(req)) };
  });

  /** The session, if `userId` is its host or was invited to it. */
  const visibleSession = async (sessionId: string, userId: string) => {
    const info = await gatherings.info(sessionId);
    if (!info) return null;
    if (info.host.id === userId || info.invites.some((i) => i.userId === userId)) return info;
    return null;
  };

  app.get<IdParams>("/sessions/:id", auth, async (req, reply) => {
    const info = await visibleSession(req.params.id, me(req));
    if (!info) return sendError(reply, 404, "not_found", "No such gathering.");
    return info;
  });

  // Answer a ring (or join late): returns the realm ticket for this session.
  app.post<IdParams>("/sessions/:id/join", auth, async (req, reply) => {
    const info = await visibleSession(req.params.id, me(req));
    if (!info) return sendError(reply, 404, "not_found", "No such gathering.");
    if (info.status !== "live") return sendError(reply, 410, "ended", "This gathering has ended.");

    const role = info.host.id === me(req) ? "owner" : "member";
    if (role === "member") {
      await gatherings.respond(info.id, me(req), "accepted", ["ringing", "declined", "missed"]);
    }
    const response: JoinSessionResponse = {
      sessionId: info.id,
      role,
      room: info.room,
      realmTicket: await ticket({
        sub: me(req),
        name: req.session!.name,
        kind: "user",
        sessionId: info.id,
        role,
        avatar: await avatarOf(db, me(req)),
      }),
    };
    return response;
  });

  app.post<IdParams>("/sessions/:id/decline", auth, async (req, reply) => {
    const changed = await gatherings.respond(req.params.id, me(req), "declined", [
      "ringing",
      "missed",
    ]);
    if (!changed) return sendError(reply, 404, "not_found", "No call to decline.");
    return reply.code(204).send();
  });

  /** The live session, if `userId` hosts it; otherwise sends the error and returns null. */
  const hostedLive = async (
    sessionId: string,
    userId: string,
    reply: Parameters<typeof sendError>[0],
  ) => {
    const row = await liveSession(sessionId);
    if (!row || row.session.hostId !== userId) {
      void sendError(reply, 404, "not_found", "Only the host can do that.");
      return null;
    }
    if (row.session.status !== "live") {
      void sendError(reply, 410, "ended", "This gathering has ended.");
      return null;
    }
    return row;
  };

  app.post<IdParams>("/sessions/:id/invites", auth, async (req, reply) => {
    const body = parseBody(InviteMoreRequest, req, reply);
    if (!body) return;
    const row = await hostedLive(req.params.id, me(req), reply);
    if (!row) return;
    await invite(row.session.id, me(req), row.room.name, body.userIds);
    return gatherings.info(row.session.id);
  });

  app.post<IdParams>("/sessions/:id/end", auth, async (req, reply) => {
    const row = await hostedLive(req.params.id, me(req), reply);
    if (!row) return;
    await gatherings.end(row.session.id);
    return reply.code(204).send();
  });

  const createGuestLink = async (sessionId: string, createdBy: string) => {
    const token = randomBytes(18).toString("base64url");
    const expiresAt = new Date(Date.now() + GUEST_LINK_TTL_MS);
    await db.insert(guestLinks).values({ token, sessionId, createdBy, expiresAt });
    const response: GuestLinkResponse = {
      token,
      path: `/join/${token}`,
      expiresAt: expiresAt.toISOString(),
    };
    return response;
  };

  app.post<IdParams>("/sessions/:id/guest-links", auth, async (req, reply) => {
    const row = await hostedLive(req.params.id, me(req), reply);
    if (!row) return;
    return reply.code(201).send(await createGuestLink(row.session.id, me(req)));
  });

  // Development only, like /auth/dev-login: a guest link into whichever gathering started most
  // recently, so `pnpm bots 10` works without copying a link out of the app.
  if (env.NODE_ENV !== "production") {
    app.post("/dev/latest-guest-link", async (_req, reply) => {
      const [latest] = await db
        .select({ id: sessions.id, hostId: sessions.hostId })
        .from(sessions)
        .where(eq(sessions.status, "live"))
        .orderBy(desc(sessions.createdAt))
        .limit(1);
      if (!latest) {
        return sendError(reply, 404, "not_found", "No live gathering. Start one in the app first.");
      }
      return reply.code(201).send(await createGuestLink(latest.id, latest.hostId));
    });
  }

  const guestLink = async (token: string) => {
    const [row] = await db
      .select({
        link: guestLinks,
        session: sessions,
        room: rooms,
        hostName: users.displayName,
      })
      .from(guestLinks)
      .innerJoin(sessions, eq(sessions.id, guestLinks.sessionId))
      .innerJoin(rooms, eq(rooms.id, sessions.roomId))
      .innerJoin(users, eq(users.id, sessions.hostId))
      .where(eq(guestLinks.token, token));
    if (!row || row.link.expiresAt.getTime() < Date.now()) return null;
    return row;
  };

  // Guest links: no account and nothing stored about the guest (PLAN.md § 10).
  app.get<TokenParams>("/guest/:token", async (req, reply) => {
    const row = await guestLink(req.params.token);
    if (!row) return sendError(reply, 404, "not_found", "This link has expired.");
    const info: GuestLinkInfo = {
      hostName: row.hostName,
      roomName: row.room.name,
      live: row.session.status === "live",
    };
    return info;
  });

  app.post<TokenParams>("/guest/:token/join", async (req, reply) => {
    const body = parseBody(GuestJoinRequest, req, reply);
    if (!body) return;
    const row = await guestLink(req.params.token);
    if (!row) return sendError(reply, 404, "not_found", "This link has expired.");
    if (row.session.status !== "live") {
      return sendError(reply, 410, "ended", "This gathering has ended.");
    }
    const response: JoinSessionResponse = {
      sessionId: row.session.id,
      role: "guest",
      room: { id: row.room.id, name: row.room.name, kind: row.room.kind },
      realmTicket: await ticket({
        sub: `gst_${randomUUID()}`,
        name: body.displayName,
        kind: "guest",
        sessionId: row.session.id,
        role: "guest",
        avatar: body.avatar ?? null,
      }),
    };
    return response;
  });

  // The realm reports when a session ends (host ended it, or left and didn't come back).
  app.post<IdParams>(
    "/internal/sessions/:id/ended",
    { preHandler: requireRealm(env.SESSION_TOKEN_SECRET) },
    async (req, reply) => {
      await gatherings.end(req.params.id);
      return reply.code(204).send();
    },
  );
}
