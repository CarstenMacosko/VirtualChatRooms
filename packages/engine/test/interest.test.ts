import { describe, expect, it } from "vitest";
import { orderTiles, selectAudible } from "../src/media/interest";

describe("selectAudible", () => {
  const listener = { x: 0, z: 0 };
  const at = (id: string, x: number, z = 0) => ({ id, x, z });

  it("keeps people within the radius", () => {
    const ids = selectAudible(listener, [at("near", 3), at("edge", 0, 20), at("far", 25)]);
    expect([...ids].sort()).toEqual(["edge", "near"]);
  });

  it("keeps only the nearest when the room is crowded", () => {
    const crowd = Array.from({ length: 30 }, (_, i) => at(`p${i}`, i * 0.5));
    const ids = selectAudible(listener, crowd, { maxCount: 5 });
    expect([...ids]).toEqual(["p0", "p1", "p2", "p3", "p4"]);
  });
});

describe("orderTiles", () => {
  const base = {
    selfId: "me",
    ids: ["me", "a", "b", "c", "d"],
    lastSpokeAt: new Map<string, number>(),
    distance: new Map([
      ["a", 8],
      ["b", 2],
      ["c", 5],
    ]),
    now: 100_000,
  };

  it("puts you first, then everyone nearest first, unknown distances last", () => {
    expect(orderTiles(base)).toEqual(["me", "b", "c", "a", "d"]);
  });

  it("puts recent speakers ahead of distance, most recent first", () => {
    const lastSpokeAt = new Map([
      ["a", 99_000],
      ["d", 95_000],
      ["c", 50_000], // too long ago to count
    ]);
    expect(orderTiles({ ...base, lastSpokeAt })).toEqual(["me", "a", "d", "b", "c"]);
  });

  it("puts the pinned person right after you", () => {
    const lastSpokeAt = new Map([["a", 99_000]]);
    expect(orderTiles({ ...base, lastSpokeAt, pinnedId: "c" })).toEqual(["me", "c", "a", "b", "d"]);
  });

  it("ignores a pin for someone who left", () => {
    expect(orderTiles({ ...base, pinnedId: "gone" })[1]).toBe("b");
  });
});
