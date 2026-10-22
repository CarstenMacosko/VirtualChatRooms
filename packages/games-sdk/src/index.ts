/**
 * Mini-game plugin contract (PLAN.md § 5). Each game ships a server half, which runs inside the
 * realm session room with authoritative state, and a client half, mounted in the scene's
 * GameLayer. Nothing implements this yet; it exists so the realm and engine are built around it.
 *
 * Deliberately framework-free: `Component<P>` stands in for a React component so this package
 * has no React dependency.
 */

export type Component<P> = (props: P) => unknown;

export interface PlayerRef {
  /** Realm session id of the participant. */
  id: string;
  userId: string;
  name: string;
}

export interface GameContext {
  /** Realm session this game instance belongs to. */
  sessionId: string;
  /** Send a message to one player or to everyone in the game. */
  send(to: PlayerRef | "all", type: string, payload: unknown): void;
  /** End the game and report results to the session. */
  finish(result: { winners?: string[]; summary?: string }): void;
}

/** Binds an extra input while the game is active, mapped onto the engine's intent system. */
export interface IntentBinding {
  intent: string;
  label: string;
}

export interface GameSceneProps<S> {
  state: Readonly<S>;
  self: PlayerRef;
  send(type: string, payload: unknown): void;
}

export type GameHudProps<S> = GameSceneProps<S>;

export interface GameModule<S, M> {
  id: string;
  version: string;
  name: string;
  players: { min: number; max: number };
  server: {
    createState(ctx: GameContext): S;
    onJoin(state: S, player: PlayerRef): void;
    onLeave(state: S, player: PlayerRef): void;
    onMessage(state: S, player: PlayerRef, msg: M): void;
    /** Optional fixed-rate loop. */
    tick?(state: S, dtMs: number): void;
  };
  client: {
    /** 3D content, mounted in GameLayer. */
    Scene: Component<GameSceneProps<S>>;
    /** 2D overlay. */
    Hud?: Component<GameHudProps<S>>;
    /** Extra inputs while playing. */
    intents?: IntentBinding[];
  };
}

/** Identity helper that gives game authors type inference. */
export function defineGame<S, M>(game: GameModule<S, M>): GameModule<S, M> {
  return game;
}
