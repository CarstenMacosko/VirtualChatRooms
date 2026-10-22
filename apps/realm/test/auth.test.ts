import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { REALM_TICKET_AUDIENCE } from "@vcr/protocol";
import { verifyRealmTicket } from "../src/auth";

const secret = "test-secret-that-is-at-least-32-characters";
const key = new TextEncoder().encode(secret);

const sign = (
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string | null; exp?: string } = {},
) => {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(opts.issuer ?? "vcr-api")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m");
  if (opts.audience !== null) jwt.setAudience(opts.audience ?? REALM_TICKET_AUDIENCE);
  return jwt.sign(key);
};

const ticket = { sub: "usr_1", name: "Ada", kind: "user", sessionId: "ses_1", role: "member" };

describe("verifyRealmTicket", () => {
  it("accepts a ticket issued by the API", async () => {
    await expect(verifyRealmTicket(await sign(ticket), secret)).resolves.toEqual(ticket);
  });

  it("rejects the wrong secret, issuer, expired tickets and malformed claims", async () => {
    await expect(verifyRealmTicket(await sign(ticket), secret + "x")).rejects.toThrow();
    await expect(
      verifyRealmTicket(await sign(ticket, { issuer: "evil" }), secret),
    ).rejects.toThrow();
    await expect(verifyRealmTicket(await sign(ticket, { exp: "-1m" }), secret)).rejects.toThrow();
    await expect(
      verifyRealmTicket(await sign({ ...ticket, role: "cohost" }), secret),
    ).rejects.toThrow();
  });

  it("rejects plain session tokens, which have no realm audience", async () => {
    const sessionToken = await sign(
      { sub: "usr_1", name: "Ada", kind: "user" },
      { audience: null },
    );
    await expect(verifyRealmTicket(sessionToken, secret)).rejects.toThrow();
    await expect(
      verifyRealmTicket(await sign(ticket, { audience: "something-else" }), secret),
    ).rejects.toThrow();
  });
});
