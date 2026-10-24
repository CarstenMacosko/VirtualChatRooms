# ADR 0021: Table games, starting with a shared jigsaw

- **Status:** Accepted
- **Date:** 2026-10-23
- **Plan reference:** [PLAN.md § 5, Mini-games](../../PLAN.md#5-future-proofing-seams-built-into-the-mvp) and [§ 3.5 GameLayer](../../PLAN.md#35-client-engine-layers-packagesengine)

## Context

The room setup manifest marks tables that offer games (`Table.games`, currently only `"jigsaw"`). The first game is a jigsaw puzzle that everyone at the gathering shares. It has to look right on any table: the coffee table in the first real scan may be only 0.9 × 0.5 m. It also has to stay smooth on phones with 96 pieces and sync without flooding the realm. PLAN.md's games SDK sketch (`server.onMessage`, `client.Scene`) predates the manifest's tables and seats, so this ADR settles what a game on a table actually is.

## Decision

**A table game is a set of rules plus a client, joined by a small shared contract (`@vcr/games-sdk`).**

- **Rules** (`@vcr/games`, plain TypeScript with no React or Colyseus) are what the realm runs and what clients use for prediction. They're defined by `TableGameRules`: `parseOptions`, `create(options, table, seed)`, `parseAction`, `apply`, `drag`, `leave` and `tick`, plus `encodeSetup` and `decodeSetup`. A game's state is a fixed **setup** (seed, grid and anything else fixed at the start) and a list of **items**, each `{x, z, flags, heldBy}` in table-local meters.
- **The client** (`apps/web/src/world/games`) provides a `Scene` (3D, drawn at every table for everyone), an optional `Hud`, a `Start` form, a one-line `status` for the prompt, and `viewArea`, which tells the puzzle view's camera what to fit.
- A game is registered on both sides by `id`. In the realm that's `TABLE_GAMES`; in the client it's `CLIENT_GAMES`.

**The realm hosts one game per table, keyed by the manifest's table id.**

- `SessionState.games` is a `MapSchema<GameTable{game, setup, revision, items}>`. The setup is synced once as a JSON string. Items are synced field by field, so a drop patches a few bytes; a test checks that a grab or drop stays under 40 bytes.
- `gameStart`, `gameAction` and `gameEnd` are authoritative and zod-validated. The envelope is checked by protocol; the game's own parsers check the payload. Anyone at the gathering can start, replace or clear a table's game. Like the rest of the room, it's a shared space.
- `gameDrag` is transient. The rules check that the sender holds the item and clamp the position. The realm then relays it to everyone else and stores nothing. Clients throttle drags to 15 Hz, which stays well inside the realm's 40 messages per second per client.
- Holds end when the holder drops the piece or leaves the session. A tick every 5 s lets the rules expire holds idle for 30 s, and anyone may take an idle piece.
- The realm never reads the room manifest. The client sends the table's size with `gameStart`, bounded by `Table.size`. A client that lies about the size only gets a strangely laid-out puzzle on that table.

**Jigsaw specifics.**

- Edges use the classic three-cubic tab curve with seeded jitter. Each cut is shared exactly between its two neighbors, so pieces fit.
- The board is sized to the table: about two thirds of it, cells from 3 to 12 cm. Loose pieces are scattered around the board. On a small table the pieces shrink (down to 0.75×) before they're allowed past the table's edge. At 48 pieces on 0.9 × 0.5 m, cells are 5 cm.
- Each player holds at most one piece. A piece dropped within 35% of a cell of its home snaps there and locks.
- Pictures are procedural canvases (sunset, fields, mosaic, starry), seeded by name, so nothing copyrighted ships and nothing downloads. A picture id is a string, which leaves room for `photo:<key>` later.
- Each piece is one small extruded mesh sharing one material: 96 draw calls, at a few hundred triangles each. Low-power devices get fewer curve segments and a 1024 px picture instead of 2048.

**The puzzle view.**

- Within reach of a table (about 1.8 m, more for big tables), a chip offers "Play puzzle" or "Start puzzle".
- Playing hands the camera to a `CameraFocus`. It blends from the follow camera to a view from your side of the table, looking down, and while active the World uses empty intents (no movement or look).
- Pointer and touch drags on the canvas are raycast onto the tabletop. A drag on a piece moves it; a drag on empty table pans; wheel and the ± buttons zoom. Esc or Back leaves, and so does walking away.
- No keys are bound (in particular not E).
- Other players' held pieces show a colored outline and their name, and a finished puzzle turns the board gold with confetti.

## How a card game would plug in

The contract was shaped so that a free-form card table fits without realm changes:

- **Items are cards.** `x` and `z` are the card's spot on the table, `heldBy` is who is dragging it, and `flags` holds face-up and, if needed, rotated. Moving and flipping are `apply` actions, and dragging reuses `gameDrag` unchanged.
- **The setup is the deck:** seed and deck type. The shuffled order comes from the seed, so the setup stays small. A "shuffle the pile" action reseeds the setup.
- **Stacking order:** add an `order` (or `pile`) number to items. That is one new field on `GameItem`, synced like the others, and the only schema change a card game needs.
- **Private hands are the real difference.** A jigsaw has no secrets; a card game does. Everything in `games` is visible to every client, so cards in a hand can't live there in the clear. The options are Colyseus 0.16+ `StateView`, which filters per client and works with `@view()` fields on a per-player hand collection, or sending each hand privately with `client.send` and syncing only a count. Either way, face-down cards on the table should carry no face value in synced state, only an index the server resolves when the card turns over.
- The client side is a new `Scene`, `Hud` and `Start`, plus `CLIENT_GAMES` and `TABLE_GAMES` entries and a manifest `TableGame` enum value.

## Consequences

- Games are testable without a server or a browser. The rules have unit tests, and the realm host is tested against the real schema encoder.
- Every table's game is visible from anywhere in the room. That is a cost (meshes and state for every table) we accept while rooms have a handful of tables. Distant tables could later render a lower-detail version.
- The realm keeps the authoritative state in the rules' own objects and mirrors it into the schema. That doubles a tiny amount of memory and keeps server-only fields, like grab times, out of the synced state.
- Clients predict their own drops and show them right away, then settle on the realm's answer. A grab with no answer in 1.5 s is dropped.
- Anyone can clear or replace a puzzle. The HUD asks twice before clearing. If that becomes a problem, host-only clearing is a one-line check in the realm.
