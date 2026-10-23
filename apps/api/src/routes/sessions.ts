import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  ChangeRoomRequest,
  GuestJoinRequest,
  type GuestLinkInfo,
  type GuestLinkResponse,
  InviteMoreRequest,
  type JoinSessionResponse,
  type RealmTicketClaims,
  type RecentCall,
  type RecentCallsResponse,
  type SessionsResponse,
  type ShareInfo,
  StartSessionRequest,
} from "@vcr/protocol";
import type { Services } from "../app";
import { issueRealmTicket, requireRealm, requireSession } from "../auth";
import type { Database } from "../db/client";
import {
  calls,
  contactGroupMembers,
  contactGroups,
  guestLinks,
  rooms,
  sessionInvites,
  sessions,
  users,
} from "../db/schema";
import { type IdParams, isLocalRequest, parseBody, sendError } from "../http";
import { acceptedContactIds } from "../social";
import { avatarOf } from "./avatar";
import { sceneAssets } from "./rooms";

/** Guest links last the evening, and stop working as soon as the session ends. */
const GUEST_LINK_TTL_MS = 12 * 60 * 60_000;

type TokenParams = { Params: { token: string } };

/** A guest link into a live session; it stops working when the session ends. */
export async function newGuestLink(
  db: Database,
  sessionId: string,
  createdBy: string,
): Promise<GuestLinkResponse> {
  const token = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + GUEST_LINK_TTL_MS);
  await db.insert(guestLinks).values({ token, sessionId, createdBy, expiresAt });
  return { token, path: `/join/${token}`, expiresAt: expiresAt.toISOString() };
}

export function sessionRoutes(app: FastifyInstance, ctx: Services) {
  const { db, env, gatherings, storage } = ctx;
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

  // Start a gathering in one of your rooms and ring the people you chose.
  app.post("/sessions", auth, async (req, reply) => {
    const body = parseBody(StartSessionRequest, req, reply);
    if (!body) return;
    const [room] = await db
      .select()
      .from(rooms)
      .where(and(eq(rooms.id, body.roomId), eq(rooms.ownerId, me(req))));
    if (!room) return sendError(reply, 404, "not_found", "You can only host in your own rooms.");
    if (room.status !== "ready") {
      return sendError(reply, 409, "room_not_ready", "That room isn't ready yet.");
    }

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

  // Call history, like a phone's Recents: calls you made, calls you got, and calls through your
  // call link.
  app.get("/me/recent-calls", auth, async (req): Promise<RecentCallsResponse> => {
    const limit = 30;
    const hosted = await db
      .select()
      .from(sessions)
      .where(eq(sessions.hostId, me(req)))
      .orderBy(desc(sessions.createdAt))
      .limit(limit);
    const hostedInvites = hosted.length
      ? await db
          .select({
            sessionId: sessionInvites.sessionId,
            userId: sessionInvites.inviteeId,
            name: users.displayName,
            status: sessionInvites.status,
          })
          .from(sessionInvites)
          .innerJoin(users, eq(users.id, sessionInvites.inviteeId))
          .where(
            inArray(
              sessionInvites.sessionId,
              hosted.map((h) => h.id),
            ),
          )
      : [];
    const received = await db
      .select({ invite: sessionInvites, session: sessions, hostName: users.displayName })
      .from(sessionInvites)
      .innerJoin(sessions, eq(sessions.id, sessionInvites.sessionId))
      .innerJoin(users, eq(users.id, sessions.hostId))
      .where(eq(sessionInvites.inviteeId, me(req)))
      .orderBy(desc(sessionInvites.createdAt))
      .limit(limit);
    const linkCalls = await db
      .select()
      .from(calls)
      .where(eq(calls.ownerId, me(req)))
      .orderBy(desc(calls.createdAt))
      .limit(limit);
    const liveIds = new Set(
      [...hosted.map((h) => h), ...received.map((r) => r.session)]
        .filter((x) => x.status === "live")
        .map((x) => x.id),
    );

    const list: RecentCall[] = [];
    for (const h of hosted) {
      const invited = hostedInvites.filter((i) => i.sessionId === h.id);
      // Calls answered through your call link already show as call-link entries.
      if (!invited.length && linkCalls.some((c) => c.sessionId === h.id)) continue;
      list.push({
        id: h.id,
        at: h.createdAt.toISOString(),
        direction: "outgoing",
        people: invited.map((i) => ({ userId: i.userId, name: i.name })),
        outcome: invited.some((i) => i.status === "accepted")
          ? "answered"
          : invited.some((i) => i.status === "ringing")
            ? "ringing"
            : "no-answer",
        live: liveIds.has(h.id),
        sessionId: h.id,
      });
    }
    for (const r of received) {
      list.push({
        id: r.session.id,
        at: r.invite.createdAt.toISOString(),
        direction: "incoming",
        people: [{ userId: r.session.hostId, name: r.hostName }],
        outcome: r.invite.status === "accepted" ? "answered" : r.invite.status,
        live: liveIds.has(r.session.id),
        sessionId: r.session.id,
      });
    }
    for (const c of linkCalls) {
      list.push({
        id: c.id,
        at: c.createdAt.toISOString(),
        direction: "call-link",
        people: [{ userId: null, name: c.callerName }],
        outcome: c.status === "accepted" ? "answered" : c.status,
        live: false,
        sessionId: c.sessionId,
      });
    }
    list.sort((a, b) => b.at.localeCompare(a.at));
    return { calls: list.slice(0, limit) };
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
    const row = await liveSession(info.id);
    const response: JoinSessionResponse = {
      sessionId: info.id,
      role,
      room: info.room,
      scene: row ? await sceneAssets(storage, row.room, info.id) : null,
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

  // Move a live gathering to another of the host's ready rooms. Clients rejoin (the realm tells
  // them) and get the new room's signed assets.
  app.post<IdParams>("/sessions/:id/room", auth, async (req, reply) => {
    const body = parseBody(ChangeRoomRequest, req, reply);
    if (!body) return;
    const row = await hostedLive(req.params.id, me(req), reply);
    if (!row) return;
    const [room] = await db
      .select()
      .from(rooms)
      .where(and(eq(rooms.id, body.roomId), eq(rooms.ownerId, me(req))));
    if (!room) return sendError(reply, 404, "not_found", "You can only use your own rooms.");
    if (room.status !== "ready") {
      return sendError(reply, 409, "room_not_ready", "That room isn't ready yet.");
    }
    await db.update(sessions).set({ roomId: room.id }).where(eq(sessions.id, row.session.id));
    return gatherings.info(row.session.id);
  });

  app.post<IdParams>("/sessions/:id/end", auth, async (req, reply) => {
    const row = await hostedLive(req.params.id, me(req), reply);
    if (!row) return;
    await gatherings.end(row.session.id);
    return reply.code(204).send();
  });

  const createGuestLink = (sessionId: string, createdBy: string) =>
    newGuestLink(db, sessionId, createdBy);

  app.post<IdParams>("/sessions/:id/guest-links", auth, async (req, reply) => {
    const row = await hostedLive(req.params.id, me(req), reply);
    if (!row) return;
    return reply.code(201).send(await createGuestLink(row.session.id, me(req)));
  });

  // Development only: the public link `pnpm share` is serving, so copied guest links point there
  // even when the host is on localhost.
  if (env.NODE_ENV !== "production") {
    app.get("/dev/share", async (): Promise<ShareInfo> => {
      try {
        const url = (await readFile(env.SHARE_URL_FILE, "utf8")).trim();
        return { url: /^https:\/\//.test(url) ? url : null };
      } catch {
        return { url: null };
      }
    });
  }

  // Development only, like /auth/dev-login: a guest link into whichever gathering started most
  // recently, so `pnpm bots 10` works without copying a link out of the app.
  if (env.NODE_ENV !== "production") {
    app.post("/dev/latest-guest-link", async (req, reply) => {
      if (!isLocalRequest(req)) {
        return sendError(reply, 403, "local_only", "Only available on the host's computer.");
      }
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
      scene: await sceneAssets(storage, row.room, row.session.id),
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
