import { isComplete, jigsaw, placedCount } from "@vcr/games";
import { defineGame, type GameModule } from "@vcr/games-sdk";
import { JigsawScene } from "./jigsaw/JigsawScene";
import { JigsawHud, JigsawStart } from "./jigsaw/JigsawUi";

/** The jigsaw: rules from @vcr/games, drawn on the tabletop (ADR 0021). */
export const JIGSAW_GAME = defineGame({
  rules: jigsaw,
  client: {
    noun: "puzzle",
    Scene: JigsawScene,
    Hud: JigsawHud,
    Start: JigsawStart,
    status: (_setup, items) =>
      isComplete(items) ? "Finished!" : `${placedCount(items)} of ${items.length} pieces in place`,
    viewArea: (setup) => ({ bounds: setup.bounds, piece: setup.cell }),
  },
});

/** Client halves of every table game, by manifest `TableGame` id. */
// oxlint-disable-next-line typescript/no-explicit-any -- each game's own types are checked above
export const CLIENT_GAMES: Record<string, GameModule<any, any, any, any>> = {
  jigsaw: JIGSAW_GAME,
};
