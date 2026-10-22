import { describe, expect, it } from "vitest";
import { ageInYears, DevLoginRequest } from "../src/auth";

describe("ageInYears", () => {
  const today = new Date(Date.UTC(2026, 9, 21)); // 2026-10-21

  it("counts a birthday today as a full year", () => {
    expect(ageInYears("2013-10-21", today)).toBe(13);
  });

  it("does not count a birthday later this year", () => {
    expect(ageInYears("2013-10-22", today)).toBe(12);
    expect(ageInYears("2013-11-01", today)).toBe(12);
  });

  it("handles leap-day birthdays", () => {
    expect(ageInYears("2012-02-29", new Date(Date.UTC(2025, 1, 28)))).toBe(12);
    expect(ageInYears("2012-02-29", new Date(Date.UTC(2025, 2, 1)))).toBe(13);
  });
});

describe("DevLoginRequest", () => {
  it("trims names and requires an ISO date", () => {
    expect(DevLoginRequest.parse({ displayName: "  Ada ", birthDate: "1990-01-01" })).toEqual({
      displayName: "Ada",
      birthDate: "1990-01-01",
    });
    expect(DevLoginRequest.safeParse({ displayName: "Ada", birthDate: "01/01/1990" }).success).toBe(
      false,
    );
    expect(DevLoginRequest.safeParse({ displayName: "   ", birthDate: "1990-01-01" }).success).toBe(
      false,
    );
  });
});

describe("ExchangeRequest", () => {
  it("takes a provider token, with an optional first-time profile", async () => {
    const { ExchangeRequest } = await import("../src/auth");
    expect(ExchangeRequest.safeParse({ providerToken: "t" }).success).toBe(true);
    expect(
      ExchangeRequest.safeParse({
        providerToken: "t",
        profile: { displayName: "Ada", birthDate: "1990-01-01" },
      }).success,
    ).toBe(true);
    expect(
      ExchangeRequest.safeParse({
        providerToken: "t",
        profile: { displayName: "", birthDate: "x" },
      }).success,
    ).toBe(false);
  });
});
