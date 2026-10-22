import { jwtVerify, SignJWT } from "jose";
import {
  INTERNAL_AUDIENCE,
  REALM_ISSUER,
  REALM_TICKET_AUDIENCE,
  RealmTicketClaims,
} from "@vcr/protocol";

const keyFor = (secret: string) => new TextEncoder().encode(secret);

/** Verifies a realm ticket issued by apps/api. Both servers share SESSION_TOKEN_SECRET. */
export async function verifyRealmTicket(
  ticket: string,
  secret: string,
): Promise<RealmTicketClaims> {
  const { payload } = await jwtVerify(ticket, keyFor(secret), {
    algorithms: ["HS256"],
    issuer: "vcr-api",
    audience: REALM_TICKET_AUDIENCE,
  });
  return RealmTicketClaims.parse(payload);
}

/** Short-lived token for the realm's own calls to the API's `/internal/*` routes. */
export function issueInternalToken(secret: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(REALM_ISSUER)
    .setAudience(INTERNAL_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1m")
    .sign(keyFor(secret));
}
