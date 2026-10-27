import { describe, expect, it } from "vitest";
import type { Table } from "@vcr/protocol";
import {
  inClearance,
  playSurfaces,
  roomClearances,
  SCREEN_BORDER,
  screenClearance,
  SURFACE_HEADROOM,
  surfaceClearance,
} from "../src/room/playSurface";

const TOP = 0.45;

const table = (games: Table["games"], yaw = 0): Table => ({
  id: "t",
  name: "",
  center: [1, TOP, -2],
  yaw,
  size: [1.2, 0.6],
  source: "user",
  games,
});

describe("play surfaces", () => {
  it("cover only tables with a game on them", () => {
    expect(playSurfaces([table([])])).toEqual([]);
    expect(roomClearances({ tables: [table([])] })).toEqual([]);
    expect(playSurfaces([table(["jigsaw"])])).toHaveLength(1);
  });

  it("sit just above the recorded tabletop, a little bigger than the table", () => {
    const [s] = playSurfaces([table(["jigsaw"])]);
    expect(s!.center[1]).toBeGreaterThan(TOP);
    expect(s!.center[1]).toBeLessThan(TOP + 0.03);
    expect(s!.size[0]).toBeGreaterThan(1.2);
    expect(s!.size[1]).toBeGreaterThan(0.6);
  });

  it("hide a bumpy scanned top, both just under and just over the recorded height", () => {
    const [c] = roomClearances({ tables: [table(["jigsaw"])] });
    // The band that used to show through the puzzle: between the board and the old clearance.
    expect(inClearance([1.2, TOP + 0.013, -2.1], c!)).toBe(true);
    expect(inClearance([1.2, TOP + 0.005, -2.1], c!)).toBe(true);
    expect(inClearance([1.2, TOP - 0.025, -2.1], c!)).toBe(true); // a dip in the scan
    expect(inClearance([1.5, TOP + 0.1, -1.8], c!)).toBe(true); // a vase near the corner
  });

  it("keep what's under, above, and beside the table", () => {
    const [s] = playSurfaces([table(["jigsaw"])]);
    const c = surfaceClearance(s!);
    expect(inClearance([1, TOP - 0.1, -2], c)).toBe(false); // under the table
    expect(inClearance([1, s!.center[1] + SURFACE_HEADROOM + 0.05, -2], c)).toBe(false); // a lamp
    expect(inClearance([2, TOP + 0.05, -2], c)).toBe(false); // beside the table
  });

  it("are solid wherever the scan is hidden below their top, so no hole shows from the side", () => {
    const [s] = playSurfaces([table(["jigsaw"])]);
    const c = surfaceClearance(s!);
    expect(c.center[1] - c.half[1]).toBeCloseTo(s!.center[1] - s!.thickness);
    expect(c.half[0] * 2).toBeCloseTo(s!.size[0]);
    expect(c.half[2] * 2).toBeCloseTo(s!.size[1]);
  });

  it("turn with the table", () => {
    // Turned a quarter: its 1.2 m side now runs along z.
    const [c] = roomClearances({ tables: [table(["jigsaw"], Math.PI / 2)] });
    expect(inClearance([1, TOP + 0.1, -2 + 0.55], c!)).toBe(true);
    expect(inClearance([1 + 0.55, TOP + 0.1, -2], c!)).toBe(false);
  });
});

describe("projector screen clearances", () => {
  // A 2 × 1.125 m screen on the east wall (x = 3), facing west (−X), 3 cm off the wall.
  const screen = {
    center: [2.97, 1.6, 0] as [number, number, number],
    yaw: -Math.PI / 2,
    size: [2, 1.125] as [number, number],
  };

  it("hide the wall behind the picture, bumps and all", () => {
    const c = screenClearance(screen);
    expect(inClearance([3.0, 1.6, 0], c)).toBe(true); // the wall
    expect(inClearance([3.04, 1.2, 0.8], c)).toBe(true); // a bump near a corner
    expect(inClearance([2.96, 1.6, 0], c)).toBe(true); // just in front of the face
  });

  it("keep the room in front, beside and behind it", () => {
    const c = screenClearance(screen);
    expect(inClearance([2.8, 1.6, 0], c)).toBe(false); // someone standing in front
    expect(inClearance([3.1, 1.6, 0], c)).toBe(false); // behind the wall
    expect(inClearance([3.0, 1.6, 1 + SCREEN_BORDER + 0.02], c)).toBe(false); // beside it
    expect(inClearance([3.0, 1.6 + 0.5625 + SCREEN_BORDER + 0.02, 0], c)).toBe(false); // above
  });

  it("join the tables' in the room's clearances", () => {
    expect(roomClearances({ tables: [], screens: [{ id: "s", ...screen }] })).toHaveLength(1);
  });
});
