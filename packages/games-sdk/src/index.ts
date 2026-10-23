/**
 * Table game contract (PLAN.md § 5, ADR 0021). A game has two halves:
 *
 * - **Rules**: pure TypeScript, no I/O. The realm runs them authoritatively (one instance per
 *   table), and clients run the same code to read the synced state and predict their own moves.
 * - **Client**: the 3D scene drawn on the table (mounted in the World's GameLayer) and an optional
 *   2D overlay while playing.
 *
 * Everything on a table is a `TableItem`: a jigsaw piece, a card, a token. The realm syncs items
 * field by field, so moving one piece patches a few bytes instead of resending the game. Whatever
 * doesn't change during play (the puzzle's seed and size, a deck's composition) is the game's
 * `setup`, synced once as a string.
 *
 * Deliberately framework-free: `Component<P>` stands in for a React component so this package
 * has no React dependency.
 */

export type Component<P> = (props: P) => unknown;

/** Something on a table everyone sees. Positions are table-local meters (see `TableFrame`). */
export interface TableItem {
  x: number;
  z: number;
  /** Game-defined bits, e.g. "snapped into place" or "face up". */
  flags: number;
  /** Realm session id of whoever is holding it; "" for nobody. */
  heldBy: string;
}

/** What the realm knows about a table: only its size, sent by whoever starts a game on it. */
export interface TableInfo {
  /** [width, depth] in meters, along the table's local X and Z. */
  size: [number, number];
}

/**
 * Where a table is in the room (manifest `Table`): `center` is the middle of the tabletop at its
 * surface, and table-local (x, z) maps to world `center + rotateY(yaw) · (x, 0, z)`.
 */
export interface TableFrame extends TableInfo {
  center: [number, number, number];
  yaw: number;
}

/** The authoritative state of one game on one table. Games may keep server-only fields too. */
export interface TableGameState<Setup> {
  setup: Setup;
  items: TableItem[];
}

/**
 * A game's rules. `apply`, `leave` and `tick` mutate `state` in place and return whether anything
 * the players see changed, so the host only syncs when it must.
 */
export interface TableGameRules<
  Setup,
  Options,
  Action,
  State extends TableGameState<Setup> = TableGameState<Setup>,
> {
  /** Matches the manifest's `TableGame`. */
  id: string;
  name: string;
  /** Bumped when the synced setup or item flags change meaning. */
  version: number;
  /** Validates what a client asked to start with; null if it isn't valid. */
  parseOptions(input: unknown): Options | null;
  /** A new game. `seed` makes everything random in it reproducible. */
  create(options: Options, table: TableInfo, seed: number): State;
  /** Validates a player's move; null if it isn't valid. */
  parseAction(input: unknown): Action | null;
  apply(state: State, player: string, action: Action, now: number): boolean;
  /**
   * A live drag of a held item, relayed to everyone else but not stored. Returns where to show
   * it (clamped to the table), or null when `player` isn't holding `item`.
   */
  drag(
    state: State,
    player: string,
    item: number,
    x: number,
    z: number,
    now: number,
  ): { x: number; z: number } | null;
  /** `player` left the session: let go of whatever they held. */
  leave(state: State, player: string): boolean;
  /** Called every few seconds, e.g. to let go of items held too long without moving. */
  tick(state: State, now: number): boolean;
  encodeSetup(setup: Setup): string;
  /** Reads a synced setup back on clients; null if it's from an incompatible version. */
  decodeSetup(json: string): Setup | null;
}

/** Who is holding an item, for outlines and name tags. */
export interface Holder {
  name: string;
  /** CSS color. */
  color: string;
}

/**
 * Pointer input on the tabletop while playing, already projected onto the table (table-local
 * meters). The host owns the camera: a press the game doesn't take pans the view instead.
 */
export interface TablePointer {
  /** Return true to take the gesture (e.g. a piece was grabbed). */
  down(x: number, z: number, touch: boolean): boolean;
  move(x: number, z: number): void;
  up(x: number, z: number): void;
  /** The gesture ended without a drop (pointer cancelled, view closed). */
  cancel(): void;
}

/** Props for a game's 3D scene, mounted once per table that offers the game. */
export interface TableSceneProps<Setup, Action> {
  table: TableFrame;
  /** Synced setup, or null when no game is running on the table. */
  setup: Setup | null;
  /** Synced items, updated in place as patches arrive; read them every frame. */
  items: readonly TableItem[];
  /** Bumped on every synced change. */
  revision: number;
  /** Realm session id of this client. */
  self: string;
  /** Whether this client is focused on the table (e.g. the puzzle view). */
  playing: boolean;
  /** Sends a move to the realm. */
  act(action: Action): void;
  /** Relays a live drag of a held item to everyone else; the host throttles it. */
  drag(item: number, x: number, z: number): void;
  /** Where someone else is dragging `item` right now, written into `out`; false if nobody is. */
  liveDrag(item: number, out: { x: number; z: number }): boolean;
  holder(id: string): Holder | null;
  /** Receives pointer input while playing; pass null to stop. */
  setPointer(pointer: TablePointer | null): void;
}

/** Props for a game's 2D overlay while playing. */
export type TableHudProps<Setup, Action> = Pick<
  TableSceneProps<Setup, Action>,
  "table" | "setup" | "items" | "revision" | "self" | "act" | "holder"
>;

/** Props for choosing how to start a game (e.g. which picture, how many pieces). */
export interface TableStartProps<Options> {
  table: TableFrame;
  start(options: Options): void;
  cancel(): void;
}

export interface TableGameClient<Setup, Options, Action> {
  /** 3D content on the tabletop, mounted in the GameLayer. */
  Scene: Component<TableSceneProps<Setup, Action>>;
  /** 2D overlay while playing. */
  Hud?: Component<TableHudProps<Setup, Action>>;
  Start: Component<TableStartProps<Options>>;
}

/** Rules plus client: everything one table game ships. */
export interface GameModule<
  Setup,
  Options,
  Action,
  State extends TableGameState<Setup> = TableGameState<Setup>,
> {
  rules: TableGameRules<Setup, Options, Action, State>;
  client: TableGameClient<Setup, Options, Action>;
}

/** Identity helper that gives game authors type inference. */
export function defineGame<Setup, Options, Action, State extends TableGameState<Setup>>(
  game: GameModule<Setup, Options, Action, State>,
): GameModule<Setup, Options, Action, State> {
  return game;
}
