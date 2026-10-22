import type { Part, V3 } from "./mesh";

/**
 * Writes a VRM 1.0 file (a GLB with the VRMC_vrm and VRMC_materials_mtoon extensions) from
 * rigidly skinned parts. Runs in the browser and in Node, with no dependencies.
 */

export interface BoneSpec {
  name: string;
  parent: string | null;
  /** World position in the rest (T) pose. Bones carry no rest rotation. */
  at: V3;
}

export interface MaterialSpec {
  name: string;
  color: string;
  /** Toon shadow color; defaults to a darker, slightly warmer `color`. */
  shade?: string;
  /** Draw an ink outline (body, hair, clothes; not small face features). */
  outline?: boolean;
  doubleSided?: boolean;
}

export interface MeshSpec {
  name: string;
  parts: Part[];
  /** Morph target names, in order. Every primitive of the mesh gets all of them. */
  targets?: readonly string[];
}

/** VRM expression preset → morph targets (by mesh and target name) it drives. */
export type ExpressionSpec = Record<string, { mesh: string; target: string; weight: number }[]>;

export interface VrmSpec {
  name: string;
  bones: BoneSpec[];
  materials: MaterialSpec[];
  meshes: MeshSpec[];
  expressions: ExpressionSpec;
}

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const UNSIGNED_BYTE = 5121;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function linear(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255)) as [
    number,
    number,
    number,
  ];
}
function shadeOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const c = (v: number) => Math.round(Math.min(255, v)).toString(16).padStart(2, "0");
  // Darker, and pulled slightly toward warm red, which reads as friendly cartoon shading.
  return `#${c(r * 0.72 + 12)}${c(g * 0.62)}${c(b * 0.66)}`;
}

class BinaryWriter {
  chunks: Uint8Array[] = [];
  byteLength = 0;
  bufferViews: object[] = [];
  accessors: object[] = [];

  accessor(
    data: Float32Array | Uint16Array | Uint32Array | Uint8Array,
    componentType: number,
    type: string,
    count: number,
    target?: number,
    minMax?: { min: number[]; max: number[] },
  ): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const padding = (4 - (bytes.byteLength % 4)) % 4;
    this.bufferViews.push({
      buffer: 0,
      byteOffset: this.byteLength,
      byteLength: bytes.byteLength,
      ...(target && { target }),
    });
    this.chunks.push(bytes, new Uint8Array(padding));
    this.byteLength += bytes.byteLength + padding;
    this.accessors.push({
      bufferView: this.bufferViews.length - 1,
      componentType,
      type,
      count,
      ...minMax,
    });
    return this.accessors.length - 1;
  }

  vec3(values: number[], target?: number, bounds = true) {
    const count = values.length / 3;
    let minMax: { min: number[]; max: number[] } | undefined;
    if (bounds) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < values.length; i++) {
        min[i % 3] = Math.min(min[i % 3]!, values[i]!);
        max[i % 3] = Math.max(max[i % 3]!, values[i]!);
      }
      minMax = { min, max };
    }
    return this.accessor(new Float32Array(values), FLOAT, "VEC3", count, target, minMax);
  }
}

export function writeVrm(spec: VrmSpec): Uint8Array {
  const out = new BinaryWriter();
  const boneIndex = new Map(spec.bones.map((b, i) => [b.name, i]));
  const materialIndex = new Map(spec.materials.map((m, i) => [m.name, i]));

  const meshes = spec.meshes.map((mesh) => {
    const targets = mesh.targets ?? [];
    const primitives = spec.materials.flatMap((material) => {
      const parts = mesh.parts.filter((p) => p.material === material.name);
      if (parts.length === 0) return [];
      const positions: number[] = [];
      const normals: number[] = [];
      const joints: number[] = [];
      const indices: number[] = [];
      const deltas = targets.map(() => [] as number[]);
      for (const part of parts) {
        const base = positions.length / 3;
        const joint = boneIndex.get(part.bone);
        if (joint === undefined) throw new Error(`unknown bone ${part.bone}`);
        positions.push(...part.positions);
        normals.push(...part.normals);
        for (let i = 0; i < part.positions.length / 3; i++) joints.push(joint, 0, 0, 0);
        for (const i of part.indices) indices.push(i + base);
        targets.forEach((name, t) => {
          const d = part.morphs.get(name);
          deltas[t]!.push(...(d ?? new Array<number>(part.positions.length).fill(0)));
        });
      }
      const count = positions.length / 3;
      const weights = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) weights[i * 4] = 1; // rigid: one bone per vertex
      const big = count > 65535;
      return [
        {
          attributes: {
            POSITION: out.vec3(positions, ARRAY_BUFFER),
            NORMAL: out.vec3(normals, ARRAY_BUFFER, false),
            JOINTS_0: out.accessor(
              new Uint8Array(joints),
              UNSIGNED_BYTE,
              "VEC4",
              count,
              ARRAY_BUFFER,
            ),
            WEIGHTS_0: out.accessor(weights, FLOAT, "VEC4", count, ARRAY_BUFFER),
          },
          indices: out.accessor(
            big ? new Uint32Array(indices) : new Uint16Array(indices),
            big ? UNSIGNED_INT : UNSIGNED_SHORT,
            "SCALAR",
            indices.length,
            ELEMENT_ARRAY_BUFFER,
          ),
          material: materialIndex.get(material.name)!,
          ...(targets.length && {
            targets: deltas.map((d) => ({ POSITION: out.vec3(d, ARRAY_BUFFER) })),
          }),
        },
      ];
    });
    return {
      name: mesh.name,
      primitives,
      ...(targets.length && {
        weights: targets.map(() => 0),
        extras: { targetNames: [...targets] },
      }),
    };
  });

  // Inverse bind matrices: no rest rotations, so each is a translation by -position.
  const ibm = new Float32Array(spec.bones.length * 16);
  spec.bones.forEach((b, i) => {
    ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -b.at[0], -b.at[1], -b.at[2], 1], i * 16);
  });
  const ibmAccessor = out.accessor(ibm, FLOAT, "MAT4", spec.bones.length);

  const nodes: object[] = spec.bones.map((b) => {
    const parent = b.parent ? spec.bones[boneIndex.get(b.parent)!]!.at : ([0, 0, 0] as V3);
    const children = spec.bones.flatMap((c, i) => (c.parent === b.name ? [i] : []));
    return {
      name: b.name,
      translation: [b.at[0] - parent[0], b.at[1] - parent[1], b.at[2] - parent[2]],
      ...(children.length && { children }),
    };
  });
  const meshNodes = new Map<string, number>();
  spec.meshes.forEach((mesh, i) => {
    meshNodes.set(mesh.name, nodes.push({ name: mesh.name, mesh: i, skin: 0 }) - 1);
  });
  const root = boneIndex.get(spec.bones.find((b) => b.parent === null)!.name)!;
  const rootNode = nodes.push({ name: "Root", children: [root, ...meshNodes.values()] }) - 1;

  const expressions = Object.fromEntries(
    Object.entries(spec.expressions).map(([preset, binds]) => [
      preset,
      {
        isBinary: false,
        overrideBlink: "none",
        overrideLookAt: "none",
        overrideMouth: "none",
        morphTargetBinds: binds.map((b) => {
          const mesh = spec.meshes.find((m) => m.name === b.mesh);
          const index = mesh?.targets?.indexOf(b.target) ?? -1;
          if (index < 0) throw new Error(`unknown morph target ${b.mesh}.${b.target}`);
          return { node: meshNodes.get(b.mesh)!, index, weight: b.weight };
        }),
      },
    ]),
  );

  const gltf = {
    asset: { version: "2.0", generator: "VirtualChatRooms avatar generator" },
    extensionsUsed: ["VRMC_vrm", "VRMC_materials_mtoon"],
    scene: 0,
    scenes: [{ nodes: [rootNode] }],
    nodes,
    meshes,
    skins: [
      {
        joints: spec.bones.map((_, i) => i),
        inverseBindMatrices: ibmAccessor,
        skeleton: root,
      },
    ],
    materials: spec.materials.map((m) => ({
      name: m.name,
      doubleSided: m.doubleSided ?? false,
      pbrMetallicRoughness: {
        baseColorFactor: [...linear(m.color), 1],
        metallicFactor: 0,
        roughnessFactor: 0.9,
      },
      extensions: {
        VRMC_materials_mtoon: {
          specVersion: "1.0",
          shadeColorFactor: linear(m.shade ?? shadeOf(m.color)),
          shadingShiftFactor: -0.05,
          shadingToonyFactor: 0.92,
          giEqualizationFactor: 0.9,
          parametricRimColorFactor: [0.18, 0.18, 0.2],
          parametricRimFresnelPowerFactor: 4,
          parametricRimLiftFactor: 0.08,
          rimLightingMixFactor: 1,
          outlineWidthMode: m.outline ? "worldCoordinates" : "none",
          outlineWidthFactor: m.outline ? 0.0022 : 0,
          outlineColorFactor: [0.06, 0.05, 0.07],
          outlineLightingMixFactor: 1,
        },
      },
    })),
    accessors: out.accessors,
    bufferViews: out.bufferViews,
    buffers: [{ byteLength: out.byteLength }],
    extensions: {
      VRMC_vrm: {
        specVersion: "1.0",
        meta: {
          name: spec.name,
          version: "1",
          authors: ["VirtualChatRooms"],
          licenseUrl: "https://vrm.dev/licenses/1.0/",
          avatarPermission: "onlyAuthor",
          commercialUsage: "personalNonProfit",
          creditNotation: "unnecessary",
          allowRedistribution: false,
          modification: "prohibited",
          allowExcessivelyViolentUsage: false,
          allowExcessivelySexualUsage: false,
          allowPoliticalOrReligiousUsage: false,
          allowAntisocialOrHateUsage: false,
        },
        humanoid: {
          humanBones: Object.fromEntries(spec.bones.map((b, i) => [b.name, { node: i }])),
        },
        expressions: { preset: expressions },
      },
    },
  };

  const encoder = new TextEncoder();
  const json = encoder.encode(JSON.stringify(gltf));
  const jsonPadding = (4 - (json.byteLength % 4)) % 4;
  const binLength = out.byteLength;
  const total = 12 + 8 + json.byteLength + jsonPadding + 8 + binLength;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, json.byteLength + jsonPadding, true);
  view.setUint32(16, 0x4e4f534a, true); // JSON
  glb.set(json, 20);
  glb.fill(0x20, 20 + json.byteLength, 20 + json.byteLength + jsonPadding);
  let o = 20 + json.byteLength + jsonPadding;
  view.setUint32(o, binLength, true);
  view.setUint32(o + 4, 0x004e4942, true); // BIN
  o += 8;
  for (const chunk of out.chunks) {
    glb.set(chunk, o);
    o += chunk.byteLength;
  }
  return glb;
}
