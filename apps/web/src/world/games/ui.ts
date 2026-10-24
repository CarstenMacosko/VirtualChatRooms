import type { Table } from "@vcr/protocol";
import type {
  Component,
  GameModule,
  TableFrame,
  TableHudProps,
  TableSceneProps,
  TableStartProps,
} from "@vcr/games-sdk";
import { type FC, useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";
import { TableFocus } from "./focus";
import { CLIENT_GAMES } from "./registry";

/** What the table games' 3D layer and their DOM overlay share, one per World. */
export interface TableGamesUiState {
  /** A game table within reach, if any. */
  near: string | null;
  /** The table this client is focused on ("puzzle view"). */
  playing: string | null;
  /** The table whose start form is open. */
  starting: string | null;
}

export function createTableGamesUi() {
  return {
    store: createStore<TableGamesUiState>(() => ({ near: null, playing: null, starting: null })),
    focus: new TableFocus(),
  };
}
export type TableGamesUi = ReturnType<typeof createTableGamesUi>;

/** A manifest table that offers a game this client can play. */
export interface PlayableTable {
  id: string;
  frame: TableFrame;
  game: string;
  // oxlint-disable-next-line typescript/no-explicit-any -- each game checks its own types
  module: GameModule<any, any, any, any>;
  // The module's components, typed for React.
  // oxlint-disable-next-line typescript/no-explicit-any -- as above
  Scene: FC<TableSceneProps<any, any>>;
  // oxlint-disable-next-line typescript/no-explicit-any -- as above
  Hud: FC<TableHudProps<any, any>> | null;
  // oxlint-disable-next-line typescript/no-explicit-any -- as above
  Start: FC<TableStartProps<any>>;
}

export function playableTables(tables: readonly Table[]): PlayableTable[] {
  return tables.flatMap((t) => {
    const game = t.games.find((id) => CLIENT_GAMES[id]);
    if (!game) return [];
    const frame: TableFrame = { center: t.center, yaw: t.yaw, size: t.size };
    const module = CLIENT_GAMES[game]!;
    const { Scene, Hud, Start } = module.client;
    return [
      {
        id: t.id,
        frame,
        game,
        module,
        Scene: asReact(Scene),
        Hud: Hud ? asReact(Hud) : null,
        Start: asReact(Start),
      },
    ];
  });
}

/** Within this distance of a table's center (or a meter past its corners) you can play. */
export const REACH = 1.8;

export function reachOf(frame: TableFrame) {
  return Math.max(REACH, Math.hypot(frame.size[0], frame.size[1]) / 2 + 1);
}

/** A stable color per person for the outline around what they're holding. */
export function holderColor(id: string) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(hash) % 360} 85% 58%)`;
}

/** Subscribes to one field of the shared UI state. */
export function useUi<K extends keyof TableGamesUiState>(ui: TableGamesUi, key: K) {
  return useSyncExternalStore(ui.store.subscribe, () => ui.store.getState()[key]);
}

/** A game's client component as React sees it (the SDK has no React dependency). */
export const asReact = <P>(component: Component<P>) => component as unknown as FC<P>;
