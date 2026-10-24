import { describe, expect, it } from "vitest";
import { ClientMessages } from "@vcr/protocol";
import { claimSeat, releaseSeats } from "../src/seats";
import { SessionState } from "../src/state";

describe("seat claims", () => {
  it("seats one person per seat and one seat per person", () => {
    const { seats } = new SessionState();
    expect(claimSeat(seats, 3, "ann")).toBe(true);
    expect(claimSeat(seats, 3, "ann")).toBe(true); // asking again is fine
    expect(claimSeat(seats, 3, "bob")).toBe(false); // taken
    expect(seats.get("3")).toBe("ann");

    // Moving to another seat frees the first.
    expect(claimSeat(seats, 4, "ann")).toBe(true);
    expect(seats.get("3")).toBeUndefined();
    expect(claimSeat(seats, 3, "bob")).toBe(true);
    expect(Object.fromEntries(seats.entries())).toEqual({ 3: "bob", 4: "ann" });
  });

  it("frees the seat when its sitter stands up or leaves", () => {
    const { seats } = new SessionState();
    claimSeat(seats, 1, "ann");
    claimSeat(seats, 2, "bob");
    releaseSeats(seats, "ann");
    expect(seats.has("1")).toBe(false);
    expect(seats.get("2")).toBe("bob");
    releaseSeats(seats, "nobody");
    expect(seats.size).toBe(1);
  });

  it("accepts only seat ids a manifest can hold", () => {
    const sit = ClientMessages.sit;
    expect(sit.safeParse({ seatId: 0 }).success).toBe(true);
    expect(sit.safeParse({ seatId: 0xffff }).success).toBe(true);
    for (const seatId of [-1, 0x10000, 1.5, "2", null]) {
      expect(sit.safeParse({ seatId }).success).toBe(false);
    }
  });
});
