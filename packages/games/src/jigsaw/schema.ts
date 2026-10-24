import { z } from "zod";
import { JIGSAW_PIECE_COUNTS } from "./layout";

/** What clients may send to a jigsaw, and its synced setup (see rules.ts). */

/**
 * Built-in pictures, drawn procedurally on each client (apps/web pictures.ts), so there is
 * nothing to download and nothing copyrighted. A host-uploaded photo would be another kind of
 * picture id here (e.g. "photo:<storage key>"), resolved to a signed URL on the client.
 */
export const JIGSAW_PICTURES = ["sunset", "fields", "mosaic", "starry"] as const;
export const JigsawPicture = z.enum(JIGSAW_PICTURES);
export type JigsawPicture = z.infer<typeof JigsawPicture>;

export const JigsawOptions = z.object({
  picture: JigsawPicture,
  pieces: z.union(JIGSAW_PIECE_COUNTS.map((n) => z.literal(n))),
});
export type JigsawOptions = z.infer<typeof JigsawOptions>;

const PieceIndex = z.number().int().nonnegative().max(1023);
const Coordinate = z.number().finite();

export const JigsawAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("grab"), piece: PieceIndex }),
  z.object({ type: z.literal("drop"), piece: PieceIndex, x: Coordinate, z: Coordinate }),
  /** Let go without moving it, e.g. leaving the puzzle view mid-drag. */
  z.object({ type: z.literal("release"), piece: PieceIndex }),
]);
export type JigsawAction = z.infer<typeof JigsawAction>;

/** What never changes during a puzzle; synced once. */
export const JigsawSetup = z.object({
  seed: z.number().int().nonnegative(),
  picture: JigsawPicture,
  cols: z.number().int().positive().max(32),
  rows: z.number().int().positive().max(32),
  /** Side of a square cell, meters. */
  cell: z.number().positive(),
  /** Half extents [x, z] of where pieces may lie (table-local meters). */
  bounds: z.tuple([z.number().positive(), z.number().positive()]),
});
export type JigsawSetup = z.infer<typeof JigsawSetup>;
