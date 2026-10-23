import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  ageInYears,
  DevLoginRequest,
  type DevLoginResponse,
  ExchangeRequest,
  type ExchangeResponse,
  type MeResponse,
  MIN_ACCOUNT_AGE,
  type PublicUser,
} from "@vcr/protocol";
import type { Services } from "../app";
import { issueSessionToken, requireSession } from "../auth";
import { users } from "../db/schema";
import { isLocalRequest, parseBody, sendError } from "../http";
import { ensureFriendCode } from "../social";

const toPublicUser = (row: typeof users.$inferSelect): PublicUser => ({
  id: row.id,
  displayName: row.displayName,
  avatarId: row.avatarId,
  createdAt: row.createdAt.toISOString(),
});

export const ageMessage = `You must be ${MIN_ACCOUNT_AGE} or older to create an account. Younger family members can join a gathering with a guest link from a parent.`;

/**
 * Our session token for a user row: the one credential every service accepts. Sessions that
 * can't be renewed by a sign-in provider (device and invite links) last longer.
 */
export async function signedInAs(
  ctx: Pick<Services, "db" | "env">,
  row: typeof users.$inferSelect,
  ttl = "12h",
): Promise<DevLoginResponse> {
  await ensureFriendCode(ctx.db, row.id);
  const user = toPublicUser(row);
  const token = await issueSessionToken(
    { sub: user.id, name: user.displayName, kind: "user" },
    ctx.env.SESSION_TOKEN_SECRET,
    ttl,
  );
  return { token, user };
}

export function authRoutes(app: FastifyInstance, ctx: Services) {
  const { db, env, identity } = ctx;
  const signedIn = (row: typeof users.$inferSelect) => signedInAs(ctx, row);

  /** The 13+ age gate (PLAN.md § 10). The birth date itself is never stored. */
  const tooYoung = (birthDate: string, reply: FastifyReply) => {
    if (ageInYears(birthDate) >= MIN_ACCOUNT_AGE) return false;
    void sendError(reply, 403, "age_requirement", ageMessage);
    return true;
  };

  // Development-only sign-in. Same display name → same user, so local testing is repeatable.
  if (env.NODE_ENV !== "production") {
    app.post("/auth/dev-login", async (req, reply) => {
      // Name-only sign-in is for your own machine. Through a shared link, anyone could type your
      // name and become you; they use guest links or real accounts there instead.
      if (!isLocalRequest(req) && !env.ALLOW_REMOTE_DEV_LOGIN) {
        return sendError(
          reply,
          403,
          "dev_login_local_only",
          "The development sign-in only works on the host's own computer. Ask for a guest link.",
        );
      }
      const body = parseBody(DevLoginRequest, req, reply);
      if (!body || tooYoung(body.birthDate, reply)) return;
      const [row] = await db
        .insert(users)
        .values({
          id: `usr_${randomUUID()}`,
          displayName: body.displayName,
          authProvider: "dev",
          authProviderId: body.displayName.toLowerCase(),
          ageConfirmed13PlusAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [users.authProvider, users.authProviderId],
          set: { displayName: body.displayName },
        })
        .returning();
      return signedIn(row!);
    });
  }

  // Real accounts: verify the sign-in provider's session and issue ours. New accounts first
  // give a display name and birth date; under-13 sign-ups are refused and their provider
  // account deleted, so nothing about a child is kept.
  app.post("/auth/exchange", async (req, reply) => {
    if (!identity) {
      return sendError(reply, 501, "not_configured", "Accounts aren't set up on this server.");
    }
    const body = parseBody(ExchangeRequest, req, reply);
    if (!body) return;
    let providerId: string;
    try {
      providerId = (await identity.verify(body.providerToken)).id;
    } catch {
      return sendError(reply, 401, "unauthorized", "Your sign-in expired. Sign in again.");
    }

    const [existing] = await db
      .select()
      .from(users)
      .where(and(eq(users.authProvider, identity.name), eq(users.authProviderId, providerId)));
    if (existing) {
      const response: ExchangeResponse = { status: "signed-in", ...(await signedIn(existing)) };
      return response;
    }

    if (!body.profile) {
      const { displayName } = await identity
        .profile(providerId)
        .catch(() => ({ displayName: null }));
      const response: ExchangeResponse = {
        status: "needs-profile",
        suggestedName: (displayName ?? "").slice(0, 40),
      };
      return response;
    }

    if (ageInYears(body.profile.birthDate) < MIN_ACCOUNT_AGE) {
      await identity.deleteAccount(providerId).catch((err: unknown) => {
        req.log.error({ err }, "could not delete an under-13 provider account");
      });
      return sendError(reply, 403, "age_requirement", ageMessage);
    }

    const [row] = await db
      .insert(users)
      .values({
        id: `usr_${randomUUID()}`,
        displayName: body.profile.displayName,
        authProvider: identity.name,
        authProviderId: providerId,
        ageConfirmed13PlusAt: new Date(),
      })
      // Two tabs finishing sign-up at once: the second just signs in.
      .onConflictDoUpdate({
        target: [users.authProvider, users.authProviderId],
        set: { authProviderId: providerId },
      })
      .returning();
    const response: ExchangeResponse = { status: "signed-in", ...(await signedIn(row!)) };
    return response;
  });

  app.get("/me", { preHandler: requireSession(env.SESSION_TOKEN_SECRET) }, async (req, reply) => {
    const [row] = await db.select().from(users).where(eq(users.id, req.session!.sub));
    if (!row) return sendError(reply, 404, "not_found", "User no longer exists.");
    const response: MeResponse = {
      ...toPublicUser(row),
      friendCode: row.friendCode ?? (await ensureFriendCode(db, row.id)),
    };
    return response;
  });
}
