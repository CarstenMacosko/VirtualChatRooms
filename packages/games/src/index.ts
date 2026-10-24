import type { TableGameRules, TableGameState } from "@vcr/games-sdk";
import { jigsaw } from "./jigsaw/rules";

export * from "./jigsaw/edges";
export * from "./jigsaw/layout";
export * from "./jigsaw/rules";
export * from "./jigsaw/schema";
export * from "./random";

/** Rules for a game whose types the caller doesn't know (the realm hosts any of them). */
// oxlint-disable-next-line typescript/no-explicit-any -- erased on purpose; each game checks its own input
export type AnyTableGameRules = TableGameRules<any, any, any, TableGameState<any>>;

/** Every table game, by the id the manifest's `Table.games` uses. */
export const TABLE_GAMES: Record<string, AnyTableGameRules> = {
  [jigsaw.id]: jigsaw,
};
