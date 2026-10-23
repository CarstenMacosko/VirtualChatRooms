import { describe, expect, it } from "vitest";
import {
  correctSpot,
  fitCell,
  flattenOutline,
  gridFor,
  HOLD_IDLE_MS,
  isComplete,
  isPlaced,
  jigsaw,
  JIGSAW_PIECE_COUNTS,
  type JigsawState,
  MAX_CELL,
  MIN_CELL,
  pieceOutline,
  planCell,
  placedCount,
  pointInPolygon,
  polygonArea,
  puzzleCuts,
  scatterPieces,
  SNAP_TOLERANCE,
  TABLE_GAMES,
} from "../src";

const SAMPLE_TABLE = { size: [1.2, 0.6] as [number, number] };
/** The real scan's small coffee table. */
const SMALL_TABLE = { size: [0.9, 0.5] as [number, number] };

const start = (pieces: 24 | 48 | 96 = 24, table = SAMPLE_TABLE, seed = 42): JigsawState =>
  jigsaw.create({ picture: "sunset", pieces }, table, seed);

describe("jigsaw layout", () => {
  it("uses a landscape grid of square cells for each piece count", () => {
    for (const n of JIGSAW_PIECE_COUNTS) {
      const { cols, rows } = gridFor(n);
      expect(cols * rows).toBe(n);
      expect(cols).toBeGreaterThan(rows);
    }
  });

  it("fits the board inside the table with room around it", () => {
    for (const n of JIGSAW_PIECE_COUNTS) {
      for (const table of [SAMPLE_TABLE, SMALL_TABLE]) {
        const { cols, rows } = gridFor(n);
        const cell = fitCell(table.size, cols, rows);
        expect(cols * cell).toBeLessThanOrEqual(table.size[0] * 0.66 + 1e-9);
        expect(rows * cell).toBeLessThanOrEqual(table.size[1] * 0.66 + 1e-9);
      }
    }
  });

  it("keeps pieces between a phone-friendly minimum and a sensible maximum", () => {
    expect(fitCell([0.3, 0.2], 12, 8)).toBe(MIN_CELL);
    expect(fitCell([4, 2], 6, 4)).toBe(MAX_CELL);
  });

  it("puts each piece's spot at its cell's center, row 0 at the board's -z edge", () => {
    const cell = 0.05;
    expect(correctSpot(0, 6, 4, cell)).toEqual({ x: -2.5 * cell, z: -1.5 * cell });
    expect(correctSpot(23, 6, 4, cell)).toEqual({ x: 2.5 * cell, z: 1.5 * cell });
    expect(correctSpot(7, 6, 4, cell)).toEqual({ x: -1.5 * cell, z: -0.5 * cell });
  });

  it("scatters pieces around the board, not on it, within the bounds", () => {
    for (const n of JIGSAW_PIECE_COUNTS) {
      for (const table of [SAMPLE_TABLE, SMALL_TABLE]) {
        const { cols, rows } = gridFor(n);
        const cell = fitCell(table.size, cols, rows);
        const { positions, bounds } = scatterPieces(7, cols, rows, cell, table.size);
        expect(positions).toHaveLength(n);
        for (const p of positions) {
          expect(Math.abs(p.x)).toBeLessThanOrEqual(bounds[0]);
          expect(Math.abs(p.z)).toBeLessThanOrEqual(bounds[1]);
          const onBoard =
            Math.abs(p.x) < (cols * cell) / 2 - cell * 0.2 &&
            Math.abs(p.z) < (rows * cell) / 2 - cell * 0.2;
          expect(onBoard).toBe(false);
        }
        // Spills past the table only a little, and only when it must.
        expect(bounds[0]).toBeLessThanOrEqual(table.size[0] / 2 + cell * 3 + 1e-9);
        expect(bounds[1]).toBeLessThanOrEqual(table.size[1] / 2 + cell * 3 + 1e-9);
      }
    }
  });

  it("shrinks pieces a little rather than spill past the table", () => {
    for (const n of JIGSAW_PIECE_COUNTS) {
      const { setup } = start(n);
      expect(setup.bounds).toEqual([0.6, 0.3]);
      const { cols, rows } = gridFor(n);
      expect(setup.cell).toBeLessThanOrEqual(fitCell(SAMPLE_TABLE.size, cols, rows));
      expect(setup.cell).toBeGreaterThanOrEqual(fitCell(SAMPLE_TABLE.size, cols, rows) * 0.75);
    }
  });

  it("gives 48 pieces on the small coffee table separate spots", () => {
    const { cols, rows } = gridFor(48);
    const cell = planCell(SMALL_TABLE.size, cols, rows);
    expect(cell).toBeGreaterThan(0.045); // big enough to see and grab
    const { positions } = scatterPieces(3, cols, rows, cell, SMALL_TABLE.size);
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i]!;
        const b = positions[j]!;
        expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(cell * 0.9);
      }
    }
  });

  it("is deterministic per seed", () => {
    expect(start(48, SAMPLE_TABLE, 5)).toEqual(start(48, SAMPLE_TABLE, 5));
    expect(start(48, SAMPLE_TABLE, 5).items).not.toEqual(start(48, SAMPLE_TABLE, 6).items);
  });
});

describe("jigsaw piece shapes", () => {
  it("are deterministic per seed", () => {
    expect(puzzleCuts(9, 8, 6)).toEqual(puzzleCuts(9, 8, 6));
    expect(puzzleCuts(9, 8, 6)).not.toEqual(puzzleCuts(10, 8, 6));
  });

  it("share every cut exactly with the neighbor", () => {
    const cols = 6;
    const rows = 4;
    const cuts = puzzleCuts(11, cols, rows);
    const global = (index: number) => {
      const c = index % cols;
      const r = Math.floor(index / cols);
      return flattenOutline(pieceOutline(cuts, index), 6).map(
        ([x, z]) => `${(x + c + 0.5).toFixed(6)},${(z + r + 0.5).toFixed(6)}`,
      );
    };
    // Points shared by a piece and its right neighbor (the cut between them) are identical.
    const a = new Set(global(0));
    const shared = global(1).filter((p) => a.has(p));
    expect(shared.length).toBeGreaterThanOrEqual(3 * 6);
    const below = new Set(global(cols));
    expect(global(0).filter((p) => below.has(p)).length).toBeGreaterThanOrEqual(3 * 6);
  });

  it("tile the board: the areas add up to the whole picture", () => {
    for (const [cols, rows] of [
      [6, 4],
      [12, 8],
    ] as const) {
      const cuts = puzzleCuts(3, cols, rows);
      let total = 0;
      for (let i = 0; i < cols * rows; i++) {
        const area = polygonArea(flattenOutline(pieceOutline(cuts, i), 24));
        expect(area).toBeGreaterThan(0.6); // clockwise, and no piece is mostly blanks
        expect(area).toBeLessThan(1.4);
        total += area;
      }
      expect(total).toBeCloseTo(cols * rows, 3);
    }
  });

  it("have straight outer edges and tabs or blanks inside", () => {
    const cuts = puzzleCuts(1, 6, 4);
    const corner = pieceOutline(cuts, 0);
    expect(corner.start).toEqual([-0.5, -0.5]);
    expect(corner.segments[0]).toEqual({ kind: "line", to: [0.5, -0.5] });
    expect(corner.segments.at(-1)).toEqual({ kind: "line", to: [-0.5, -0.5] });
    const middle = pieceOutline(cuts, 7);
    expect(middle.segments.every((s) => s.kind === "cubic")).toBe(true);
    expect(middle.segments).toHaveLength(12);
  });

  it("hit-test points inside the piece", () => {
    const polygon = flattenOutline(pieceOutline(puzzleCuts(2, 6, 4), 7));
    expect(pointInPolygon(polygon, 0, 0)).toBe(true);
    expect(pointInPolygon(polygon, 0.9, 0.9)).toBe(false);
  });
});

describe("jigsaw rules", () => {
  it("starts with every piece loose and nobody holding anything", () => {
    const state = start(24);
    expect(state.items).toHaveLength(24);
    expect(state.items.every((i) => !isPlaced(i) && i.heldBy === "")).toBe(true);
    expect(placedCount(state.items)).toBe(0);
    expect(isComplete(state.items)).toBe(false);
  });

  it("lets one player hold a piece; others can't take it until it idles", () => {
    const state = start();
    expect(jigsaw.apply(state, "ada", { type: "grab", piece: 3 }, 1000)).toBe(true);
    expect(state.items[3]!.heldBy).toBe("ada");
    expect(jigsaw.apply(state, "bo", { type: "grab", piece: 3 }, 2000)).toBe(false);
    expect(jigsaw.apply(state, "bo", { type: "drop", piece: 3, x: 0, z: 0 }, 2000)).toBe(false);
    expect(jigsaw.apply(state, "bo", { type: "grab", piece: 3 }, 1000 + HOLD_IDLE_MS + 1)).toBe(
      true,
    );
    expect(state.items[3]!.heldBy).toBe("bo");
  });

  it("holds one piece per player at a time", () => {
    const state = start();
    jigsaw.apply(state, "ada", { type: "grab", piece: 1 }, 0);
    jigsaw.apply(state, "ada", { type: "grab", piece: 2 }, 0);
    expect(state.items[1]!.heldBy).toBe("");
    expect(state.items[2]!.heldBy).toBe("ada");
  });

  it("drops a piece where it's let go, clamped to the bounds", () => {
    const state = start();
    const [hx, hz] = state.setup.bounds;
    jigsaw.apply(state, "ada", { type: "grab", piece: 0 }, 0);
    expect(jigsaw.apply(state, "ada", { type: "drop", piece: 0, x: 5, z: -5 }, 0)).toBe(true);
    expect(state.items[0]).toMatchObject({ x: hx, z: -hz, heldBy: "", flags: 0 });
  });

  it("snaps a piece dropped near its spot, and locks it", () => {
    const state = start();
    const { cols, rows, cell } = state.setup;
    const spot = correctSpot(5, cols, rows, cell);
    jigsaw.apply(state, "ada", { type: "grab", piece: 5 }, 0);
    const near = SNAP_TOLERANCE * cell * 0.9;
    jigsaw.apply(state, "ada", { type: "drop", piece: 5, x: spot.x + near, z: spot.z }, 0);
    expect(state.items[5]).toMatchObject({ ...spot, heldBy: "" });
    expect(isPlaced(state.items[5]!)).toBe(true);
    expect(jigsaw.apply(state, "bo", { type: "grab", piece: 5 }, 0)).toBe(false);
  });

  it("doesn't snap a piece dropped too far from its spot", () => {
    const state = start();
    const { cols, rows, cell } = state.setup;
    const spot = correctSpot(5, cols, rows, cell);
    jigsaw.apply(state, "ada", { type: "grab", piece: 5 }, 0);
    const far = SNAP_TOLERANCE * cell * 1.1;
    jigsaw.apply(state, "ada", { type: "drop", piece: 5, x: spot.x, z: spot.z + far }, 0);
    expect(isPlaced(state.items[5]!)).toBe(false);
    expect(state.items[5]!.z).toBeCloseTo(spot.z + far);
  });

  it("is complete when every piece is placed", () => {
    const state = start();
    const { cols, rows, cell } = state.setup;
    state.items.forEach((_, i) => {
      const spot = correctSpot(i, cols, rows, cell);
      jigsaw.apply(state, "ada", { type: "grab", piece: i }, 0);
      jigsaw.apply(state, "ada", { type: "drop", piece: i, ...spot }, 0);
    });
    expect(isComplete(state.items)).toBe(true);
  });

  it("relays drags only from the holder, clamped, and keeps the hold alive", () => {
    const state = start();
    jigsaw.apply(state, "ada", { type: "grab", piece: 0 }, 0);
    expect(jigsaw.drag(state, "bo", 0, 0, 0, 10)).toBeNull();
    expect(jigsaw.drag(state, "ada", 0, 99, 0, HOLD_IDLE_MS - 1)).toEqual({
      x: state.setup.bounds[0],
      z: 0,
    });
    // Dragging counts as activity: the hold doesn't expire 30 s after the grab.
    expect(jigsaw.tick(state, HOLD_IDLE_MS + 10)).toBe(false);
    expect(jigsaw.tick(state, 2 * HOLD_IDLE_MS)).toBe(true);
    expect(state.items[0]!.heldBy).toBe("");
    // A drag isn't stored.
    expect(state.items[0]!.x).not.toBe(state.setup.bounds[0]);
  });

  it("lets go of a leaver's pieces, and releases on request", () => {
    const state = start();
    jigsaw.apply(state, "ada", { type: "grab", piece: 0 }, 0);
    jigsaw.apply(state, "bo", { type: "grab", piece: 1 }, 0);
    expect(jigsaw.leave(state, "ada")).toBe(true);
    expect(jigsaw.leave(state, "ada")).toBe(false);
    expect(state.items[0]!.heldBy).toBe("");
    expect(jigsaw.apply(state, "ada", { type: "release", piece: 1 }, 0)).toBe(false);
    expect(jigsaw.apply(state, "bo", { type: "release", piece: 1 }, 0)).toBe(true);
    expect(state.items[1]!.heldBy).toBe("");
  });

  it("validates options and actions", () => {
    expect(jigsaw.parseOptions({ picture: "sunset", pieces: 48 })).toEqual({
      picture: "sunset",
      pieces: 48,
    });
    expect(jigsaw.parseOptions({ picture: "sunset", pieces: 50 })).toBeNull();
    expect(jigsaw.parseOptions({ picture: "https://example.com/a.jpg", pieces: 24 })).toBeNull();
    expect(jigsaw.parseAction({ type: "drop", piece: 1, x: 0, z: Number.NaN })).toBeNull();
    expect(jigsaw.parseAction({ type: "grab", piece: -1 })).toBeNull();
    expect(jigsaw.parseAction({ type: "spin", piece: 1 })).toBeNull();
    expect(jigsaw.parseAction({ type: "grab", piece: 2 })).toEqual({ type: "grab", piece: 2 });
    // Out-of-range pieces parse but do nothing.
    expect(jigsaw.apply(start(), "ada", { type: "grab", piece: 500 }, 0)).toBe(false);
  });

  it("round-trips the setup and rejects a garbled one", () => {
    const { setup } = start(96, SMALL_TABLE);
    expect(jigsaw.decodeSetup(jigsaw.encodeSetup(setup))).toEqual(setup);
    expect(jigsaw.decodeSetup("{")).toBeNull();
    expect(jigsaw.decodeSetup(JSON.stringify({ ...setup, cols: "x" }))).toBeNull();
  });

  it("is registered by its manifest id", () => {
    expect(TABLE_GAMES.jigsaw).toBe(jigsaw);
  });
});
