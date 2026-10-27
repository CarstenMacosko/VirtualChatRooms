import { z } from "zod";

/**
 * An avatar is stored as a recipe: the creator's choices, not a mesh. Every client builds the
 * VRM from it (packages/avatar), so recipes stay tiny, travel in realm state, and avatars can be
 * regenerated when the base model improves (PLAN.md § 4.2). Bump the version for breaking changes
 * and migrate old recipes in `parseRecipe`.
 */

export const AVATAR_RECIPE_VERSION = 1;

const Hex = z.string().regex(/^#[0-9a-f]{6}$/i, "a color like #a1b2c3");
/** A slider value; 0.5 is average. */
const Unit = z.number().min(0).max(1);

export const HairStyle = z.enum([
  "bald",
  "buzz",
  "short",
  "swoop",
  "curly",
  "bob",
  "long",
  "ponytail",
  "bun",
  "afro",
]);
export type HairStyle = z.infer<typeof HairStyle>;
export const FacialHair = z.enum(["none", "stubble", "mustache", "beard"]);
/** Tops; "tuxedo" and "suit" are the formal jackets (a dinner jacket with a bow tie, a suit). */
export const Top = z.enum(["tee", "hoodie", "sweater", "dress", "tuxedo", "suit"]);
export const Bottom = z.enum(["pants", "shorts", "skirt"]);
export const Glasses = z.enum(["none", "round", "square"]);
export const Hat = z.enum(["none", "beanie", "cap"]);

export const AvatarRecipe = z.object({
  version: z.literal(AVATAR_RECIPE_VERSION),
  body: z.object({ height: Unit, build: Unit }),
  skin: Hex,
  face: z.object({
    width: Unit,
    length: Unit,
    jaw: Unit,
    eyeSize: Unit,
    eyeSpacing: Unit,
    noseSize: Unit,
    mouthWidth: Unit,
  }),
  eyeColor: Hex,
  hair: z.object({ style: HairStyle, color: Hex }),
  facialHair: FacialHair,
  outfit: z.object({
    top: Top,
    topColor: Hex,
    bottom: Bottom,
    bottomColor: Hex,
    shoesColor: Hex,
  }),
  glasses: Glasses,
  hat: z.object({ style: Hat, color: Hex }),
});
export type AvatarRecipe = z.infer<typeof AvatarRecipe>;

/** A recipe from storage or the network, or null if it's missing or from an unknown version. */
export function parseRecipe(value: unknown): AvatarRecipe | null {
  const raw = typeof value === "string" ? safeJson(value) : value;
  const parsed = AvatarRecipe.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `GET /me/avatar` and `PUT /me/avatar`. */
export const AvatarResponse = z.object({ recipe: AvatarRecipe.nullable() });
export type AvatarResponse = z.infer<typeof AvatarResponse>;
export const SaveAvatarRequest = z.object({ recipe: AvatarRecipe });
