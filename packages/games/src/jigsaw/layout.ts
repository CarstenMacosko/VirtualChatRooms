import { seededRandom, shuffle } from "../random";

/**
 * Where a puzzle sits on its table (table-local meters; see `TableFrame`). The board is centered
 * on the table, with room around it for the loose pieces. Row 0 (the top of the picture) is at
 * the board's -z edge.
 */

export const JIGSAW_PIECE_COUNTS = [24, 48, 96] as const;
export type JigsawPieceCount = (typeof JIGSAW_PIECE_COUNTS)[number];

/** Columns × rows for each piece count; cells are square, so this is also the picture's shape. */
const GRIDS: Record<JigsawPieceCount, [number, number]> = {
  24: [6, 4],
  48: [8, 6],
  96: [12, 8],
};

export function gridFor(pieces: JigsawPieceCount): { cols: number; rows: number } {
  const [cols, rows] = GRIDS[pieces];
  return { cols, rows };
}

/** The board takes at most this share of the table in each direction; loose pieces get the rest. */
const BOARD_SHARE = 0.66;
/** Pieces stay big enough to pick up on a phone, and small enough to look like a jigsaw. */
export const MIN_CELL = 0.03;
export const MAX_CELL = 0.12;

/** Side of a square cell (meters) so a cols × rows board fits a table of `size`. */
export function fitCell(size: readonly [number, number], cols: number, rows: number): number {
  const cell = Math.min((size[0] * BOARD_SHARE) / cols, (size[1] * BOARD_SHARE) / rows);
  return Math.min(MAX_CELL, Math.max(MIN_CELL, cell));
}

/** Where piece `index` belongs: its cell's center. */
export function correctSpot(
  index: number,
  cols: number,
  rows: number,
  cell: number,
): { x: number; z: number } {
  const c = index % cols;
  const r = Math.floor(index / cols);
  return { x: (c + 0.5 - cols / 2) * cell, z: (r + 0.5 - rows / 2) * cell };
}

/** Loose pieces lie on a grid of slots this many cells apart, so they rarely overlap. */
const SLOT = 1.2;
/** Clear space between the board and the nearest slot, in cells. */
const BOARD_GAP = 0.3;
/**
 * When the table is too small, the area for loose pieces grows past its edges by half a cell at
 * a time, up to this many times.
 */
const MAX_GROW_STEPS = 6;
/** Random nudge off each slot's center, as a share of the slot. */
const NUDGE = 0.12;
/** Before spilling past the table's edges, pieces may shrink to this share of `fitCell`. */
const MIN_SHRINK = 0.75;

/** Slot centers within half extents (hx, hz) that keep clear of a cols × rows board. */
function slotsAround(cols: number, rows: number, cell: number, hx: number, hz: number) {
  const slot = cell * SLOT;
  const boardX = (cols * cell) / 2 + cell * BOARD_GAP;
  const boardZ = (rows * cell) / 2 + cell * BOARD_GAP;
  const nx = Math.floor((2 * hx) / slot);
  const nz = Math.floor((2 * hz) / slot);
  const slots: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) {
      const x = (i + 0.5 - nx / 2) * slot;
      const z = (j + 0.5 - nz / 2) * slot;
      if (Math.abs(x) - slot / 2 >= boardX || Math.abs(z) - slot / 2 >= boardZ) {
        slots.push({ x, z });
      }
    }
  }
  return slots;
}

/**
 * The cell size for a puzzle on this table: as big as `fitCell` allows, shrunk a little if that
 * leaves the loose pieces no room on the table.
 */
export function planCell(size: readonly [number, number], cols: number, rows: number): number {
  const best = fitCell(size, cols, rows);
  for (let cell = best; cell >= best * MIN_SHRINK && cell >= MIN_CELL; cell *= 0.95) {
    if (slotsAround(cols, rows, cell, size[0] / 2, size[1] / 2).length >= cols * rows) return cell;
  }
  return best;
}

export interface Scatter {
  /** Starting position of each piece. */
  positions: Array<{ x: number; z: number }>;
  /** Half extents [x, z] of the area pieces may lie in: the table, plus any overflow. */
  bounds: [number, number];
}

/**
 * Deterministic starting positions around the board: slots on a grid over the table (past its
 * edges if it's small), minus those near the board, shuffled by `seed`.
 */
export function scatterPieces(
  seed: number,
  cols: number,
  rows: number,
  cell: number,
  table: readonly [number, number],
): Scatter {
  const random = seededRandom(seed);
  const count = cols * rows;
  const slot = cell * SLOT;
  let hx = Math.max(table[0] / 2, (cols * cell) / 2);
  let hz = Math.max(table[1] / 2, (rows * cell) / 2);
  let slots = slotsAround(cols, rows, cell, hx, hz);
  for (let step = 0; step < MAX_GROW_STEPS && slots.length < count; step++) {
    hx += cell / 2;
    hz += cell / 2;
    slots = slotsAround(cols, rows, cell, hx, hz);
  }
  shuffle(slots, random);

  const positions = Array.from({ length: count }, (_, i) => {
    const s = slots[i % slots.length]!;
    // Still short of slots (a tiny table): later pieces stack, offset, on earlier ones.
    const layer = Math.floor(i / slots.length);
    return {
      x: s.x + (random() * 2 - 1) * NUDGE * slot + layer * slot * 0.3,
      z: s.z + (random() * 2 - 1) * NUDGE * slot + layer * slot * 0.3,
    };
  });
  for (const p of positions) {
    p.x = Math.max(-hx, Math.min(hx, p.x));
    p.z = Math.max(-hz, Math.min(hz, p.z));
  }
  return { positions, bounds: [hx, hz] };
}
