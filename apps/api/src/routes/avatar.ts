import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import {
  type AvatarRecipe,
  type AvatarResponse,
  parseRecipe,
  SaveAvatarRequest,
} from "@vcr/protocol";
import type { Services } from "../app";
import { requireSession } from "../auth";
import type { Database } from "../db/client";
import { avatars, users } from "../db/schema";
import { parseBody } from "../http";

/** The user's saved avatar recipe, or null if they haven't made one yet. */
export async function avatarOf(db: Database, userId: string): Promise<AvatarRecipe | null> {
  const [row] = await db
    .select({ recipe: avatars.recipe })
    .from(avatars)
    .where(eq(avatars.ownerId, userId));
  return row ? parseRecipe(row.recipe) : null;
}

export function avatarRoutes(app: FastifyInstance, ctx: Services) {
  const { db, env } = ctx;
  const auth = { preHandler: requireSession(env.SESSION_TOKEN_SECRET) };

  app.get("/me/avatar", auth, async (req): Promise<AvatarResponse> => {
    return { recipe: await avatarOf(db, req.session!.sub) };
  });

  app.put("/me/avatar", auth, async (req, reply) => {
    const body = parseBody(SaveAvatarRequest, req, reply);
    if (!body) return;
    const userId = req.session!.sub;
    const [row] = await db
      .insert(avatars)
      .values({ id: `avt_${randomUUID()}`, ownerId: userId, recipe: body.recipe })
      .onConflictDoUpdate({
        target: avatars.ownerId,
        set: { recipe: body.recipe, updatedAt: new Date() },
      })
      .returning({ id: avatars.id });
    await db.update(users).set({ avatarId: row!.id }).where(eq(users.id, userId));
    const response: AvatarResponse = { recipe: body.recipe };
    return response;
  });
}
