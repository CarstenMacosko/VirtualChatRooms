import { z } from "zod";

/** Accounts are 13+ only at launch (PLAN.md § 10). */
export const MIN_ACCOUNT_AGE = 13;

/** Full years between `birthDate` (YYYY-MM-DD) and `today`, using UTC calendar dates. */
export function ageInYears(birthDate: string, today: Date = new Date()): number {
  const [y, m, d] = birthDate.split("-").map(Number) as [number, number, number];
  let age = today.getUTCFullYear() - y;
  const beforeBirthday =
    today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

/**
 * Development-only sign-in. The birth date is used for the age gate and never stored; the
 * server records only that the user confirmed they are 13 or older.
 */
export const DevLoginRequest = z.object({
  displayName: z.string().trim().min(1).max(40),
  birthDate: z.iso.date(),
});
export type DevLoginRequest = z.infer<typeof DevLoginRequest>;

export const PublicUser = z.object({
  id: z.string(),
  displayName: z.string(),
  avatarId: z.string().nullable(),
  createdAt: z.string(),
});
export type PublicUser = z.infer<typeof PublicUser>;

export const DevLoginResponse = z.object({
  token: z.string(),
  user: PublicUser,
});
export type DevLoginResponse = z.infer<typeof DevLoginResponse>;

/** Claims inside the session token issued by the API and accepted by the realm server. */
export const SessionClaims = z.object({
  sub: z.string(),
  name: z.string(),
  kind: z.enum(["user", "guest"]),
});
export type SessionClaims = z.infer<typeof SessionClaims>;

/** `GET /me`: the public profile plus the friend code others use to add you. */
export const MeResponse = PublicUser.extend({ friendCode: z.string() });
export type MeResponse = z.infer<typeof MeResponse>;

/**
 * `POST /auth/exchange`: trade a sign-in provider's session token (Clerk) for our session token.
 * The first time someone signs in, the API also needs their display name and birth date (the
 * provider doesn't collect birthdays); until it has them it answers "needs-profile".
 */
export const ExchangeRequest = z.object({
  providerToken: z.string().min(1),
  profile: z
    .object({
      displayName: z.string().trim().min(1).max(40),
      birthDate: z.iso.date(),
    })
    .optional(),
});
export type ExchangeRequest = z.infer<typeof ExchangeRequest>;

export const ExchangeResponse = z.discriminatedUnion("status", [
  DevLoginResponse.extend({ status: z.literal("signed-in") }),
  z.object({
    status: z.literal("needs-profile"),
    /** A display name to pre-fill, from the provider account. */
    suggestedName: z.string(),
  }),
]);
export type ExchangeResponse = z.infer<typeof ExchangeResponse>;
