import type { TableGameRules, TableGameState, TableItem } from "@vcr/games-sdk";
import { correctSpot, gridFor, planCell, scatterPieces } from "./layout";
import { JigsawAction, JigsawOptions, JigsawSetup } from "./schema";

/**
 * A shared jigsaw puzzle on a table (ADR 0021). Everyone around the table can pick up a loose
 * piece, one at a time; dropping it near where it belongs snaps it in, and snapped pieces stay.
 * Items are the pieces, in row-major order of where they belong.
 */

/** Item flag: snapped into its spot on the board. Snapped pieces can't be picked up again. */
export const PLACED = 1;

/** Drops this close to the right spot (a share of the cell) snap into place. */
export const SNAP_TOLERANCE = 0.35;

/** A held piece nobody has moved for this long is free for others to take. */
export const HOLD_IDLE_MS = 30_000;

export interface JigsawState extends TableGameState<JigsawSetup> {
  /** When each piece was last grabbed or dragged (server clock, ms); 0 when not held. */
  heldAt: number[];
}

export const isPlaced = (item: TableItem) => (item.flags & PLACED) !== 0;

export function placedCount(items: readonly TableItem[]): number {
  let n = 0;
  for (const item of items) if (isPlaced(item)) n++;
  return n;
}

export const isComplete = (items: readonly TableItem[]) =>
  items.length > 0 && placedCount(items) === items.length;

/** Whether a drop at (x, z) is close enough to piece `index`'s spot to snap. */
export function snapsAt(setup: JigsawSetup, index: number, x: number, z: number): boolean {
  const spot = correctSpot(index, setup.cols, setup.rows, setup.cell);
  return Math.hypot(x - spot.x, z - spot.z) <= SNAP_TOLERANCE * setup.cell;
}

export function clampToBounds(setup: JigsawSetup, x: number, z: number) {
  const [hx, hz] = setup.bounds;
  return { x: Math.max(-hx, Math.min(hx, x)), z: Math.max(-hz, Math.min(hz, z)) };
}

/** Whether `player` may pick up piece `index` right now. */
export function canGrab(state: JigsawState, player: string, index: number, now: number) {
  const item = state.items[index];
  if (!item || isPlaced(item)) return false;
  if (!item.heldBy || item.heldBy === player) return true;
  return now - (state.heldAt[index] ?? 0) > HOLD_IDLE_MS;
}

function letGo(state: JigsawState, index: number) {
  state.items[index]!.heldBy = "";
  state.heldAt[index] = 0;
}

export const jigsaw: TableGameRules<JigsawSetup, JigsawOptions, JigsawAction, JigsawState> = {
  id: "jigsaw",
  name: "Jigsaw puzzle",
  version: 1,

  parseOptions(input) {
    const parsed = JigsawOptions.safeParse(input);
    return parsed.success ? parsed.data : null;
  },

  create(options, table, seed) {
    const { cols, rows } = gridFor(options.pieces);
    const cell = planCell(table.size, cols, rows);
    const setupSeed = seed >>> 0;
    const scatter = scatterPieces(setupSeed, cols, rows, cell, table.size);
    return {
      setup: {
        seed: setupSeed,
        picture: options.picture,
        cols,
        rows,
        cell,
        bounds: scatter.bounds,
      },
      items: scatter.positions.map(({ x, z }) => ({ x, z, flags: 0, heldBy: "" })),
      heldAt: scatter.positions.map(() => 0),
    };
  },

  parseAction(input) {
    const parsed = JigsawAction.safeParse(input);
    return parsed.success ? parsed.data : null;
  },

  apply(state, player, action, now) {
    const item = state.items[action.piece];
    if (!item) return false;
    switch (action.type) {
      case "grab": {
        if (!canGrab(state, player, action.piece, now)) return false;
        // One piece at a time: picking up another puts the first one down where it was.
        state.items.forEach((other, i) => {
          if (other.heldBy === player && i !== action.piece) letGo(state, i);
        });
        item.heldBy = player;
        state.heldAt[action.piece] = now;
        return true;
      }
      case "drop": {
        if (item.heldBy !== player) return false;
        const at = clampToBounds(state.setup, action.x, action.z);
        if (snapsAt(state.setup, action.piece, at.x, at.z)) {
          const { cols, rows, cell } = state.setup;
          Object.assign(item, correctSpot(action.piece, cols, rows, cell));
          item.flags |= PLACED;
        } else {
          item.x = at.x;
          item.z = at.z;
        }
        letGo(state, action.piece);
        return true;
      }
      case "release": {
        if (item.heldBy !== player) return false;
        letGo(state, action.piece);
        return true;
      }
    }
  },

  drag(state, player, index, x, z, now) {
    const item = state.items[index];
    if (!item || item.heldBy !== player) return null;
    state.heldAt[index] = now;
    return clampToBounds(state.setup, x, z);
  },

  leave(state, player) {
    let changed = false;
    state.items.forEach((item, i) => {
      if (item.heldBy !== player) return;
      letGo(state, i);
      changed = true;
    });
    return changed;
  },

  tick(state, now) {
    let changed = false;
    state.items.forEach((item, i) => {
      if (!item.heldBy || now - (state.heldAt[i] ?? 0) <= HOLD_IDLE_MS) return;
      letGo(state, i);
      changed = true;
    });
    return changed;
  },

  encodeSetup(setup) {
    return JSON.stringify(setup);
  },

  decodeSetup(json) {
    try {
      const parsed = JigsawSetup.safeParse(JSON.parse(json));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  },
};
