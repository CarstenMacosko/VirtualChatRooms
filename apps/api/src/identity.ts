import { createClerkClient, verifyToken } from "@clerk/backend";
import type { Env } from "./env";

/**
 * The sign-in provider behind real accounts (PLAN.md § 10: a managed service). The API only ever
 * asks it three things; everything downstream uses our own session token.
 */
export interface IdentityProvider {
  /** Stored as `users.auth_provider`. */
  readonly name: string;
  /** Verifies a session token from the provider's browser SDK; returns the provider's user id. */
  verify(token: string): Promise<{ id: string }>;
  /** What we can pre-fill for a new account. */
  profile(id: string): Promise<{ displayName: string | null }>;
  /** Removes the provider account, e.g. when someone under 13 tries to sign up. */
  deleteAccount(id: string): Promise<void>;
}

export class ClerkIdentity implements IdentityProvider {
  readonly name = "clerk";
  private client;

  constructor(private env: Env) {
    this.client = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });
  }

  async verify(token: string) {
    const payload = await verifyToken(token, {
      secretKey: this.env.CLERK_SECRET_KEY,
      ...(this.env.CLERK_JWT_KEY && { jwtKey: this.env.CLERK_JWT_KEY }),
    });
    // Only sessions created on our own web app count.
    if (!isAllowedParty(payload.azp, this.env)) throw new Error(`unexpected origin ${payload.azp}`);
    if (!payload.sub) throw new Error("token has no subject");
    return { id: payload.sub };
  }

  async profile(id: string) {
    const user = await this.client.users.getUser(id);
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
    const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses[0]?.emailAddress;
    return { displayName: name || user.username || email?.split("@")[0] || null };
  }

  async deleteAccount(id: string) {
    await this.client.users.deleteUser(id);
  }
}

const SHARE_ORIGIN = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/;

/**
 * Which web origins may sign people in: the configured one, plus (in development) a
 * `pnpm share` tunnel address, which changes every time sharing starts.
 */
export function isAllowedParty(azp: unknown, env: Pick<Env, "WEB_ORIGIN" | "NODE_ENV">): boolean {
  if (azp === undefined) return true; // tokens minted server-side carry no origin
  if (typeof azp === "string" && webOrigins(env).includes(azp)) return true;
  return env.NODE_ENV !== "production" && typeof azp === "string" && SHARE_ORIGIN.test(azp);
}

/** `WEB_ORIGIN` as a list. */
export function webOrigins(env: Pick<Env, "WEB_ORIGIN">): string[] {
  return env.WEB_ORIGIN.split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

export function identityFromEnv(env: Env): IdentityProvider | null {
  return env.CLERK_SECRET_KEY ? new ClerkIdentity(env) : null;
}
