import { describe, expect, it } from "vitest";
import { ClientMessages, RealmMessage } from "../src/realm";

describe("table game messages", () => {
  const start = ClientMessages[RealmMessage.gameStart];
  const drag = ClientMessages[RealmMessage.gameDrag];

  it("accepts a start for a known game on a table of a sensible size", () => {
    const message = {
      tableId: "coffee-table",
      game: "jigsaw",
      size: [1.2, 0.6],
      options: { picture: "sunset", pieces: 24 },
    };
    expect(start.parse(message)).toEqual(message);
  });

  it("rejects unknown games, bad table ids and impossible sizes", () => {
    const base = { tableId: "t", game: "jigsaw", size: [1, 1], options: {} };
    expect(start.safeParse({ ...base, game: "chess" }).success).toBe(false);
    expect(start.safeParse({ ...base, tableId: "" }).success).toBe(false);
    expect(start.safeParse({ ...base, tableId: "x".repeat(41) }).success).toBe(false);
    expect(start.safeParse({ ...base, size: [0, 1] }).success).toBe(false);
    expect(start.safeParse({ ...base, size: [50, 1] }).success).toBe(false);
  });

  it("bounds drag coordinates and item numbers", () => {
    const base = { tableId: "t", item: 3, x: 0.1, z: -0.2 };
    expect(drag.safeParse(base).success).toBe(true);
    expect(drag.safeParse({ ...base, x: 11 }).success).toBe(false);
    expect(drag.safeParse({ ...base, z: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(drag.safeParse({ ...base, item: -1 }).success).toBe(false);
    expect(drag.safeParse({ ...base, item: 1.5 }).success).toBe(false);
  });
});
