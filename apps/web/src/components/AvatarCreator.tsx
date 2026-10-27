import { lazy, Suspense, useState } from "react";
import {
  applySelfie,
  CLOTHING_COLORS,
  EYE_COLORS,
  FORMAL_OUTFITS,
  HAIR_COLORS,
  randomRecipe,
  SKIN_TONES,
} from "@vcr/avatar";
import type { ExpressionWeights } from "@vcr/engine";
import {
  type AvatarRecipe,
  Bottom,
  type EmoteId,
  FacialHair,
  Glasses,
  HairStyle,
  Hat,
  Top,
} from "@vcr/protocol";
import { SelfieAssist } from "./SelfieAssist";

// three.js and the avatar runtime load only when someone opens the creator.
const AvatarPreview = lazy(() => import("../world/AvatarPreview"));

type Tab = "selfie" | "face" | "hair" | "body" | "outfit" | "extras";
const TABS: { id: Tab; label: string }[] = [
  { id: "selfie", label: "Selfie" },
  { id: "face", label: "Face" },
  { id: "hair", label: "Hair" },
  { id: "body", label: "Body" },
  { id: "outfit", label: "Outfit" },
  { id: "extras", label: "Extras" },
];

const LABELS: Record<string, string> = {
  bald: "Bald",
  buzz: "Buzz",
  short: "Short",
  swoop: "Swoop",
  curly: "Curly",
  bob: "Bob",
  long: "Long",
  ponytail: "Ponytail",
  bun: "Bun",
  afro: "Afro",
  none: "None",
  stubble: "Stubble",
  mustache: "Mustache",
  beard: "Beard",
  tee: "T-shirt",
  hoodie: "Hoodie",
  sweater: "Sweater",
  dress: "Dress",
  tuxedo: "Tuxedo",
  suit: "Suit",
  pants: "Pants",
  shorts: "Shorts",
  skirt: "Skirt",
  round: "Round",
  square: "Square",
  beanie: "Beanie",
  cap: "Cap",
};

const TRY_ON: { label: string; mood?: Partial<ExpressionWeights>; emote?: EmoteId }[] = [
  { label: "😀", mood: { happy: 1 } },
  { label: "😮", mood: { surprised: 1, oh: 0.6 } },
  { label: "😠", mood: { angry: 1 } },
  { label: "😢", mood: { sad: 1 } },
  { label: "😉", mood: { blinkLeft: 1, happy: 0.4 } },
  { label: "👋", emote: "wave" },
  { label: "💃", emote: "dance" },
];

export interface AvatarCreatorProps {
  initial: AvatarRecipe;
  title: string;
  intro?: string;
  saveLabel: string;
  onSave(recipe: AvatarRecipe): Promise<void> | void;
  /** "Cancel" or "Skip for now". */
  secondaryLabel?: string;
  onSecondary?(): void;
}

/**
 * The avatar creator (PLAN.md § 4.2): start from a selfie or "Surprise me", then refine with
 * swatches and sliders while a live preview shows the result.
 */
export function AvatarCreator(props: AvatarCreatorProps) {
  const [recipe, setRecipe] = useState(props.initial);
  const [tab, setTab] = useState<Tab>("selfie");
  const [selfieOpen, setSelfieOpen] = useState(false);
  const [mood, setMood] = useState<Partial<ExpressionWeights> | undefined>();
  const [emote, setEmote] = useState<{ id: EmoteId; at: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (patch: (r: AvatarRecipe) => AvatarRecipe) => {
    setRecipe(patch);
    setMood(undefined);
  };
  const face = (key: keyof AvatarRecipe["face"], value: number) =>
    update((r) => ({ ...r, face: { ...r.face, [key]: value } }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await props.onSave(recipe);
    } catch {
      setError("Couldn't save your avatar. Try again?");
      setSaving(false);
    }
  }

  return (
    <main className="creator">
      <section className="creator-preview">
        <Suspense fallback={<div className="world-loading">Loading preview…</div>}>
          <AvatarPreview
            recipe={recipe}
            mood={mood}
            emote={emote}
            focus={tab === "face" || tab === "selfie" ? "face" : "body"}
          />
        </Suspense>
        <div className="try-on" role="toolbar" aria-label="Try an expression">
          {TRY_ON.map((t) => (
            <button
              key={t.label}
              onClick={() => {
                if (t.emote) setEmote({ id: t.emote, at: performance.now() });
                setMood(t.mood);
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </section>

      <section className="creator-panel">
        <header>
          <h1>{props.title}</h1>
          {props.intro && <p className="muted">{props.intro}</p>}
        </header>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? "tab on" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        <div className="creator-controls">
          {tab === "selfie" &&
            (selfieOpen ? (
              <SelfieAssist
                onClose={() => setSelfieOpen(false)}
                onResult={(f, colors) => {
                  update((r) => applySelfie(r, f, colors));
                  setSelfieOpen(false);
                  setMood({ happy: 1 });
                  setTab("face");
                }}
              />
            ) : (
              <div className="start-options">
                <button onClick={() => setSelfieOpen(true)}>📸 Start from a selfie</button>
                <p className="hint">
                  Sets your face shape, skin, hair and eye colors from a photo. The photo never
                  leaves this device.
                </p>
                <button className="secondary" onClick={() => update(() => randomRecipe())}>
                  🎲 Surprise me
                </button>
              </div>
            ))}

          {tab === "face" && (
            <>
              <Swatches
                label="Skin"
                colors={SKIN_TONES}
                value={recipe.skin}
                onChange={(skin) => update((r) => ({ ...r, skin }))}
              />
              <Swatches
                label="Eyes"
                colors={EYE_COLORS}
                value={recipe.eyeColor}
                onChange={(eyeColor) => update((r) => ({ ...r, eyeColor }))}
              />
              <Slider
                label="Face width"
                value={recipe.face.width}
                onChange={(v) => face("width", v)}
              />
              <Slider
                label="Face length"
                value={recipe.face.length}
                onChange={(v) => face("length", v)}
              />
              <Slider
                label="Jaw"
                left="Narrow"
                right="Square"
                value={recipe.face.jaw}
                onChange={(v) => face("jaw", v)}
              />
              <Slider
                label="Eye size"
                value={recipe.face.eyeSize}
                onChange={(v) => face("eyeSize", v)}
              />
              <Slider
                label="Eye spacing"
                value={recipe.face.eyeSpacing}
                onChange={(v) => face("eyeSpacing", v)}
              />
              <Slider
                label="Nose"
                value={recipe.face.noseSize}
                onChange={(v) => face("noseSize", v)}
              />
              <Slider
                label="Mouth"
                value={recipe.face.mouthWidth}
                onChange={(v) => face("mouthWidth", v)}
              />
            </>
          )}

          {tab === "hair" && (
            <>
              <Choices
                label="Style"
                options={HairStyle.options}
                value={recipe.hair.style}
                onChange={(style) => update((r) => ({ ...r, hair: { ...r.hair, style } }))}
              />
              <Swatches
                label="Color"
                colors={HAIR_COLORS}
                value={recipe.hair.color}
                onChange={(color) => update((r) => ({ ...r, hair: { ...r.hair, color } }))}
              />
              <Choices
                label="Facial hair"
                options={FacialHair.options}
                value={recipe.facialHair}
                onChange={(facialHair) => update((r) => ({ ...r, facialHair }))}
              />
            </>
          )}

          {tab === "body" && (
            <>
              <Slider
                label="Height"
                left="Shorter"
                right="Taller"
                value={recipe.body.height}
                onChange={(height) => update((r) => ({ ...r, body: { ...r.body, height } }))}
              />
              <Slider
                label="Build"
                left="Slim"
                right="Broad"
                value={recipe.body.build}
                onChange={(build) => update((r) => ({ ...r, body: { ...r.body, build } }))}
              />
            </>
          )}

          {tab === "outfit" && (
            <>
              <fieldset className="field">
                <legend>Formal</legend>
                <div className="chips">
                  {(["tuxedo", "suit"] as const).map((look) => {
                    const on = recipe.outfit.top === look;
                    return (
                      <button
                        key={look}
                        className={`chip${on ? " on" : ""}`}
                        aria-pressed={on}
                        onClick={() =>
                          update((r) => ({ ...r, outfit: { ...FORMAL_OUTFITS[look] } }))
                        }
                      >
                        {look === "tuxedo" ? "🤵 Tuxedo" : "👔 Suit"}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <Choices
                label="Top"
                options={Top.options}
                value={recipe.outfit.top}
                onChange={(top) => update((r) => ({ ...r, outfit: { ...r.outfit, top } }))}
              />
              <Swatches
                label="Top color"
                colors={CLOTHING_COLORS}
                value={recipe.outfit.topColor}
                onChange={(topColor) =>
                  update((r) => ({ ...r, outfit: { ...r.outfit, topColor } }))
                }
              />
              {recipe.outfit.top !== "dress" && (
                <>
                  <Choices
                    label="Bottom"
                    options={Bottom.options}
                    value={recipe.outfit.bottom}
                    onChange={(bottom) =>
                      update((r) => ({ ...r, outfit: { ...r.outfit, bottom } }))
                    }
                  />
                  <Swatches
                    label="Bottom color"
                    colors={CLOTHING_COLORS}
                    value={recipe.outfit.bottomColor}
                    onChange={(bottomColor) =>
                      update((r) => ({ ...r, outfit: { ...r.outfit, bottomColor } }))
                    }
                  />
                </>
              )}
              <Swatches
                label="Shoes"
                colors={CLOTHING_COLORS}
                value={recipe.outfit.shoesColor}
                onChange={(shoesColor) =>
                  update((r) => ({ ...r, outfit: { ...r.outfit, shoesColor } }))
                }
              />
            </>
          )}

          {tab === "extras" && (
            <>
              <Choices
                label="Glasses"
                options={Glasses.options}
                value={recipe.glasses}
                onChange={(glasses) => update((r) => ({ ...r, glasses }))}
              />
              <Choices
                label="Hat"
                options={Hat.options}
                value={recipe.hat.style}
                onChange={(style) => update((r) => ({ ...r, hat: { ...r.hat, style } }))}
              />
              {recipe.hat.style !== "none" && (
                <Swatches
                  label="Hat color"
                  colors={CLOTHING_COLORS}
                  value={recipe.hat.color}
                  onChange={(color) => update((r) => ({ ...r, hat: { ...r.hat, color } }))}
                />
              )}
            </>
          )}
        </div>

        {error && <p className="error">{error}</p>}
        <footer className="row end">
          {props.onSecondary && (
            <button className="link" onClick={props.onSecondary}>
              {props.secondaryLabel ?? "Cancel"}
            </button>
          )}
          <button onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : props.saveLabel}
          </button>
        </footer>
      </section>
    </main>
  );
}

function Swatches(props: {
  label: string;
  colors: readonly string[];
  value: string;
  onChange(color: string): void;
}) {
  return (
    <fieldset className="field">
      <legend>{props.label}</legend>
      <div className="swatches">
        {props.colors.map((c) => (
          <button
            key={c}
            className={`swatch${c.toLowerCase() === props.value.toLowerCase() ? " on" : ""}`}
            style={{ background: c }}
            aria-label={`${props.label} ${c}`}
            aria-pressed={c.toLowerCase() === props.value.toLowerCase()}
            onClick={() => props.onChange(c)}
          />
        ))}
        <label className="swatch custom" title="Any color">
          <input
            type="color"
            value={props.value}
            onChange={(e) => props.onChange(e.target.value)}
            aria-label={`Custom ${props.label.toLowerCase()} color`}
          />
          +
        </label>
      </div>
    </fieldset>
  );
}

function Slider(props: {
  label: string;
  value: number;
  left?: string;
  right?: string;
  onChange(value: number): void;
}) {
  return (
    <label className="field slider">
      <span>{props.label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
      {(props.left || props.right) && (
        <span className="ends">
          <span>{props.left}</span>
          <span>{props.right}</span>
        </span>
      )}
    </label>
  );
}

function Choices<T extends string>(props: {
  label: string;
  options: readonly T[];
  value: T;
  onChange(value: T): void;
}) {
  return (
    <fieldset className="field">
      <legend>{props.label}</legend>
      <div className="chips">
        {props.options.map((o) => (
          <button
            key={o}
            className={`chip${o === props.value ? " on" : ""}`}
            aria-pressed={o === props.value}
            onClick={() => props.onChange(o)}
          >
            {LABELS[o] ?? o}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
