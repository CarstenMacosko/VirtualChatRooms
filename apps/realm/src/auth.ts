import { jwtVerify } from "jose";
import { SessionClaims } from "@vcr/protocol";

/** Verifies a session token issued by apps/api. Both servers share SESSION_TOKEN_SECRET. */
export async function verifySessionToken(token: string, secret: string): Promise<SessionClaims> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ["HS256"],
    issuer: "vcr-api",
  });
  return SessionClaims.parse(payload);
}
