import { TABLE_GAMES } from "@vcr/games";
import type { TableItem } from "@vcr/games-sdk";
import {
  GAME_DRAG_HZ,
  type GameDragBroadcast,
  type GameDragMessage,
  type GameStartMessage,
  type GameTableView,
  RealmMessage,
  type TableGame,
} from "@vcr/protocol";

/** Someone else dragging an item right now. */
export interface LiveDrag {
  x: number;
  z: number;
  from: string;
}

/** One table's game as this client sees it. */
export interface SyncedTable {
  game: string;
  /** Decoded by the game's rules; null if this client can't read it (an older or newer game). */
  setup: unknown;
  /** Updated in place as patches arrive, so the scene can read them every frame. */
  items: TableItem[];
  revision: number;
  /** Live drags by others, by item. */
  drags: Map<number, LiveDrag>;
}

type Send = (type: string, message: unknown) => void;

const DRAG_INTERVAL_MS = 1000 / GAME_DRAG_HZ;

/**
 * Table games' synced state, mirrored from the realm (ADR 0021), plus the messages that change
 * it. Items are patched in place and the 3D scene reads them every frame; React components
 * subscribe and re-render on each change (`useSyncExternalStore(subscribe, version)`).
 */
export class TableGamesSync {
  private tables = new Map<string, SyncedTable>();
  private setups = new Map<string, string>();
  private listeners = new Set<() => void>();
  private changes = 0;
  private send: Send | null = null;
  private lastDragAt = 0;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Changes whenever any table does. */
  readonly version = () => this.changes;

  table(tableId: string): SyncedTable | undefined {
    return this.tables.get(tableId);
  }

  connect(send: Send) {
    this.send = send;
  }

  /** Dropped from the realm: nothing is known until the next full state arrives. */
  disconnect() {
    this.send = null;
    this.tables.clear();
    this.setups.clear();
    this.notify();
  }

  /** Applies the realm's `games` map (plain JSON from the synced state). */
  ingest(games: Record<string, GameTableView> | undefined) {
    let changed = false;
    for (const id of this.tables.keys()) {
      if (games?.[id]) continue;
      this.tables.delete(id);
      this.setups.delete(id);
      changed = true;
    }
    for (const [id, view] of Object.entries(games ?? {})) {
      let table = this.tables.get(id);
      if (!table || table.game !== view.game || this.setups.get(id) !== view.setup) {
        table = {
          game: view.game,
          setup: TABLE_GAMES[view.game]?.decodeSetup(view.setup) ?? null,
          items: [],
          revision: -1,
          drags: new Map(),
        };
        this.tables.set(id, table);
        this.setups.set(id, view.setup);
      }
      if (table.revision === view.revision) continue;
      table.revision = view.revision;
      changed = true;
      const items = table.items;
      items.length = Math.min(items.length, view.items.length);
      view.items.forEach((v, i) => {
        const item = items[i];
        if (item) Object.assign(item, v);
        else items.push({ ...v });
      });
      // A drag ends when its holder lets go.
      for (const [item, drag] of table.drags) {
        if (items[item]?.heldBy !== drag.from) table.drags.delete(item);
      }
    }
    if (changed) this.notify();
  }

  ingestDrag(message: GameDragBroadcast) {
    const table = this.tables.get(message.tableId);
    if (!table) return;
    const drag = table.drags.get(message.item);
    if (drag) {
      drag.x = message.x;
      drag.z = message.z;
      drag.from = message.from;
    } else {
      table.drags.set(message.item, { x: message.x, z: message.z, from: message.from });
    }
  }

  start(tableId: string, game: TableGame, size: [number, number], options: unknown) {
    const message: GameStartMessage = { tableId, game, size, options };
    this.send?.(RealmMessage.gameStart, message);
  }

  act(tableId: string, action: unknown) {
    this.send?.(RealmMessage.gameAction, { tableId, action });
  }

  end(tableId: string) {
    this.send?.(RealmMessage.gameEnd, { tableId });
  }

  /** Relays a drag, at most GAME_DRAG_HZ times a second. */
  drag(tableId: string, item: number, x: number, z: number, now = performance.now()) {
    if (now - this.lastDragAt < DRAG_INTERVAL_MS) return;
    this.lastDragAt = now;
    const message: GameDragMessage = { tableId, item, x, z };
    this.send?.(RealmMessage.gameDrag, message);
  }

  private notify() {
    this.changes++;
    for (const listener of this.listeners) listener();
  }
}
