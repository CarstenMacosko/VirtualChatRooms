import type { Readable } from "node:stream";
import { createGunzip, gzipSync } from "node:zlib";
import type { SplatFormat } from "@vcr/protocol";

/**
 * Reading Gaussian splat files on the server, for post-processing: only what the analysis needs
 * (centers and opacity), streamed so a 300 MB scan never sits in memory, and subsampled to
 * `maxPoints`. Spark does the real decoding in the browser.
 *
 * Formats: binary little-endian PLY as written by 3DGS trainers and the scanning apps
 * (Scaniverse, Polycam, KIRI), PlayCanvas/SuperSplat "compressed" PLY, and Niantic's SPZ
 * (versions 1–3). Coordinates are returned exactly as stored; Spark renders them the same way.
 */

export interface SplatPoints {
  /** Splats in the file. */
  count: number;
  /** Kept splat centers, xyz interleaved (every `stride`-th splat). */
  positions: Float32Array;
  /** Opacity 0–1 for each kept splat. */
  opacity: Float32Array;
  stride: number;
}

export class SplatFileError extends Error {
  override name = "SplatFileError";
}

export const DEFAULT_MAX_POINTS = 1_500_000;

export function readSplatPoints(
  source: Readable,
  format: SplatFormat,
  opts: { maxPoints?: number; maxSplats?: number } = {},
): Promise<SplatPoints> {
  return format === "ply" ? readPly(source, opts) : readSpz(source, opts);
}

/** Pulls exactly-sized pieces out of a byte stream. */
class ByteReader {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private iterator: AsyncIterator<Buffer>;
  done = false;

  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }

  /** Ensures at least `n` bytes are buffered; returns how many are (fewer only at the end). */
  async fill(n: number) {
    while (this.buffered < n && !this.done) {
      const { value, done } = await this.iterator.next();
      if (done) this.done = true;
      else {
        this.chunks.push(value);
        this.buffered += value.length;
      }
    }
    return this.buffered;
  }

  /** Everything buffered so far, without consuming it. */
  peekAll(): Buffer {
    if (this.chunks.length > 1) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0] ?? Buffer.alloc(0);
  }

  async read(n: number): Promise<Buffer> {
    if ((await this.fill(n)) < n) throw new SplatFileError("The file ended early.");
    const all = this.peekAll();
    const out = all.subarray(0, n);
    this.chunks = n < all.length ? [all.subarray(n)] : [];
    this.buffered -= n;
    return out;
  }

  /** Hands buffered bytes to `fn` in pieces of whole `size`-byte records until `total` are read. */
  async records(total: number, size: number, fn: (buf: Buffer, first: number, n: number) => void) {
    let index = 0;
    while (index < total) {
      await this.fill(size);
      const available = Math.floor(this.buffered / size);
      if (available === 0) throw new SplatFileError("The file ended early.");
      const n = Math.min(available, total - index, 65536);
      fn(await this.read(n * size), index, n);
      index += n;
    }
  }

  async close() {
    await this.iterator.return?.();
  }
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function checkCount(count: number, maxSplats: number | undefined) {
  if (!Number.isInteger(count) || count <= 0) throw new SplatFileError("The scan has no splats.");
  if (maxSplats !== undefined && count > maxSplats) {
    throw new SplatFileError(
      `This scan has ${count.toLocaleString("en-US")} splats; rooms can have up to ${maxSplats.toLocaleString("en-US")}. Export it at a lower density.`,
    );
  }
}

// --- PLY ------------------------------------------------------------------------------------

const PLY_TYPES: Record<string, { size: number; read: (b: Buffer, o: number) => number }> = {
  char: { size: 1, read: (b, o) => b.readInt8(o) },
  int8: { size: 1, read: (b, o) => b.readInt8(o) },
  uchar: { size: 1, read: (b, o) => b.readUInt8(o) },
  uint8: { size: 1, read: (b, o) => b.readUInt8(o) },
  short: { size: 2, read: (b, o) => b.readInt16LE(o) },
  int16: { size: 2, read: (b, o) => b.readInt16LE(o) },
  ushort: { size: 2, read: (b, o) => b.readUInt16LE(o) },
  uint16: { size: 2, read: (b, o) => b.readUInt16LE(o) },
  int: { size: 4, read: (b, o) => b.readInt32LE(o) },
  int32: { size: 4, read: (b, o) => b.readInt32LE(o) },
  uint: { size: 4, read: (b, o) => b.readUInt32LE(o) },
  uint32: { size: 4, read: (b, o) => b.readUInt32LE(o) },
  float: { size: 4, read: (b, o) => b.readFloatLE(o) },
  float32: { size: 4, read: (b, o) => b.readFloatLE(o) },
  double: { size: 8, read: (b, o) => b.readDoubleLE(o) },
  float64: { size: 8, read: (b, o) => b.readDoubleLE(o) },
};

interface PlyProperty {
  offset: number;
  /** Bytes; 1- and 2-byte properties are integers. */
  size: number;
  read: (b: Buffer, o: number) => number;
}

interface PlyElement {
  name: string;
  count: number;
  size: number;
  props: Map<string, PlyProperty>;
}

export function parsePlyHeader(text: string): PlyElement[] {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "ply") throw new SplatFileError("This isn't a PLY file.");
  const elements: PlyElement[] = [];
  for (const line of lines.slice(1)) {
    const [word, ...rest] = line.trim().split(/\s+/);
    if (word === "format" && rest[0] !== "binary_little_endian") {
      throw new SplatFileError(
        `PLY files in "${rest[0]}" format aren't supported. Export a binary PLY (the usual splat export).`,
      );
    }
    if (word === "element") {
      elements.push({ name: rest[0]!, count: Number(rest[1]), size: 0, props: new Map() });
    }
    if (word === "property") {
      const element = elements.at(-1);
      if (!element) throw new SplatFileError("The PLY header is malformed.");
      if (rest[0] === "list") {
        throw new SplatFileError("PLY files with list properties (meshes) aren't splat scans.");
      }
      const type = PLY_TYPES[rest[0]!];
      if (!type) throw new SplatFileError(`Unknown PLY property type "${rest[0]}".`);
      element.props.set(rest[1]!, { offset: element.size, size: type.size, read: type.read });
      element.size += type.size;
    }
  }
  return elements;
}

/** Reads the ASCII header (it ends with "end_header\n" and is well under 64 KB). */
async function readPlyHeader(reader: ByteReader): Promise<PlyElement[]> {
  let headerEnd = -1;
  for (let want = 4096; headerEnd < 0; want *= 2) {
    const got = await reader.fill(want);
    const head = reader.peekAll();
    if (
      head.subarray(0, 4).toString("latin1") !== "ply\n" &&
      head.subarray(0, 5).toString("latin1") !== "ply\r\n"
    ) {
      throw new SplatFileError("This isn't a PLY file.");
    }
    const at = head.indexOf("end_header");
    if (at >= 0) headerEnd = head.indexOf(0x0a, at) + 1;
    if (headerEnd <= 0 && (got < want || want > 1 << 20)) {
      throw new SplatFileError("The PLY header is malformed.");
    }
  }
  return parsePlyHeader((await reader.read(headerEnd)).toString("latin1"));
}

/** Skips the elements stored before the vertices (none, in the files we see). */
async function skipToVertices(reader: ByteReader, elements: PlyElement[], vertex: PlyElement) {
  for (const element of elements) {
    if (element === vertex) break;
    await reader.records(element.count, element.size, () => {});
  }
}

async function readPly(
  source: Readable,
  opts: { maxPoints?: number; maxSplats?: number },
): Promise<SplatPoints> {
  const reader = new ByteReader(source);
  try {
    const elements = await readPlyHeader(reader);
    const vertex = elements.find((e) => e.name === "vertex");
    if (!vertex) throw new SplatFileError("The PLY file has no splats.");
    checkCount(vertex.count, opts.maxSplats);
    const stride = Math.max(1, Math.ceil(vertex.count / (opts.maxPoints ?? DEFAULT_MAX_POINTS)));
    const kept = Math.ceil(vertex.count / stride);
    const positions = new Float32Array(kept * 3);
    const opacity = new Float32Array(kept);

    const chunk = elements.find((e) => e.name === "chunk");
    let chunkBounds: Float32Array | null = null;
    for (const element of elements) {
      if (element === vertex) break;
      if (element === chunk) {
        // Compressed PLY: per-256-splat bounds that packed positions are relative to.
        const names = ["min_x", "min_y", "min_z", "max_x", "max_y", "max_z"];
        const props = names.map((n) => element.props.get(n));
        if (props.some((p) => !p)) throw new SplatFileError("The compressed PLY is malformed.");
        chunkBounds = new Float32Array(element.count * 6);
        await reader.records(element.count, element.size, (buf, first, n) => {
          for (let i = 0; i < n; i++) {
            for (let k = 0; k < 6; k++) {
              chunkBounds![(first + i) * 6 + k] = props[k]!.read(
                buf,
                i * element.size + props[k]!.offset,
              );
            }
          }
        });
      } else {
        await reader.records(element.count, element.size, () => {});
      }
    }

    const packed = vertex.props.get("packed_position");
    const packedColor = vertex.props.get("packed_color");
    if (packed && chunkBounds) {
      await reader.records(vertex.count, vertex.size, (buf, first, n) => {
        for (let i = 0; i < n; i++) {
          const index = first + i;
          if (index % stride) continue;
          const at = i * vertex.size;
          const v = packed.read(buf, at + packed.offset) >>> 0;
          const c = (index >> 8) * 6;
          const k = index / stride;
          const fx = (v >>> 21) / 2047;
          const fy = ((v >>> 11) & 1023) / 1023;
          const fz = (v & 2047) / 2047;
          positions[k * 3] = chunkBounds![c]! + fx * (chunkBounds![c + 3]! - chunkBounds![c]!);
          positions[k * 3 + 1] =
            chunkBounds![c + 1]! + fy * (chunkBounds![c + 4]! - chunkBounds![c + 1]!);
          positions[k * 3 + 2] =
            chunkBounds![c + 2]! + fz * (chunkBounds![c + 5]! - chunkBounds![c + 2]!);
          opacity[k] = packedColor
            ? ((packedColor.read(buf, at + packedColor.offset) >>> 0) & 255) / 255
            : 1;
        }
      });
      return { count: vertex.count, positions, opacity, stride };
    }

    const x = vertex.props.get("x");
    const y = vertex.props.get("y");
    const z = vertex.props.get("z");
    if (!x || !y || !z) throw new SplatFileError("The PLY file has no splat positions.");
    const op = vertex.props.get("opacity");
    await reader.records(vertex.count, vertex.size, (buf, first, n) => {
      for (let i = 0; i < n; i++) {
        const index = first + i;
        if (index % stride) continue;
        const at = i * vertex.size;
        const k = index / stride;
        positions[k * 3] = x.read(buf, at + x.offset);
        positions[k * 3 + 1] = y.read(buf, at + y.offset);
        positions[k * 3 + 2] = z.read(buf, at + z.offset);
        // 3DGS stores opacity as a logit; plain point clouds have none.
        opacity[k] = op ? sigmoid(op.read(buf, at + op.offset)) : 1;
      }
    });
    return { count: vertex.count, positions, opacity, stride };
  } finally {
    await reader.close();
  }
}

// --- Point clouds ---------------------------------------------------------------------------

/**
 * Whether a PLY header describes a plain colored point cloud (Scaniverse's and Polycam's
 * "point cloud" export: positions and colors, maybe normals) rather than Gaussian splats. Those
 * have no sizes, so they need converting before they look like anything (see surfels.ts).
 */
export function isPointCloudPly(head: Buffer): boolean {
  const at = head.indexOf("end_header");
  if (at < 0) return false;
  let elements: PlyElement[];
  try {
    elements = parsePlyHeader(head.subarray(0, at).toString("latin1"));
  } catch {
    return false;
  }
  const vertex = elements.find((e) => e.name === "vertex");
  if (!vertex || elements.some((e) => e.name === "chunk")) return false;
  return !["scale_0", "f_dc_0", "opacity"].some((name) => vertex.props.has(name));
}

export interface PointCloud {
  count: number;
  /** xyz interleaved, as stored. */
  positions: Float32Array;
  /** rgb interleaved, 0–255 (light gray when the file has no colors). */
  colors: Uint8Array;
}

/** Reads every point of a point-cloud PLY: positions and colors. */
export async function readPointCloud(
  source: Readable,
  opts: { maxSplats?: number } = {},
): Promise<PointCloud> {
  const reader = new ByteReader(source);
  try {
    const elements = await readPlyHeader(reader);
    const vertex = elements.find((e) => e.name === "vertex");
    if (!vertex) throw new SplatFileError("The PLY file has no points.");
    checkCount(vertex.count, opts.maxSplats);
    const x = vertex.props.get("x");
    const y = vertex.props.get("y");
    const z = vertex.props.get("z");
    if (!x || !y || !z) throw new SplatFileError("The PLY file has no point positions.");
    const channel = (name: string) => vertex.props.get(name) ?? vertex.props.get(`diffuse_${name}`);
    const rgb = [channel("red"), channel("green"), channel("blue")];
    const colorOf = rgb.every(Boolean)
      ? rgb.map((p) => {
          // Colors are bytes, 16-bit, or 0–1 floats.
          const k = p!.size === 1 ? 1 : p!.size === 2 ? 1 / 257 : 255;
          return (b: Buffer, at: number) =>
            Math.max(0, Math.min(255, Math.round(p!.read(b, at + p!.offset) * k)));
        })
      : null;
    const positions = new Float32Array(vertex.count * 3);
    const colors = new Uint8Array(vertex.count * 3).fill(200);
    await skipToVertices(reader, elements, vertex);
    await reader.records(vertex.count, vertex.size, (buf, first, n) => {
      for (let i = 0; i < n; i++) {
        const at = i * vertex.size;
        const k = (first + i) * 3;
        positions[k] = x.read(buf, at + x.offset);
        positions[k + 1] = y.read(buf, at + y.offset);
        positions[k + 2] = z.read(buf, at + z.offset);
        if (colorOf) {
          for (let a = 0; a < 3; a++) colors[k + a] = colorOf[a]!(buf, at);
        }
      }
    });
    return { count: vertex.count, positions, colors };
  } finally {
    await reader.close();
  }
}

// --- SPZ ------------------------------------------------------------------------------------

const SPZ_MAGIC = 0x5053474e; // "NGSP"

function float16(h: number) {
  const exp = (h >> 10) & 0x1f;
  const frac = h & 0x3ff;
  const sign = h & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * 2 ** -14 * (frac / 1024);
  if (exp === 31) return frac ? Number.NaN : sign * Infinity;
  return sign * 2 ** (exp - 15) * (1 + frac / 1024);
}

async function readSpz(
  source: Readable,
  opts: { maxPoints?: number; maxSplats?: number },
): Promise<SplatPoints> {
  const gunzip = createGunzip();
  source.on("error", (err) => gunzip.destroy(err));
  const reader = new ByteReader(source.pipe(gunzip));
  try {
    let header: Buffer;
    try {
      header = await reader.read(16);
    } catch {
      throw new SplatFileError("This isn't an SPZ file.");
    }
    if (header.readUInt32LE(0) !== SPZ_MAGIC) throw new SplatFileError("This isn't an SPZ file.");
    const version = header.readUInt32LE(4);
    if (version < 1 || version > 3) {
      throw new SplatFileError(`SPZ version ${version} isn't supported yet. Try exporting a PLY.`);
    }
    const count = header.readUInt32LE(8);
    checkCount(count, opts.maxSplats);
    const fractionalBits = header.readUInt8(13);
    const scale = 1 / (1 << fractionalBits);
    const stride = Math.max(1, Math.ceil(count / (opts.maxPoints ?? DEFAULT_MAX_POINTS)));
    const kept = Math.ceil(count / stride);
    const positions = new Float32Array(kept * 3);
    const opacity = new Float32Array(kept);

    // Positions for every splat come first, then every alpha (then colors, scales, rotations).
    if (version === 1) {
      await reader.records(count, 6, (buf, first, n) => {
        for (let i = first % stride ? stride - (first % stride) : 0; i < n; i += stride) {
          const k = (first + i) / stride;
          for (let a = 0; a < 3; a++)
            positions[k * 3 + a] = float16(buf.readUInt16LE(i * 6 + a * 2));
        }
      });
    } else {
      await reader.records(count, 9, (buf, first, n) => {
        for (let i = first % stride ? stride - (first % stride) : 0; i < n; i += stride) {
          const k = (first + i) / stride;
          for (let a = 0; a < 3; a++) {
            positions[k * 3 + a] = buf.readIntLE(i * 9 + a * 3, 3) * scale;
          }
        }
      });
    }
    await reader.records(count, 1, (buf, first, n) => {
      for (let i = first % stride ? stride - (first % stride) : 0; i < n; i += stride) {
        opacity[(first + i) / stride] = buf[i]! / 255;
      }
    });
    return { count, positions, opacity, stride };
  } finally {
    await reader.close();
    gunzip.destroy();
    source.destroy(); // positions and alphas are all we need; skip the rest
  }
}

/** Which format a file is, from its first bytes (PLY header or gzip-wrapped SPZ). */
export function sniffSplatFormat(head: Buffer): SplatFormat | null {
  if (head.subarray(0, 3).toString("latin1") === "ply") return "ply";
  if (head[0] === 0x1f && head[1] === 0x8b) return "spz";
  return null;
}

// --- Writers (synthetic test scans, and tools) ----------------------------------------------

export interface SplatRecord {
  position: [number, number, number];
  /** Per-axis standard deviation. */
  scale: [number, number, number];
  /** [x, y, z, w] */
  rotation: [number, number, number, number];
  opacity: number;
  /** 0–1 */
  color: [number, number, number];
}

const SH_C0 = 0.28209479177387814;
const logit = (p: number) =>
  Math.log(Math.min(0.9999, Math.max(1e-4, p)) / (1 - Math.min(0.9999, Math.max(1e-4, p))));

/** A standard 3DGS PLY (degree-0 spherical harmonics), as trainers and scanning apps write. */
export function writePly(splats: readonly SplatRecord[]): Buffer {
  const props = ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity"];
  props.push("scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3");
  const header =
    ["ply", "format binary_little_endian 1.0", `element vertex ${splats.length}`]
      .concat(
        props.map((p) => `property float ${p}`),
        ["end_header"],
      )
      .join("\n") + "\n";
  const body = Buffer.alloc(splats.length * props.length * 4);
  let o = 0;
  const f = (v: number) => {
    body.writeFloatLE(v, o);
    o += 4;
  };
  for (const s of splats) {
    s.position.forEach(f);
    [0, 0, 0].forEach(f); // normals
    s.color.forEach((c) => f((c - 0.5) / SH_C0));
    f(logit(s.opacity));
    s.scale.forEach((v) => f(Math.log(Math.max(v, 1e-6))));
    // PLY stores rotations as w, x, y, z.
    [s.rotation[3], s.rotation[0], s.rotation[1], s.rotation[2]].forEach(f);
  }
  return Buffer.concat([Buffer.from(header, "latin1"), body]);
}

/** A plain colored point cloud, like Scaniverse's "point cloud" PLY export. */
export function writePointCloudPly(
  points: ReadonlyArray<{ position: readonly number[]; color: readonly number[] }>,
): Buffer {
  const header =
    [
      "ply",
      "format binary_little_endian 1.0",
      `element vertex ${points.length}`,
      ...["x", "y", "z"].map((p) => `property float ${p}`),
      ...["red", "green", "blue"].map((p) => `property uchar ${p}`),
      "end_header",
    ].join("\n") + "\n";
  const body = Buffer.alloc(points.length * 15);
  points.forEach((p, i) => {
    for (let a = 0; a < 3; a++) {
      body.writeFloatLE(p.position[a]!, i * 15 + a * 4);
      body[i * 15 + 12 + a] = Math.max(0, Math.min(255, Math.round(p.color[a]! * 255)));
    }
  });
  return Buffer.concat([Buffer.from(header, "latin1"), body]);
}

/** Splats as parallel arrays, for writing millions without an object each. */
export interface SplatColumns {
  count: number;
  /** xyz */
  positions: Float32Array;
  /** Per-axis standard deviation, xyz. */
  scales: Float32Array;
  /** xyzw */
  rotations: Float32Array;
  opacity: Float32Array;
  /** rgb, 0–255 */
  colors: Uint8Array;
}

/** An SPZ v2 file (gzip-compressed, 12 fractional bits, no spherical harmonics). */
export function writeSpz(splats: readonly SplatRecord[], fractionalBits = 12): Buffer {
  const n = splats.length;
  const columns: SplatColumns = {
    count: n,
    positions: new Float32Array(n * 3),
    scales: new Float32Array(n * 3),
    rotations: new Float32Array(n * 4),
    opacity: new Float32Array(n),
    colors: new Uint8Array(n * 3),
  };
  splats.forEach((s, i) => {
    columns.positions.set(s.position, i * 3);
    columns.scales.set(s.scale, i * 3);
    columns.rotations.set(s.rotation, i * 4);
    columns.opacity[i] = s.opacity;
    for (let a = 0; a < 3; a++) columns.colors[i * 3 + a] = Math.round(s.color[a]! * 255);
  });
  return writeSpzColumns(columns, fractionalBits);
}

export function writeSpzColumns(splats: SplatColumns, fractionalBits = 12): Buffer {
  const n = splats.count;
  const header = Buffer.alloc(16);
  header.writeUInt32LE(SPZ_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(n, 8);
  header.writeUInt8(0, 12); // SH degree
  header.writeUInt8(fractionalBits, 13);
  const positions = Buffer.alloc(n * 9);
  const alphas = Buffer.alloc(n);
  const colors = Buffer.alloc(n * 3);
  const scales = Buffer.alloc(n * 3);
  const rotations = Buffer.alloc(n * 3);
  const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const { positions: p, scales: s, rotations: r, colors: c } = splats;
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const fixed = Math.round(p[i * 3 + a]! * (1 << fractionalBits));
      positions.writeIntLE(Math.max(-0x800000, Math.min(0x7fffff, fixed)), i * 9 + a * 3, 3);
      colors[i * 3 + a] = byte(((c[i * 3 + a]! / 255 - 0.5) / SH_C0) * 0.15 * 255 + 127.5);
      scales[i * 3 + a] = byte((Math.log(Math.max(s[i * 3 + a]!, 1e-6)) + 10) * 16);
    }
    alphas[i] = byte(splats.opacity[i]! * 255);
    // v2 stores x, y, z of a quaternion with w ≥ 0.
    const sign = r[i * 4 + 3]! < 0 ? -1 : 1;
    for (let a = 0; a < 3; a++) rotations[i * 3 + a] = byte((sign * r[i * 4 + a]! + 1) * 127.5);
  }
  return gzipSync(Buffer.concat([header, positions, alphas, colors, scales, rotations]));
}
