import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { BUILT_IN_ROOMS } from "@vcr/engine";
import { buildRoomScene, disposeModel } from "./builtInRoomScene";

/**
 * Development only: exports every built-in room to public/rooms/<id>.glb. Run
 * `await vcrExportRoomModels()` in the browser console of the dev server (`pnpm dev`) after
 * changing a room's parts or pictures; the dev server saves the files (vite.config.ts).
 */
async function exportRoomModels(): Promise<Record<string, number>> {
  const sizes: Record<string, number> = {};
  for (const room of Object.values(BUILT_IN_ROOMS)) {
    const scene = buildRoomScene(room);
    const glb = (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
    disposeModel(scene);
    const res = await fetch(`/__dev/room-model/${room.id}`, { method: "POST", body: glb });
    if (!res.ok) throw new Error(`Saving ${room.id}.glb failed: ${res.status}`);
    sizes[`${room.id}.glb`] = glb.byteLength;
  }
  return sizes;
}

(window as { vcrExportRoomModels?: typeof exportRoomModels }).vcrExportRoomModels =
  exportRoomModels;
