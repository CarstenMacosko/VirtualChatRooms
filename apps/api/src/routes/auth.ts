import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  ageInYears,
  type ApiError,
  DevLoginRequest,
  type DevLoginResponse,
  type MeResponse,
  MIN_ACCOUNT_AGE,
  type PublicUser,
} from "@vcr/protocol";
import type { AppContext } from "../app";
import { issueSessionToken, requireSession } from "../auth";
import { users } from "../db/schema";
import { ensureFriendCode } from "../social";

const toPublicUser = (row: typeof users.$inferSelect): PublicUser => ({
  id: row.id,
  displayName: row.displayName,
  avatarId: row.avatarId,
  createdAt: row.createdAt.toISOString(),
});

export function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, env } = ctx;

  // Development-only sign-in. Same display name → same user, so local testing is repeatable.
  if (env.NODE_ENV !== "production") {
    app.post("/auth/dev-login", async (req, reply) => {
      const body = DevLoginRequest.safeParse(req.body);
      if (!body.success) {
        const error: ApiError = { error: "invalid_request", message: body.error.message };
        return reply.code(400).send(error);
      }
      if (ageInYears(body.data.birthDate) < MIN_ACCOUNT_AGE) {
        const error: ApiError = {
          error: "age_requirement",
          message: `You must be ${MIN_ACCOUNT_AGE} or older to create an account.`,
        };
        return reply.code(403).send(error);
      }

      const [row] = await db
        .insert(users)
        .values({
          id: `usr_${randomUUID()}`,
          displayName: body.data.displayName,
          authProvider: "dev",
          authProviderId: body.data.displayName.toLowerCase(),
          ageConfirmed13PlusAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [users.authProvider, users.authProviderId],
          set: { displayName: body.data.displayName },
        })
        .returning();

      await ensureFriendCode(db, row!.id);
      const user = toPublicUser(row!);
      const token = await issueSessionToken(
        { sub: user.id, name: user.displayName, kind: "user" },
        env.SESSION_TOKEN_SECRET,
      );
      const response: DevLoginResponse = { token, user };
      return response;
    });
  }

  app.get("/me", { preHandler: requireSession(env.SESSION_TOKEN_SECRET) }, async (req, reply) => {
    const [row] = await db.select().from(users).where(eq(users.id, req.session!.sub));
    if (!row) {
      const error: ApiError = { error: "not_found", message: "User no longer exists." };
      return reply.code(404).send(error);
    }
    const response: MeResponse = {
      ...toPublicUser(row),
      friendCode: row.friendCode ?? (await ensureFriendCode(db, row.id)),
    };
    return response;
  });
}
