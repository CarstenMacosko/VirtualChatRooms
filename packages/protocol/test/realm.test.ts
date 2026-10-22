import { describe, expect, it } from "vitest";
import { canModerate } from "../src/realm";

describe("canModerate", () => {
  it("lets the owner moderate everyone else", () => {
    expect(canModerate("owner", "cohost")).toBe(true);
    expect(canModerate("owner", "member")).toBe(true);
    expect(canModerate("owner", "guest")).toBe(true);
    expect(canModerate("owner", "owner")).toBe(false);
  });

  it("lets co-hosts moderate members and guests only", () => {
    expect(canModerate("cohost", "member")).toBe(true);
    expect(canModerate("cohost", "guest")).toBe(true);
    expect(canModerate("cohost", "cohost")).toBe(false);
    expect(canModerate("cohost", "owner")).toBe(false);
  });

  it("gives members and guests no host powers", () => {
    expect(canModerate("member", "guest")).toBe(false);
    expect(canModerate("guest", "member")).toBe(false);
  });
});
