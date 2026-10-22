/**
 * Writes apps/web/public/avatars/placeholder.vrm: a small, stylized mannequin built from boxes and
 * spheres, rigged with the VRM 1.0 humanoid skeleton. We generate it instead of shipping a
 * third-party model so its license is ours (CC0) and the file stays tiny. Real avatars from the
 * Phase 3 creator replace it; both load through the same three-vrm path.
 *
 * Run: pnpm tsx scripts/generate-placeholder-avatar.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";

type V3 = [number, number, number];

// --- skeleton (VRM 1.0: faces +Z, Y up, T-pose, no rest rotations) ---------------------------

interface Bone {
  name: string;
  parent: string | null;
  at: V3; // world position
}

const mirror = (b: Bone): Bone => ({
  name: b.name.replace("left", "right"),
  parent: b.parent?.replace("left", "right") ?? null,
  at: [-b.at[0], b.at[1], b.at[2]],
});

const LEFT: Bone[] = [
  { name: "leftUpperArm", parent: "chest", at: [0.19, 1.36, 0] },
  { name: "leftLowerArm", parent: "leftUpperArm", at: [0.44, 1.36, 0] },
  { name: "leftHand", parent: "leftLowerArm", at: [0.67, 1.36, 0] },
  { name: "leftUpperLeg", parent: "hips", at: [0.09, 0.82, 0] },
  { name: "leftLowerLeg", parent: "leftUpperLeg", at: [0.09, 0.46, 0] },
  { name: "leftFoot", parent: "leftLowerLeg", at: [0.09, 0.08, 0] },
];

const BONES: Bone[] = [
  { name: "hips", parent: null, at: [0, 0.86, 0] },
  { name: "spine", parent: "hips", at: [0, 0.97, 0] },
  { name: "chest", parent: "spine", at: [0, 1.17, 0] },
  { name: "neck", parent: "chest", at: [0, 1.4, 0] },
  { name: "head", parent: "neck", at: [0, 1.47, 0] },
  ...LEFT,
  ...LEFT.map(mirror),
];
const boneIndex = new Map(BONES.map((b, i) => [b.name, i]));

// --- materials ----------------------------------------------------------------------------

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const hex = (h: string): [number, number, number, number] => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => srgbToLinear(v / 255)).concat(1) as [
    number,
    number,
    number,
    number,
  ];
};

/** "Clothes" is tinted per person at runtime, so it's near-white here. */
const MATERIALS = {
  Skin: hex("#d9b597"),
  Clothes: hex("#f2f2f2"),
  Pants: hex("#3b4a6b"),
  Shoes: hex("#2a2a33"),
  Hair: hex("#4a3426"),
  Eyes: hex("#1d1d24"),
} as const;
type MaterialName = keyof typeof MATERIALS;

// --- geometry -----------------------------------------------------------------------------

interface Part {
  material: MaterialName;
  joint: string;
  positions: number[];
  normals: number[];
  indices: number[];
}

function boxPart(material: MaterialName, joint: string, center: V3, size: V3): Part {
  const [hx, hy, hz] = size.map((s) => s / 2) as V3;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faces: { n: V3; u: V3; v: V3 }[] = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  for (const { n, u, v } of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ] as const) {
      for (let k = 0; k < 3; k++) {
        const half = [hx, hy, hz][k]!;
        positions.push(center[k]! + (n[k]! + u[k]! * su + v[k]! * sv) * half);
        normals.push(n[k]!);
      }
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { material, joint, positions, normals, indices };
}

function spherePart(
  material: MaterialName,
  joint: string,
  center: V3,
  radius: V3 | number,
  keep: (n: V3) => boolean = () => true,
): Part {
  const r: V3 = typeof radius === "number" ? [radius, radius, radius] : radius;
  const rings = 12;
  const segments = 16;
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const phi = (i / rings) * Math.PI;
    for (let j = 0; j <= segments; j++) {
      const theta = (j / segments) * Math.PI * 2;
      const n: V3 = [
        Math.sin(phi) * Math.sin(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.cos(theta),
      ];
      positions.push(center[0] + n[0] * r[0], center[1] + n[1] * r[1], center[2] + n[2] * r[2]);
      normals.push(...n);
    }
  }
  const row = segments + 1;
  const normalAt = (i: number): V3 => [normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * row + j;
      const b = a + row;
      for (const tri of [
        [a, b, a + 1],
        [a + 1, b, b + 1],
      ]) {
        if (tri.every((k) => keep(normalAt(k)))) indices.push(...tri);
      }
    }
  }
  return { material, joint, positions, normals, indices };
}

const PARTS: Part[] = [
  spherePart("Skin", "head", [0, 1.62, 0], [0.16, 0.17, 0.16]),
  // Hair: the top and back of a slightly larger shell.
  spherePart("Hair", "head", [0, 1.635, -0.005], 0.178, (n) => n[1] > 0.15 || n[2] < -0.35),
  spherePart("Eyes", "head", [0.058, 1.635, 0.148], 0.022),
  spherePart("Eyes", "head", [-0.058, 1.635, 0.148], 0.022),
  boxPart("Skin", "neck", [0, 1.44, 0], [0.09, 0.09, 0.09]),
  boxPart("Clothes", "chest", [0, 1.24, 0], [0.34, 0.3, 0.2]),
  boxPart("Clothes", "spine", [0, 1.02, 0], [0.3, 0.16, 0.18]),
  boxPart("Pants", "hips", [0, 0.87, 0], [0.31, 0.14, 0.19]),
];
for (const side of [1, -1] as const) {
  const s = side === 1 ? "left" : "right";
  const x = (v: number) => v * side;
  PARTS.push(
    boxPart("Clothes", `${s}UpperArm`, [x(0.315), 1.36, 0], [0.25, 0.095, 0.095]),
    boxPart("Skin", `${s}LowerArm`, [x(0.555), 1.36, 0], [0.23, 0.08, 0.08]),
    boxPart("Skin", `${s}Hand`, [x(0.72), 1.36, 0], [0.1, 0.05, 0.085]),
    boxPart("Pants", `${s}UpperLeg`, [x(0.09), 0.64, 0], [0.13, 0.36, 0.14]),
    boxPart("Pants", `${s}LowerLeg`, [x(0.09), 0.27, 0], [0.11, 0.38, 0.12]),
    boxPart("Shoes", `${s}Foot`, [x(0.09), 0.045, 0.04], [0.11, 0.09, 0.24]),
  );
}

// --- glTF / GLB assembly ------------------------------------------------------------------

const chunks: Buffer[] = [];
let byteLength = 0;
const bufferViews: object[] = [];
const accessors: object[] = [];

function addAccessor(
  data: Float32Array | Uint16Array | Uint8Array,
  componentType: number,
  type: string,
  count: number,
  target?: number,
  minMax?: { min: number[]; max: number[] },
): number {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const padding = (4 - (bytes.byteLength % 4)) % 4;
  bufferViews.push({
    buffer: 0,
    byteOffset: byteLength,
    byteLength: bytes.byteLength,
    ...(target && { target }),
  });
  chunks.push(bytes, Buffer.alloc(padding));
  byteLength += bytes.byteLength + padding;
  accessors.push({ bufferView: bufferViews.length - 1, componentType, type, count, ...minMax });
  return accessors.length - 1;
}

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_BYTE = 5121;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

const materialNames = Object.keys(MATERIALS) as MaterialName[];
const primitives = materialNames
  .map((material, materialIndex) => {
    const parts = PARTS.filter((p) => p.material === material);
    if (parts.length === 0) return null;
    const positions: number[] = [];
    const normals: number[] = [];
    const joints: number[] = [];
    const indices: number[] = [];
    for (const part of parts) {
      const base = positions.length / 3;
      const joint = boneIndex.get(part.joint)!;
      positions.push(...part.positions);
      normals.push(...part.normals);
      for (let i = 0; i < part.positions.length / 3; i++) joints.push(joint, 0, 0, 0);
      indices.push(...part.indices.map((i) => i + base));
    }
    const count = positions.length / 3;
    const min = [0, 1, 2].map((k) => Math.min(...positions.filter((_, i) => i % 3 === k)));
    const max = [0, 1, 2].map((k) => Math.max(...positions.filter((_, i) => i % 3 === k)));
    const weights = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) weights[i * 4] = 1; // rigid skinning: one bone per part
    return {
      attributes: {
        POSITION: addAccessor(new Float32Array(positions), FLOAT, "VEC3", count, ARRAY_BUFFER, {
          min,
          max,
        }),
        NORMAL: addAccessor(new Float32Array(normals), FLOAT, "VEC3", count, ARRAY_BUFFER),
        JOINTS_0: addAccessor(new Uint8Array(joints), UNSIGNED_BYTE, "VEC4", count, ARRAY_BUFFER),
        WEIGHTS_0: addAccessor(weights, FLOAT, "VEC4", count, ARRAY_BUFFER),
      },
      indices: addAccessor(
        new Uint16Array(indices),
        UNSIGNED_SHORT,
        "SCALAR",
        indices.length,
        ELEMENT_ARRAY_BUFFER,
      ),
      material: materialIndex,
    };
  })
  .filter((p) => p !== null);

// Inverse bind matrices: bones have no rest rotation, so each is a pure translation by -position.
const ibm = new Float32Array(BONES.length * 16);
BONES.forEach((b, i) => {
  ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -b.at[0], -b.at[1], -b.at[2], 1], i * 16);
});
const ibmAccessor = addAccessor(ibm, FLOAT, "MAT4", BONES.length);

const nodes: object[] = BONES.map((b) => {
  const parent = b.parent ? BONES[boneIndex.get(b.parent)!]!.at : ([0, 0, 0] as V3);
  const children = BONES.flatMap((c, i) => (c.parent === b.name ? [i] : []));
  return {
    name: b.name,
    translation: [b.at[0] - parent[0], b.at[1] - parent[1], b.at[2] - parent[2]],
    ...(children.length && { children }),
  };
});
const meshNode = nodes.push({ name: "Body", mesh: 0, skin: 0 }) - 1;
const rootNode = nodes.push({ name: "Root", children: [boneIndex.get("hips")!, meshNode] }) - 1;

const gltf = {
  asset: { version: "2.0", generator: "VirtualChatRooms placeholder avatar generator" },
  extensionsUsed: ["VRMC_vrm"],
  scene: 0,
  scenes: [{ nodes: [rootNode] }],
  nodes,
  meshes: [{ name: "Body", primitives }],
  skins: [
    {
      joints: BONES.map((_, i) => i),
      inverseBindMatrices: ibmAccessor,
      skeleton: boneIndex.get("hips"),
    },
  ],
  materials: materialNames.map((name) => ({
    name,
    pbrMetallicRoughness: {
      baseColorFactor: MATERIALS[name],
      metallicFactor: 0,
      roughnessFactor: 0.75,
    },
  })),
  accessors,
  bufferViews,
  buffers: [{ byteLength }],
  extensions: {
    VRMC_vrm: {
      specVersion: "1.0",
      meta: {
        name: "VirtualChatRooms placeholder",
        version: "1",
        authors: ["VirtualChatRooms contributors"],
        licenseUrl: "https://vrm.dev/licenses/1.0/",
        otherLicenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
        avatarPermission: "everyone",
        commercialUsage: "corporation",
        creditNotation: "unnecessary",
        allowRedistribution: true,
        modification: "allowModificationRedistribution",
        allowExcessivelyViolentUsage: false,
        allowExcessivelySexualUsage: false,
        allowPoliticalOrReligiousUsage: false,
        allowAntisocialOrHateUsage: false,
      },
      humanoid: {
        humanBones: Object.fromEntries(BONES.map((b, i) => [b.name, { node: i }])),
      },
    },
  },
};

const json = Buffer.from(JSON.stringify(gltf));
const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - (json.byteLength % 4)) % 4, 0x20)]);
const bin = Buffer.concat(chunks);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); // "glTF"
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonPadded.byteLength + 8 + bin.byteLength, 8);
const chunkHeader = (length: number, type: number) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(length, 0);
  h.writeUInt32LE(type, 4);
  return h;
};
const glb = Buffer.concat([
  header,
  chunkHeader(jsonPadded.byteLength, 0x4e4f534a), // JSON
  jsonPadded,
  chunkHeader(bin.byteLength, 0x004e4942), // BIN
  bin,
]);

const out = new URL("../apps/web/public/avatars/placeholder.vrm", import.meta.url);
mkdirSync(new URL(".", out), { recursive: true });
writeFileSync(out, glb);
console.log(
  `Wrote ${out.pathname} (${(glb.byteLength / 1024).toFixed(1)} KB, ${BONES.length} bones)`,
);
