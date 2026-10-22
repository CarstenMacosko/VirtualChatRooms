import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";
import { type ApiError, SessionClaims } from "@vcr/protocol";

/**
 * Session tokens are the one credential every service accepts (API and realm share the secret).
 * Phase 0 issues them from /auth/dev-login. When the managed auth provider is added, an
 * /auth/exchange route will verify the provider's token and issue this same session token, so
 * nothing downstream changes.
 */

const ISSUER = "vcr-api";
const keyFor = (secret: string) => new TextEncoder().encode(secret);

export function issueSessionToken(claims: SessionClaims, secret: string, ttl = "12h") {
  return new SignJWT({ name: claims.name, kind: claims.kind })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(keyFor(secret));
}

export async function verifySessionToken(token: string, secret: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, keyFor(secret), {
    algorithms: ["HS256"],
    issuer: ISSUER,
  });
  return SessionClaims.parse(payload);
}

declare module "fastify" {
  interface FastifyRequest {
    session: SessionClaims | null;
  }
}

/** preHandler that rejects requests without a valid `Authorization: Bearer <session token>`. */
export function requireSession(secret: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const unauthorized: ApiError = { error: "unauthorized", message: "Sign in required." };
    if (!header?.startsWith("Bearer ")) return reply.code(401).send(unauthorized);
    try {
      req.session = await verifySessionToken(header.slice("Bearer ".length), secret);
    } catch {
      return reply.code(401).send(unauthorized);
    }
  };
}
