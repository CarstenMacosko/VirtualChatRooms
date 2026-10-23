import { z } from "zod";
import { Table, TableGame } from "./manifest";

/**
 * Table games over the realm (ADR 0021). These are envelopes: the realm reads `tableId` and the
 * game, and the game's own rules (@vcr/games) validate `options` and `action`. The realm doesn't
 * know the room's manifest, so it trusts table ids and sizes but bounds them.
 */

export const GameTableId = Table.shape.id;

/** Table-local meters. Tables are at most 10 m across (manifest `Table.size`). */
const TableCoordinate = z.number().finite().min(-10).max(10);

/** The most games one session hosts at once (a room has at most 16 tables, rooms.ts). */
export const MAX_GAME_TABLES = 16;

export const GameStartMessage = z.object({
  tableId: GameTableId,
  game: TableGame,
  /** The table's [width, depth] from the manifest, so the game can fit it. */
  size: Table.shape.size,
  options: z.unknown(),
});
export type GameStartMessage = z.infer<typeof GameStartMessage>;

export const GameActionMessage = z.object({ tableId: GameTableId, action: z.unknown() });
export type GameActionMessage = z.infer<typeof GameActionMessage>;

export const GameEndMessage = z.object({ tableId: GameTableId });
export type GameEndMessage = z.infer<typeof GameEndMessage>;

/** A live drag of a held item: relayed to everyone else, never stored. */
export const GameDragMessage = z.object({
  tableId: GameTableId,
  item: z.number().int().nonnegative().max(1023),
  x: TableCoordinate,
  z: TableCoordinate,
});
export type GameDragMessage = z.infer<typeof GameDragMessage>;

export const GameDragBroadcast = GameDragMessage.extend({
  /** Realm session id of whoever is dragging. */
  from: z.string(),
});
export type GameDragBroadcast = z.infer<typeof GameDragBroadcast>;

/** Clients send drags at most this often (and the realm allows ~40 messages a second). */
export const GAME_DRAG_HZ = 15;

/** Plain-object view of one table's game, as the client reads it from synced state. */
export interface GameTableView {
  /** `TableGame` id. */
  game: string;
  /** The game's setup (its rules' `encodeSetup`); changes only when a new game starts. */
  setup: string;
  /** Bumped on every change. */
  revision: number;
  items: Array<{ x: number; z: number; flags: number; heldBy: string }>;
}
