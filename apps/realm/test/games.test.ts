import { Encoder } from "@colyseus/schema";
import { describe, expect, it } from "vitest";
import { correctSpot, HOLD_IDLE_MS, jigsaw, PLACED } from "@vcr/games";
import { type GameStartMessage, MAX_GAME_TABLES } from "@vcr/protocol";
import { TableGamesHost } from "../src/games";
import { SessionState } from "../src/state";

const startMessage = (tableId = "coffee-table", pieces = 24): GameStartMessage => ({
  tableId,
  game: "jigsaw",
  size: [1.2, 0.6],
  options: { picture: "sunset", pieces },
});

function setup() {
  const session = new SessionState();
  const host = new TableGamesHost(session, () => 0.5);
  return { session, host };
}

const encodedBytes = (encoder: Encoder<SessionState>) => {
  const bytes = encoder.encode().byteLength;
  encoder.discardChanges();
  return bytes;
};

describe("TableGamesHost", () => {
  it("starts a puzzle into synced state", () => {
    const { session, host } = setup();
    expect(host.start(startMessage())).toBe(true);
    const table = session.games.get("coffee-table")!;
    expect(table.game).toBe("jigsaw");
    expect(table.items).toHaveLength(24);
    const synced = jigsaw.decodeSetup(table.setup)!;
    expect(synced.picture).toBe("sunset");
    expect(synced.cols * synced.rows).toBe(24);
    expect(table.items.every((i) => i.heldBy === "" && i.flags === 0)).toBe(true);
  });

  it("refuses unknown options and too many tables", () => {
    const { host } = setup();
    expect(host.start({ ...startMessage(), options: { picture: "sunset", pieces: 7 } })).toBe(
      false,
    );
    for (let i = 0; i < MAX_GAME_TABLES; i++) expect(host.start(startMessage(`t${i}`))).toBe(true);
    expect(host.start(startMessage("one-too-many"))).toBe(false);
    // Restarting a table that already has a game is fine.
    expect(host.start(startMessage("t0", 48))).toBe(true);
  });

  it("applies grabs and drops from the holder only, and snaps", () => {
    const { session, host } = setup();
    host.start(startMessage());
    const table = session.games.get("coffee-table")!;
    const { cols, rows, cell } = jigsaw.decodeSetup(table.setup)!;
    const spot = correctSpot(2, cols, rows, cell);
    const act = (player: string, action: unknown) =>
      host.act(player, { tableId: "coffee-table", action }, 0);

    expect(act("ada", { type: "grab", piece: 2 })).toBe(true);
    expect(table.items[2]!.heldBy).toBe("ada");
    expect(act("bo", { type: "drop", piece: 2, ...spot })).toBe(false);
    expect(act("ada", { type: "teleport", piece: 2 })).toBe(false);
    expect(act("ada", { type: "drop", piece: 2, ...spot })).toBe(true);
    expect(table.items[2]).toMatchObject({ heldBy: "", flags: PLACED });
    expect(table.items[2]!.x).toBeCloseTo(spot.x);
    expect(host.act("ada", { tableId: "elsewhere", action: { type: "grab", piece: 0 } }, 0)).toBe(
      false,
    );
  });

  it("relays drags only from the holder, clamped to the table", () => {
    const { session, host } = setup();
    host.start(startMessage());
    host.act("ada", { tableId: "coffee-table", action: { type: "grab", piece: 0 } }, 0);
    const drag = { tableId: "coffee-table", item: 0, x: 9, z: 0.1 };
    expect(host.drag("bo", drag, 0)).toBeNull();
    expect(host.drag("ada", drag, 0)).toEqual({ ...drag, x: 0.6, from: "ada" });
    expect(host.drag("ada", { ...drag, tableId: "nope" }, 0)).toBeNull();
    // Not stored.
    expect(session.games.get("coffee-table")!.items[0]!.x).not.toBeCloseTo(0.6);
  });

  it("lets go of a leaver's pieces and idle holds", () => {
    const { session, host } = setup();
    host.start(startMessage());
    const items = session.games.get("coffee-table")!.items;
    host.act("ada", { tableId: "coffee-table", action: { type: "grab", piece: 0 } }, 0);
    host.act("bo", { tableId: "coffee-table", action: { type: "grab", piece: 1 } }, 0);
    host.leave("ada");
    expect(items[0]!.heldBy).toBe("");
    expect(items[1]!.heldBy).toBe("bo");
    host.tick(HOLD_IDLE_MS + 1);
    expect(items[1]!.heldBy).toBe("");
  });

  it("clears a table", () => {
    const { session, host } = setup();
    host.start(startMessage());
    expect(host.end({ tableId: "coffee-table" })).toBe(true);
    expect(session.games.has("coffee-table")).toBe(false);
    expect(host.end({ tableId: "coffee-table" })).toBe(false);
  });

  it("patches a few bytes per move, not the whole puzzle", () => {
    const { session, host } = setup();
    const encoder = new Encoder(session);
    host.start(startMessage("coffee-table", 96));
    const startBytes = encodedBytes(encoder);
    expect(startBytes).toBeGreaterThan(96 * 8);

    host.act("ada", { tableId: "coffee-table", action: { type: "grab", piece: 40 } }, 0);
    const grabBytes = encodedBytes(encoder);
    host.act(
      "ada",
      { tableId: "coffee-table", action: { type: "drop", piece: 40, x: 0.5, z: 0.2 } },
      0,
    );
    const dropBytes = encodedBytes(encoder);
    expect(grabBytes).toBeLessThan(40);
    expect(dropBytes).toBeLessThan(40);
    // A drag sends nothing through state.
    host.act("ada", { tableId: "coffee-table", action: { type: "grab", piece: 41 } }, 0);
    encodedBytes(encoder);
    host.drag("ada", { tableId: "coffee-table", item: 41, x: 0.1, z: 0.1 }, 0);
    expect(encoder.hasChanges).toBe(false);
  });
});
