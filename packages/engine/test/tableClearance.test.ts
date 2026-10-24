import { describe, expect, it } from "vitest";
import type { Table } from "@vcr/protocol";
import { CLEARANCE_HEIGHT, inClearance, tableClearances } from "../src/room/tableClearance";

const table = (games: Table["games"], yaw = 0): Table => ({
  id: "t",
  name: "",
  center: [1, 0.45, -2],
  yaw,
  size: [1.2, 0.6],
  source: "user",
  games,
});

describe("tableClearances", () => {
  it("clears only tables with a game on them", () => {
    expect(tableClearances([table([])])).toEqual([]);
    expect(tableClearances([table(["jigsaw"])])).toHaveLength(1);
  });

  it("hides clutter on the table but keeps the top and what's under it", () => {
    const [c] = tableClearances([table(["jigsaw"])]);
    expect(inClearance([1.5, 0.55, -1.8], c!)).toBe(true); // a vase near the corner
    expect(inClearance([1, 0.45, -2], c!)).toBe(false); // the table top itself
    expect(inClearance([1, 0.3, -2], c!)).toBe(false); // under the table
    expect(inClearance([1, 0.45 + CLEARANCE_HEIGHT + 0.1, -2], c!)).toBe(false); // a lamp shade above
    expect(inClearance([2, 0.6, -2], c!)).toBe(false); // beside the table
  });

  it("turns with the table", () => {
    // Turned a quarter: its 1.2 m side now runs along z.
    const [c] = tableClearances([table(["jigsaw"], Math.PI / 2)]);
    expect(inClearance([1, 0.6, -2 + 0.55], c!)).toBe(true);
    expect(inClearance([1 + 0.55, 0.6, -2], c!)).toBe(false);
  });
});
