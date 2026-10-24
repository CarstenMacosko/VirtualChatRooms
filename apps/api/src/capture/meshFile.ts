import type { SplatPoints } from "./splatFile";

/**
 * Reading textured mesh scans (glTF binary, `.glb`, as Scaniverse, Polycam and RealityScan
 * export them) on the server, for post-processing: only the triangles' corners, in the file's
 * scene space (every node's transform applied). Textures stay untouched; the browser draws the
 * file as uploaded (RoomMesh.tsx).
 */

export class MeshFileError extends Error {
  override name = "MeshFileError";
}

/** More than this and phones can't draw the room. */
export const MAX_MESH_TRIANGLES = 5_000_000;

export interface TriangleMesh {
  /** Corners, xyz interleaved, in scene space. */
  positions: Float32Array;
  /** Three corner indices per triangle. */
  indices: Uint32Array;
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export function isGlb(head: Buffer): boolean {
  return head.length >= 4 && head.readUInt32LE(0) === GLB_MAGIC;
}

interface Gltf {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: Array<{
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }>;
  meshes?: Array<{
    primitives: Array<{ attributes: Record<string, number>; indices?: number; mode?: number }>;
  }>;
  accessors?: Array<{
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    normalized?: boolean;
    count: number;
    type: string;
    sparse?: unknown;
  }>;
  bufferViews?: Array<{
    buffer: number;
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }>;
  buffers?: Array<{ uri?: string }>;
  extensionsRequired?: string[];
}

const COMPONENTS: Record<
  number,
  { size: number; read: (b: Buffer, o: number) => number; max: number }
> = {
  5120: { size: 1, read: (b, o) => b.readInt8(o), max: 127 },
  5121: { size: 1, read: (b, o) => b.readUInt8(o), max: 255 },
  5122: { size: 2, read: (b, o) => b.readInt16LE(o), max: 32767 },
  5123: { size: 2, read: (b, o) => b.readUInt16LE(o), max: 65535 },
  5125: { size: 4, read: (b, o) => b.readUInt32LE(o), max: 1 },
  5126: { size: 4, read: (b, o) => b.readFloatLE(o), max: 1 },
};

/** The scan's triangles: every triangle primitive of every mesh in the default scene. */
export function readGlbMesh(glb: Buffer): TriangleMesh {
  if (!isGlb(glb) || glb.length < 20) throw new MeshFileError("This isn't a GLB file.");
  if (glb.readUInt32LE(4) !== 2) {
    throw new MeshFileError("Only glTF 2.0 files are supported. Export the mesh as GLB.");
  }
  let json: Gltf | null = null;
  let bin: Buffer | null = null;
  for (let at = 12; at + 8 <= glb.length;) {
    const length = glb.readUInt32LE(at);
    const type = glb.readUInt32LE(at + 4);
    const data = glb.subarray(at + 8, at + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString("utf8")) as Gltf;
    else if (type === CHUNK_BIN && !bin) bin = data;
    at += 8 + length;
  }
  if (!json) throw new MeshFileError("The GLB file is malformed.");
  const compressed = (json.extensionsRequired ?? []).filter((e) =>
    ["KHR_draco_mesh_compression", "EXT_meshopt_compression"].includes(e),
  );
  if (compressed.length) {
    throw new MeshFileError(
      `Compressed meshes (${compressed.join(", ")}) aren't supported yet. Export the GLB without compression.`,
    );
  }

  const gltf = json;
  const accessor = (index: number, size: number) => {
    const a = gltf.accessors?.[index];
    if (!a || a.sparse || a.bufferView === undefined) {
      throw new MeshFileError("The GLB file has a mesh we can't read.");
    }
    const view = gltf.bufferViews?.[a.bufferView];
    const component = COMPONENTS[a.componentType];
    if (!view || !component || view.buffer !== 0 || gltf.buffers?.[0]?.uri !== undefined || !bin) {
      throw new MeshFileError(
        "The GLB file keeps its mesh outside the file. Export a single .glb.",
      );
    }
    const stride = view.byteStride ?? component.size * size;
    const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const scale = a.normalized ? 1 / component.max : 1;
    const out = new Float64Array(a.count * size);
    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < size; k++) {
        out[i * size + k] = component.read(bin, start + i * stride + k * component.size) * scale;
      }
    }
    return out;
  };

  const positions: number[][] = [];
  const indices: number[][] = [];
  let corners = 0;
  let triangles = 0;
  const visit = (nodeIndex: number, parent: Float64Array, depth: number) => {
    const node = gltf.nodes?.[nodeIndex];
    if (!node || depth > 64) return;
    const matrix = multiply(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const primitive of gltf.meshes?.[node.mesh]?.primitives ?? []) {
        if ((primitive.mode ?? 4) !== 4 || primitive.attributes.POSITION === undefined) continue;
        const p = accessor(primitive.attributes.POSITION, 3);
        const count = p.length / 3;
        const idx =
          primitive.indices !== undefined
            ? accessor(primitive.indices, 1)
            : Float64Array.from({ length: count }, (_, i) => i);
        triangles += Math.floor(idx.length / 3);
        if (triangles > MAX_MESH_TRIANGLES) {
          throw new MeshFileError(
            `This mesh has over ${MAX_MESH_TRIANGLES.toLocaleString("en-US")} triangles; phones can't draw that many. Export it at a lower detail level.`,
          );
        }
        const world: number[] = new Array(count * 3);
        for (let i = 0; i < count; i++) {
          const [x, y, z] = [p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!];
          for (let r = 0; r < 3; r++) {
            world[i * 3 + r] =
              matrix[r]! * x + matrix[4 + r]! * y + matrix[8 + r]! * z + matrix[12 + r]!;
          }
        }
        positions.push(world);
        indices.push(
          Array.from(idx.subarray(0, idx.length - (idx.length % 3)), (v) => v + corners),
        );
        corners += count;
      }
    }
    for (const child of node.children ?? []) visit(child, matrix, depth + 1);
  };
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  for (const root of scene?.nodes ?? []) visit(root, identity(), 0);
  if (!triangles) throw new MeshFileError("The GLB file has no triangles.");
  return {
    positions: Float32Array.from(positions.flat()),
    indices: Uint32Array.from(indices.flat()),
  };
}

/** A glTF node's local transform, column-major. */
function nodeMatrix(node: NonNullable<Gltf["nodes"]>[number]): Float64Array {
  if (node.matrix?.length === 16) return Float64Array.from(node.matrix);
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  return Float64Array.from([
    (1 - 2 * (y! * y! + z! * z!)) * sx!,
    2 * (x! * y! + z! * w!) * sx!,
    2 * (x! * z! - y! * w!) * sx!,
    0,
    2 * (x! * y! - z! * w!) * sy!,
    (1 - 2 * (x! * x! + z! * z!)) * sy!,
    2 * (y! * z! + x! * w!) * sy!,
    0,
    2 * (x! * z! + y! * w!) * sz!,
    2 * (y! * z! - x! * w!) * sz!,
    (1 - 2 * (x! * x! + y! * y!)) * sz!,
    0,
    tx!,
    ty!,
    tz!,
    1,
  ]);
}

const identity = () => Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

function multiply(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/**
 * Points spread evenly over the mesh's surface (by area, not by corner: a flat wall is a few
 * big triangles, a plant thousands of tiny ones), as the room analysis reads splats.
 */
export function sampleSurface(mesh: TriangleMesh, count: number): SplatPoints {
  const { positions: p, indices } = mesh;
  const triangles = indices.length / 3;
  const cumulative = new Float64Array(triangles);
  let total = 0;
  for (let t = 0; t < triangles; t++) {
    const a = indices[t * 3]! * 3;
    const b = indices[t * 3 + 1]! * 3;
    const c = indices[t * 3 + 2]! * 3;
    const ux = p[b]! - p[a]!;
    const uy = p[b + 1]! - p[a + 1]!;
    const uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!;
    const vy = p[c + 1]! - p[a + 1]!;
    const vz = p[c + 2]! - p[a + 2]!;
    const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    total += Number.isFinite(area) ? area : 0;
    cumulative[t] = total;
  }
  if (!(total > 0)) throw new MeshFileError("The mesh has no surface.");

  const random = mulberry32(0x5eed);
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    // Stratified along the cumulative area, so every part of the surface gets its share.
    const target = ((i + random()) / count) * total;
    let lo = 0;
    let hi = triangles - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    let u = random();
    let v = random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const a = indices[lo * 3]! * 3;
    const b = indices[lo * 3 + 1]! * 3;
    const c = indices[lo * 3 + 2]! * 3;
    for (let k = 0; k < 3; k++) {
      positions[i * 3 + k] = p[a + k]! + u * (p[b + k]! - p[a + k]!) + v * (p[c + k]! - p[a + k]!);
    }
  }
  return { count, positions, opacity: new Float32Array(count).fill(1), stride: 1 };
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
