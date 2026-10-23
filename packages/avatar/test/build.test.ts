import { VRMLoaderPlugin, type VRM } from "@pixiv/three-vrm";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import {
  type AvatarRecipe,
  AvatarRecipe as RecipeSchema,
  Bottom,
  FacialHair,
  Glasses,
  HairStyle,
  Hat,
  Top,
} from "@vcr/protocol";
import { buildAvatarVrm, FACE_TARGETS } from "../src/build";
import { randomRecipe, recipeForSeed, seededRandom } from "../src/defaults";

interface Gltf {
  meshes: {
    name: string;
    primitives: { targets?: unknown[]; attributes: { POSITION: number } }[];
  }[];
  accessors: { count: number }[];
  extensions: {
    VRMC_vrm: {
      humanoid: { humanBones: Record<string, unknown> };
      expressions: { preset: Record<string, { morphTargetBinds: unknown[] }> };
    };
  };
}

function readGltf(glb: Uint8Array): Gltf {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  expect(view.getUint32(0, true)).toBe(0x46546c67);
  expect(view.getUint32(8, true)).toBe(glb.byteLength);
  const jsonLength = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Gltf;
}

const base = recipeForSeed("test");

/** One recipe per option of every choice, so every geometry path is built at least once. */
function everyOption(): AvatarRecipe[] {
  const out: AvatarRecipe[] = [];
  for (const style of HairStyle.options) out.push({ ...base, hair: { ...base.hair, style } });
  for (const facialHair of FacialHair.options) out.push({ ...base, facialHair });
  for (const top of Top.options)
    for (const bottom of Bottom.options) {
      out.push({ ...base, outfit: { ...base.outfit, top, bottom } });
    }
  for (const glasses of Glasses.options) out.push({ ...base, glasses });
  for (const style of Hat.options) out.push({ ...base, hat: { ...base.hat, style } });
  const extremes = [0, 1].map((v) => ({
    ...base,
    body: { height: v, build: v },
    face: { width: v, length: v, jaw: v, eyeSize: v, eyeSpacing: v, noseSize: v, mouthWidth: v },
  }));
  return [...out, ...extremes];
}

describe("buildAvatarVrm", () => {
  it("builds a valid VRM 1.0 for every option", () => {
    for (const recipe of everyOption()) {
      const gltf = readGltf(buildAvatarVrm(recipe));
      const vrm = gltf.extensions.VRMC_vrm;
      for (const bone of ["hips", "spine", "head", "leftHand", "rightFoot"]) {
        expect(vrm.humanoid.humanBones).toHaveProperty(bone);
      }
      const face = gltf.meshes.find((m) => m.name === "Face")!;
      for (const primitive of face.primitives) {
        expect(primitive.targets).toHaveLength(FACE_TARGETS.length);
      }
      for (const preset of ["blink", "blinkLeft", "aa", "happy", "surprised"]) {
        expect(vrm.expressions.preset[preset]?.morphTargetBinds.length).toBeGreaterThan(0);
      }
      const vertices = gltf.meshes
        .flatMap((m) => m.primitives)
        .reduce((n, p) => n + gltf.accessors[p.attributes.POSITION]!.count, 0);
      expect(vertices).toBeLessThan(40_000);
    }
  });

  it("is deterministic and small enough to rebuild on every client", () => {
    const a = buildAvatarVrm(base);
    const b = buildAvatarVrm(structuredClone(base));
    // Byte loop, not toEqual: deep-equal on ~2 MB of bytes takes seconds on CI.
    expect(a.byteLength).toBe(b.byteLength);
    expect(a.every((byte, i) => byte === b[i])).toBe(true);
    expect(a.byteLength).toBeLessThan(2_500_000);
  });

  it("loads with three-vrm, with working expressions", async () => {
    const glb = buildAvatarVrm({
      ...base,
      hair: { ...base.hair, style: "curly" },
      glasses: "round",
    });
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.parseAsync(glb.slice().buffer, "");
    const vrm = gltf.userData.vrm as VRM;
    expect(vrm.humanoid.getNormalizedBoneNode("head")).toBeTruthy();
    expect(vrm.humanoid.getNormalizedBoneNode("leftUpperArm")).toBeTruthy();
    const manager = vrm.expressionManager!;
    for (const name of ["blink", "aa", "happy", "angry", "sad", "surprised", "relaxed", "oh"]) {
      expect(manager.getExpression(name), name).toBeTruthy();
    }
    manager.setValue("happy", 1);
    expect(() => vrm.update(1 / 60)).not.toThrow();
  });
});

describe("recipes", () => {
  it("random recipes are valid and seeds are stable", () => {
    const random = seededRandom("many");
    for (let i = 0; i < 50; i++)
      expect(RecipeSchema.safeParse(randomRecipe(random)).success).toBe(true);
    expect(recipeForSeed("usr_1")).toEqual(recipeForSeed("usr_1"));
    expect(recipeForSeed("usr_1")).not.toEqual(recipeForSeed("usr_2"));
  });
});
