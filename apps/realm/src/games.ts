import { type AnyTableGameRules, TABLE_GAMES } from "@vcr/games";
import {
  type GameActionMessage,
  type GameDragBroadcast,
  type GameDragMessage,
  type GameEndMessage,
  type GameStartMessage,
  MAX_GAME_TABLES,
} from "@vcr/protocol";
import { GameItem, GameTable, type SessionState } from "./state";

/** How often held items are checked for idling (each game decides how long is too long). */
export const GAME_TICK_MS = 5_000;

interface Hosted {
  rules: AnyTableGameRules;
  state: ReturnType<AnyTableGameRules["create"]>;
}

/**
 * Runs the games on a session's tables (ADR 0021). Each game's rules keep the authoritative state
 * (including server-only parts like when a piece was grabbed); after every change, the host
 * copies just the fields that changed into the synced `games` map, so a drop patches a few
 * bytes. Live drags are validated and handed back for relaying, never stored.
 */
export class TableGamesHost {
  private hosted = new Map<string, Hosted>();

  constructor(
    private readonly session: SessionState,
    private readonly random: () => number = Math.random,
  ) {}

  /** Starts a game on a table, replacing whatever was there. */
  start(message: GameStartMessage): boolean {
    const rules = TABLE_GAMES[message.game];
    if (!rules) return false;
    if (!this.hosted.has(message.tableId) && this.hosted.size >= MAX_GAME_TABLES) return false;
    const options = rules.parseOptions(message.options);
    if (options === null) return false;
    const state = rules.create(
      options,
      { size: message.size },
      Math.floor(this.random() * 2 ** 31),
    );
    this.hosted.set(message.tableId, { rules, state });
    this.session.games.set(
      message.tableId,
      new GameTable({ game: rules.id, setup: rules.encodeSetup(state.setup) }),
    );
    this.sync(message.tableId);
    return true;
  }

  act(player: string, message: GameActionMessage, now: number): boolean {
    const game = this.hosted.get(message.tableId);
    if (!game) return false;
    const action = game.rules.parseAction(message.action);
    if (action === null || !game.rules.apply(game.state, player, action, now)) return false;
    this.sync(message.tableId);
    return true;
  }

  /** The drag to relay to everyone else, or null if `player` isn't holding that item. */
  drag(player: string, message: GameDragMessage, now: number): GameDragBroadcast | null {
    const game = this.hosted.get(message.tableId);
    if (!game) return null;
    const at = game.rules.drag(game.state, player, message.item, message.x, message.z, now);
    return at && { tableId: message.tableId, item: message.item, ...at, from: player };
  }

  /** Clears a table back to "no game". */
  end(message: GameEndMessage): boolean {
    if (!this.hosted.delete(message.tableId)) return false;
    this.session.games.delete(message.tableId);
    return true;
  }

  /** Someone left the session: let go of whatever they were holding. */
  leave(player: string) {
    for (const [tableId, game] of this.hosted) {
      if (game.rules.leave(game.state, player)) this.sync(tableId);
    }
  }

  tick(now: number) {
    for (const [tableId, game] of this.hosted) {
      if (game.rules.tick(game.state, now)) this.sync(tableId);
    }
  }

  /** Copies changed items into the synced table; unchanged fields send nothing. */
  private sync(tableId: string) {
    const game = this.hosted.get(tableId);
    const table = this.session.games.get(tableId);
    if (!game || !table) return;
    const synced = table.items;
    const items = game.state.items;
    while (synced.length > items.length) synced.pop();
    items.forEach((item, i) => {
      const s = synced[i];
      if (!s) {
        synced.push(new GameItem(item));
        return;
      }
      if (s.x !== item.x) s.x = item.x;
      if (s.z !== item.z) s.z = item.z;
      if (s.flags !== item.flags) s.flags = item.flags;
      if (s.heldBy !== item.heldBy) s.heldBy = item.heldBy;
    });
    table.revision++;
  }
}
