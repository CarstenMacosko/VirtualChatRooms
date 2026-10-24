import { describe, expect, it } from "vitest";
import {
  newSetupId,
  nextSeatId,
  rectFromCorners,
  resizeTableFromCorner,
  seatsAlongLine,
  tableCorners,
  TABLE_SIDE,
  turnYaw,
  walkwayBigEnough,
  yawTowards,
} from "../src/room/setupEdit";

describe("ids", () => {
  it("numbers new seats from 1, one past the highest", () => {
    expect(nextSeatId([])).toBe(1);
    expect(nextSeatId([{ id: 1 }, { id: 2 }])).toBe(3);
    expect(nextSeatId([{ id: 2 }, { id: 7 }])).toBe(8);
  });

  it("falls back to the lowest free seat id at the top of the range", () => {
    expect(nextSeatId([{ id: 0xffff }, { id: 1 }])).toBe(2);
  });

  it("makes short random table and walkway ids that don't collide", () => {
    const id = newSetupId();
    expect(id).toMatch(/^[a-z0-9]{8}$/);
    const taken = new Set<string>();
    for (let i = 0; i < 200; i++) taken.add(newSetupId(taken));
    expect(taken.size).toBe(200);
  });
});

describe("walkway rectangles", () => {
  it("normalizes a drag in any direction", () => {
    expect(rectFromCorners([2, -1], [-1, 3])).toEqual({ min: [-1, -1], max: [2, 3] });
  });

  it("stays inside the room", () => {
    const bounds = {
      min: [-3.6, 0, -6.64] as [number, number, number],
      max: [3.6, 2.7, 6.64] as [number, number, number],
    };
    expect(rectFromCorners([-5, 0], [1, 9], bounds)).toEqual({ min: [-3.6, 0], max: [1, 6.64] });
  });

  it("ignores taps", () => {
    expect(walkwayBigEnough({ min: [0, 0], max: [0.05, 2] })).toBe(false);
    expect(walkwayBigEnough({ min: [0, 0], max: [0.6, 2] })).toBe(true);
  });
});

describe("tables", () => {
  const table = {
    center: [1, 0.45, 2] as [number, number, number],
    yaw: 0,
    size: [0.9, 0.6] as [number, number],
  };

  it("finds the tabletop's corners, turned by yaw", () => {
    expect(tableCorners(table)).toEqual([
      [0.55, 1.7],
      [1.45, 1.7],
      [1.45, 2.3],
      [0.55, 2.3],
    ]);
    // A quarter turn: local X points along world −Z.
    const turned = tableCorners({ ...table, yaw: Math.PI / 2 });
    expect(turned[1]![0]).toBeCloseTo(0.7);
    expect(turned[1]![1]).toBeCloseTo(1.55);
  });

  it("resizes from a corner, keeping the opposite corner", () => {
    for (const yaw of [0, 0.7, -2.4]) {
      const t = { ...table, yaw };
      const before = tableCorners(t);
      const target = before[2]!.map((v, i) => v + (i === 0 ? 0.3 : 0.1)) as [number, number];
      const resized = { ...t, ...resizeTableFromCorner(t, 2, target) };
      const after = tableCorners(resized);
      expect(after[0]![0]).toBeCloseTo(before[0]![0]);
      expect(after[0]![1]).toBeCloseTo(before[0]![1]);
      expect(resized.center[1]).toBe(0.45);
    }
    // Unturned, dragging the (+,+) corner out by (0.3, 0.1) grows the table by that much.
    expect(resizeTableFromCorner(table, 2, [1.75, 2.4]).size.map((v) => +v.toFixed(6))).toEqual([
      1.2, 0.7,
    ]);
  });

  it("won't turn a table inside out or shrink it to nothing", () => {
    const { size } = resizeTableFromCorner(table, 2, [0, 0]);
    expect(size).toEqual([TABLE_SIDE.min, TABLE_SIDE.min]);
  });
});

describe("yaw", () => {
  it("faces from one point towards another (yaw 0 faces +Z)", () => {
    expect(yawTowards([0, 0], [0, 1])).toBeCloseTo(0);
    expect(yawTowards([0, 0], [1, 0])).toBeCloseTo(Math.PI / 2);
  });

  it("turns in 15° steps, snapping to the step", () => {
    const step = Math.PI / 12;
    expect(turnYaw(0, 15)).toBeCloseTo(step);
    expect(turnYaw(0, -15)).toBeCloseTo(-step);
    expect(turnYaw(0.1, 15)).toBeCloseTo(step);
    expect(turnYaw(0.1, -15)).toBeCloseTo(0);
    expect(turnYaw(Math.PI, 15)).toBeCloseTo(-Math.PI + step);
  });
});

describe("seats along a couch", () => {
  it("places one seat per 0.6 m, facing away from the couch towards the viewer", () => {
    const seats = seatsAlongLine([0, 0.45, 0], [1.8, 0.45, 0], [0.9, 3]);
    expect(seats).toHaveLength(3);
    expect(seats.map((s) => +s.position[0].toFixed(6))).toEqual([0.3, 0.9, 1.5]);
    seats.forEach((s) => {
      expect(s.position[1]).toBeCloseTo(0.45);
      expect(s.yaw).toBeCloseTo(0);
    });
    // Seen from the other side, they face −Z.
    expect(Math.abs(seatsAlongLine([0, 0.45, 0], [1.8, 0.45, 0], [0.9, -3])[0]!.yaw)).toBeCloseTo(
      Math.PI,
    );
  });

  it("makes at least one seat", () => {
    const [seat, ...rest] = seatsAlongLine([1, 0.4, 1], [1.1, 0.4, 1], [1, 5]);
    expect(rest).toHaveLength(0);
    expect(seat!.position[0]).toBeCloseTo(1.05);
  });
});
