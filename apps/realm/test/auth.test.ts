import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { verifySessionToken } from "../src/auth";

const secret = "test-secret-that-is-at-least-32-characters";
const key = new TextEncoder().encode(secret);

const sign = (claims: Record<string, unknown>, opts: { issuer?: string; exp?: string } = {}) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(opts.issuer ?? "vcr-api")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h")
    .sign(key);

describe("verifySessionToken", () => {
  it("accepts a token issued by the API", async () => {
    const token = await sign({ sub: "usr_1", name: "Ada", kind: "user" });
    await expect(verifySessionToken(token, secret)).resolves.toEqual({
      sub: "usr_1",
      name: "Ada",
      kind: "user",
    });
  });

  it("rejects the wrong secret, issuer, expired tokens and malformed claims", async () => {
    const good = { sub: "usr_1", name: "Ada", kind: "user" };
    await expect(verifySessionToken(await sign(good), secret + "x")).rejects.toThrow();
    await expect(
      verifySessionToken(await sign(good, { issuer: "evil" }), secret),
    ).rejects.toThrow();
    await expect(verifySessionToken(await sign(good, { exp: "-1m" }), secret)).rejects.toThrow();
    await expect(verifySessionToken(await sign({ sub: "usr_1" }), secret)).rejects.toThrow();
  });
});
