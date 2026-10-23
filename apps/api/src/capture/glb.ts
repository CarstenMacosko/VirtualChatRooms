/**
 * A minimal glTF 2.0 binary (GLB) with one triangle mesh: the room's collision mesh. Any glTF
 * loader reads it (the web uses three's GLTFLoader, which also handles provider meshes later).
 */
export function writeCollisionGlb(positions: Float32Array, indices: Uint32Array): Buffer {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, positions[i]!);
  }
  const positionBytes = Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength);
  const indexBytes = Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength);
  const bin = Buffer.concat([positionBytes, indexBytes]);
  const json = {
    asset: { version: "2.0", generator: "VirtualChatRooms room capture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "collision" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length, byteLength: indexBytes.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3", min, max },
      { bufferView: 1, componentType: 5125, count: indices.length, type: "SCALAR" },
    ],
  };
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  return Buffer.concat([
    header,
    chunkHeader(jsonChunk.length, 0x4e4f534a), // "JSON"
    jsonChunk,
    chunkHeader(binChunk.length, 0x004e4942), // "BIN"
    binChunk,
  ]);
}

/** Reads back the mesh `writeCollisionGlb` wrote (for tests and rescaling). */
export function readCollisionGlb(glb: Buffer): { positions: Float32Array; indices: Uint32Array } {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8"));
  const binStart = 20 + jsonLength + 8;
  const view = (i: number) => json.bufferViews[i] as { byteOffset: number; byteLength: number };
  const slice = (i: number) => {
    const v = view(i);
    return glb.buffer.slice(
      glb.byteOffset + binStart + v.byteOffset,
      glb.byteOffset + binStart + v.byteOffset + v.byteLength,
    );
  };
  return { positions: new Float32Array(slice(0)), indices: new Uint32Array(slice(1)) };
}

function pad(buf: Buffer, fill: number) {
  const extra = (4 - (buf.length % 4)) % 4;
  return extra ? Buffer.concat([buf, Buffer.alloc(extra, fill)]) : buf;
}

function chunkHeader(length: number, type: number) {
  const b = Buffer.alloc(8);
  b.writeUInt32LE(length, 0);
  b.writeUInt32LE(type, 4);
  return b;
}
