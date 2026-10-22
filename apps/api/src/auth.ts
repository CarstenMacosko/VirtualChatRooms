import type { FastifyReply, FastifyRequest } from "fastify";
import { jwtVerify, SignJWT } from "jose";
import {
  type ApiError,
  INTERNAL_AUDIENCE,
  REALM_ISSUER,
  REALM_TICKET_AUDIENCE,
  type RealmTicketClaims,
  SessionClaims,
} from "@vcr/protocol";

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
  // Realm tickets share the issuer and key but carry an audience; they are not session tokens.
  if (payload.aud !== undefined) throw new Error("not a session token");
  return SessionClaims.parse(payload);
}

/**
 * A realm ticket admits one person to one session's realm room with the role the API decided.
 * Short-lived: clients fetch a fresh one (re-calling join) whenever they reconnect.
 */
export function issueRealmTicket(claims: RealmTicketClaims, secret: string, ttl = "10m") {
  return new SignJWT({
    name: claims.name,
    kind: claims.kind,
    sessionId: claims.sessionId,
    role: claims.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(REALM_TICKET_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(keyFor(secret));
}

/** preHandler for `/internal/*`: only the realm server, signing with the shared secret, may call. */
export function requireRealm(secret: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization;
    const forbidden: ApiError = { error: "forbidden", message: "Internal endpoint." };
    if (!header?.startsWith("Bearer ")) return reply.code(403).send(forbidden);
    try {
      await jwtVerify(header.slice("Bearer ".length), keyFor(secret), {
        algorithms: ["HS256"],
        issuer: REALM_ISSUER,
        audience: INTERNAL_AUDIENCE,
      });
    } catch {
      return reply.code(403).send(forbidden);
    }
  };
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
