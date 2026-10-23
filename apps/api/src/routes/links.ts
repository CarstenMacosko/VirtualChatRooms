import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AcceptInviteRequest,
  ageInYears,
  type AnswerCallResponse,
  CALL_RING_MS,
  type CallState,
  DEVICE_LINK_TTL_MS,
  INVITE_LINK_TTL_MS,
  type LinkInfo,
  type LinkKind,
  type LinkResponse,
  MIN_ACCOUNT_AGE,
  StartCallRequest,
  type StartCallResponse,
} from "@vcr/protocol";
import type { Services } from "../app";
import { requireSession, verifySessionToken } from "../auth";
import { calls, links, rooms, sessions, users } from "../db/schema";
import { type IdParams, parseBody, sendError } from "../http";
import { befriend } from "../social";
import { ageMessage, signedInAs } from "./auth";
import { ensureSampleRoom } from "./rooms";
import { newGuestLink } from "./sessions";

type TokenParams = { Params: { token: string } };
const AdminSignInRequest = z.object({ displayName: z.string().trim().min(1).max(40) });
type CallParams = { Params: { id: string }; Querystring: { secret?: string } };

const PATHS: Record<LinkKind, string> = { device: "/link/", invite: "/invite/", call: "/call/" };
/** Sessions from device and invite links can't be renewed by a sign-in provider. */
const LINKED_SESSION_TTL = "30d";
/** Call links are public: at most this many calls per link in ten minutes. */
const CALLS_PER_WINDOW = 6;
const CALL_WINDOW_MS = 10 * 60_000;

/**
 * Bringing in other devices and people (`LinkKind` in @vcr/protocol): sign in on your phone,
 * invite a friend, and your personal "call me" link with the calls it rings through.
 */
export function linkRoutes(app: FastifyInstance, ctx: Services) {
  const { db, env, live, push, identity } = ctx;
  const auth = { preHandler: requireSession(env.SESSION_TOKEN_SECRET) };
  const me = (req: { session: { sub: string } | null }) => req.session!.sub;
  const ringTimers = new Map<string, NodeJS.Timeout>();
  const ringMs = ctx.ringTimeoutMs ?? CALL_RING_MS;

  const toResponse = (row: typeof links.$inferSelect): LinkResponse => ({
    kind: row.kind,
    token: row.token,
    path: `${PATHS[row.kind]}${row.token}`,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  });

  const createLink = async (kind: LinkKind, ownerId: string, ttlMs: number | null) => {
    const [row] = await db
      .insert(links)
      .values({
        token: randomBytes(18).toString("base64url"),
        kind,
        ownerId,
        expiresAt: ttlMs === null ? null : new Date(Date.now() + ttlMs),
      })
      .returning();
    return row!;
  };

  /** A link that can still be used, with its owner. */
  const usable = async (token: string) => {
    const [row] = await db
      .select({ link: links, owner: users })
      .from(links)
      .innerJoin(users, eq(users.id, links.ownerId))
      .where(eq(links.token, token));
    if (!row || row.link.revokedAt) return null;
    if (row.link.expiresAt && row.link.expiresAt.getTime() < Date.now()) return null;
    if (row.link.kind === "device" && row.link.usedAt) return null;
    return row;
  };

  /** Signed-in caller, if the request carries a valid session token (optional auth). */
  const optionalUser = async (authorization: string | undefined) => {
    if (!authorization?.startsWith("Bearer ")) return null;
    try {
      return await verifySessionToken(authorization.slice(7), env.SESSION_TOKEN_SECRET);
    } catch {
      return null;
    }
  };

  // --- Creating links (signed in) ---

  app.post("/me/device-links", auth, async (req, reply) => {
    const row = await createLink("device", me(req), DEVICE_LINK_TTL_MS);
    return reply.code(201).send(toResponse(row));
  });

  app.post("/me/invite-links", auth, async (req, reply) => {
    const row = await createLink("invite", me(req), INVITE_LINK_TTL_MS);
    return reply.code(201).send(toResponse(row));
  });

  /** Your call link: the same one until you reset it. */
  app.get("/me/call-link", auth, async (req) => {
    const [existing] = await db
      .select()
      .from(links)
      .where(and(eq(links.ownerId, me(req)), eq(links.kind, "call"), isNull(links.revokedAt)))
      .orderBy(desc(links.createdAt))
      .limit(1);
    return toResponse(existing ?? (await createLink("call", me(req), null)));
  });

  app.post("/me/call-link/reset", auth, async (req) => {
    await db
      .update(links)
      .set({ revokedAt: new Date() })
      .where(and(eq(links.ownerId, me(req)), eq(links.kind, "call"), isNull(links.revokedAt)));
    return toResponse(await createLink("call", me(req), null));
  });

  // Admin: an account (by display name) and a sign-in link for it, for whoever holds ADMIN_TOKEN.
  // This is how the first person gets in on a server without a sign-in provider.
  if (env.ADMIN_TOKEN) {
    const expected = Buffer.from(`Bearer ${env.ADMIN_TOKEN}`);
    app.post("/admin/sign-in-link", async (req, reply) => {
      const given = Buffer.from(req.headers.authorization ?? "");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return sendError(reply, 403, "forbidden", "Wrong admin token.");
      }
      const body = parseBody(AdminSignInRequest, req, reply);
      if (!body) return;
      const [user] = await db
        .insert(users)
        .values({
          id: `usr_${randomUUID()}`,
          displayName: body.displayName,
          authProvider: "admin",
          authProviderId: body.displayName.toLowerCase(),
          ageConfirmed13PlusAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [users.authProvider, users.authProviderId],
          set: { displayName: body.displayName },
        })
        .returning();
      const row = await createLink("device", user!.id, DEVICE_LINK_TTL_MS);
      return reply.code(201).send(toResponse(row));
    });
  }

  // --- Opening links (no account needed) ---

  app.get<TokenParams>("/links/:token", async (req, reply) => {
    const row = await usable(req.params.token);
    if (!row) return sendError(reply, 404, "not_found", "This link has expired or was reset.");
    const info: LinkInfo = {
      kind: row.link.kind,
      ownerName: row.owner.displayName,
      ownerOnline: live.isOnline(row.owner.id),
      canCreateAccount: !identity,
    };
    return info;
  });

  // Device link: become the link's owner on this device. Single use.
  app.post<TokenParams>("/links/:token/claim", async (req, reply) => {
    const row = await usable(req.params.token);
    if (!row || row.link.kind !== "device") {
      return sendError(reply, 404, "not_found", "This sign-in link has expired. Make a new one.");
    }
    const [claimed] = await db
      .update(links)
      .set({ usedAt: new Date() })
      .where(and(eq(links.token, row.link.token), isNull(links.usedAt)))
      .returning();
    if (!claimed) {
      return sendError(reply, 404, "not_found", "This sign-in link was already used.");
    }
    return signedInAs(ctx, row.owner, LINKED_SESSION_TTL);
  });

  // Invite link: you and the inviter become contacts. Signed in, it just connects you; without
  // an account (and no sign-in provider on this server) it makes one, behind the same 13+ gate.
  app.post<TokenParams>("/links/:token/accept", async (req, reply) => {
    const body = parseBody(AcceptInviteRequest, req, reply);
    if (!body) return;
    const row = await usable(req.params.token);
    if (!row || row.link.kind !== "invite") {
      return sendError(reply, 404, "not_found", "This invite has expired. Ask for a new one.");
    }
    const session = await optionalUser(req.headers.authorization);
    if (session) {
      if (session.kind !== "user") {
        return sendError(reply, 403, "forbidden", "Sign in to accept an invite.");
      }
      await befriend(db, row.owner.id, session.sub);
      live.send(row.owner.id, { type: "contacts-changed" });
      live.send(session.sub, { type: "contacts-changed" });
      return reply.code(204).send();
    }
    if (identity) {
      return sendError(reply, 401, "sign_in_required", "Sign in or create an account first.");
    }
    if (!body.displayName || !body.birthDate) {
      return sendError(reply, 400, "invalid_request", "Enter your name and date of birth.");
    }
    if (ageInYears(body.birthDate) < MIN_ACCOUNT_AGE) {
      return sendError(reply, 403, "age_requirement", ageMessage);
    }
    const [user] = await db
      .insert(users)
      .values({
        id: `usr_${randomUUID()}`,
        displayName: body.displayName,
        authProvider: "invite",
        authProviderId: randomUUID(),
        ageConfirmed13PlusAt: new Date(),
      })
      .returning();
    await befriend(db, row.owner.id, user!.id);
    live.send(row.owner.id, { type: "contacts-changed" });
    return reply.code(201).send(await signedInAs(ctx, user!, LINKED_SESSION_TTL));
  });

  // --- Calls through a call link ---

  const callEnded = (ownerId: string, callId: string) => {
    clearTimeout(ringTimers.get(callId));
    ringTimers.delete(callId);
    const event = { type: "call-ended" as const, callId };
    if (live.isOnline(ownerId)) live.send(ownerId, event);
    else void push.notify(ownerId, event).catch(() => {});
  };

  /** Moves a ringing call to `status`; returns the call if it was still ringing. */
  const settle = async (callId: string, status: "declined" | "missed" | "cancelled") => {
    const [row] = await db
      .update(calls)
      .set({ status })
      .where(and(eq(calls.id, callId), eq(calls.status, "ringing")))
      .returning();
    if (row) callEnded(row.ownerId, row.id);
    return row ?? null;
  };

  // Calls that were ringing when the API restarted can't be answered any more.
  void db
    .update(calls)
    .set({ status: "missed" })
    .where(
      and(eq(calls.status, "ringing"), lt(calls.createdAt, new Date(Date.now() - CALL_RING_MS))),
    )
    .catch(() => {});
  app.addHook("onClose", async () => {
    for (const timer of ringTimers.values()) clearTimeout(timer);
  });

  app.post<TokenParams>("/links/:token/call", async (req, reply) => {
    const body = parseBody(StartCallRequest, req, reply);
    if (!body) return;
    const row = await usable(req.params.token);
    if (!row || row.link.kind !== "call") {
      return sendError(reply, 404, "not_found", "This call link was reset. Ask for the new one.");
    }
    const recent = await db
      .select({ id: calls.id })
      .from(calls)
      .where(
        and(
          eq(calls.linkToken, row.link.token),
          gt(calls.createdAt, new Date(Date.now() - CALL_WINDOW_MS)),
        ),
      );
    if (recent.length >= CALLS_PER_WINDOW) {
      return sendError(reply, 429, "too_many_calls", "Too many calls. Try again in a few minutes.");
    }
    const callId = `call_${randomUUID()}`;
    const secret = randomBytes(18).toString("base64url");
    await db.insert(calls).values({
      id: callId,
      ownerId: row.owner.id,
      linkToken: row.link.token,
      callerName: body.displayName,
      secret,
    });
    const event = { type: "call" as const, callId, from: { displayName: body.displayName } };
    if (live.isOnline(row.owner.id)) live.send(row.owner.id, event);
    else void push.notify(row.owner.id, event).catch(() => {});
    ringTimers.set(
      callId,
      setTimeout(() => void settle(callId, "missed").catch(() => {}), ringMs),
    );
    const response: StartCallResponse = { callId, secret };
    return reply.code(201).send(response);
  });

  const callerCall = async (id: string, secret: string | undefined) => {
    const [row] = await db.select().from(calls).where(eq(calls.id, id));
    return row && secret && row.secret === secret ? row : null;
  };

  // The caller waits on this: ringing → accepted (with a guest link) or declined/missed.
  app.get<CallParams>("/calls/:id", async (req, reply) => {
    const row = await callerCall(req.params.id, req.query.secret);
    if (!row) return sendError(reply, 404, "not_found", "No such call.");
    const state: CallState = { status: row.status, guestToken: row.guestToken };
    return state;
  });

  // The caller hangs up before anyone answers.
  app.delete<CallParams>("/calls/:id", async (req, reply) => {
    const row = await callerCall(req.params.id, req.query.secret);
    if (!row) return sendError(reply, 404, "not_found", "No such call.");
    await settle(row.id, "cancelled");
    return reply.code(204).send();
  });

  const ownCall = async (id: string, ownerId: string) => {
    const [row] = await db
      .select()
      .from(calls)
      .where(and(eq(calls.id, id), eq(calls.ownerId, ownerId)));
    return row ?? null;
  };

  // Answer: the caller joins your live gathering, or a new one in your first ready room.
  app.post<IdParams>("/calls/:id/answer", auth, async (req, reply) => {
    const call = await ownCall(req.params.id, me(req));
    if (!call) return sendError(reply, 404, "not_found", "No such call.");
    if (call.status !== "ringing") {
      return sendError(reply, 410, "call_over", "They're not calling any more.");
    }
    const [current] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.hostId, me(req)), eq(sessions.status, "live")))
      .orderBy(desc(sessions.createdAt))
      .limit(1);
    let sessionId = current?.id;
    if (!sessionId) {
      await ensureSampleRoom(db, me(req));
      const [room] = await db
        .select({ id: rooms.id })
        .from(rooms)
        .where(and(eq(rooms.ownerId, me(req)), eq(rooms.status, "ready"), eq(rooms.kind, "sample")))
        .limit(1);
      sessionId = `ses_${randomUUID()}`;
      await db.insert(sessions).values({ id: sessionId, roomId: room!.id, hostId: me(req) });
    }
    const link = await newGuestLink(db, sessionId, me(req));
    const [accepted] = await db
      .update(calls)
      .set({ status: "accepted", sessionId, guestToken: link.token })
      .where(and(eq(calls.id, call.id), eq(calls.status, "ringing")))
      .returning();
    if (!accepted) return sendError(reply, 410, "call_over", "They're not calling any more.");
    callEnded(call.ownerId, call.id);
    const response: AnswerCallResponse = { sessionId };
    return response;
  });

  app.post<IdParams>("/calls/:id/decline", auth, async (req, reply) => {
    const call = await ownCall(req.params.id, me(req));
    if (!call) return sendError(reply, 404, "not_found", "No such call.");
    await settle(call.id, "declined");
    return reply.code(204).send();
  });
}
