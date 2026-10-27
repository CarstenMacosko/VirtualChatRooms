import {
  SparkRenderer,
  SplatEdit,
  SplatEditRgbaBlendMode,
  SplatEditSdf,
  SplatEditSdfType,
  SplatFileType,
  SplatMesh,
} from "@sparkjsdev/spark";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import type { Clearance } from "@vcr/engine";
import type { SceneAssets } from "@vcr/protocol";
import { assetUrl } from "../lib/api";

export type RoomLoadState =
  | { state: "loading"; progress: number | null }
  | { state: "ready"; splats: number }
  | { state: "error"; message: string };

/**
 * Renders a scanned room's Gaussian splats with Spark, loaded from its signed URL and placed in
 * the world by the manifest's transform. Splats inside `clearances` are hidden (see
 * `roomClearances`).
 */
export function RoomSplats(props: {
  scene: SceneAssets;
  clearances: readonly Clearance[];
  onState?: (state: RoomLoadState) => void;
}) {
  const gl = useThree((s) => s.gl);
  const spark = useMemo(() => new SparkRenderer({ renderer: gl }), [gl]);
  const { scene, clearances, onState } = props;

  const mesh = useMemo(() => {
    const { splat, transform } = scene.manifest;
    const url = splat ? scene.urls[splat.key] : undefined;
    const scanned = new SplatMesh({
      url: url ? assetUrl(url) : "",
      fileType: splat?.format === "ply" ? SplatFileType.PLY : SplatFileType.SPZ,
      onProgress: (e) =>
        onState?.({ state: "loading", progress: e.total ? e.loaded / e.total : null }),
    });
    // world = translation + metersPerUnit · rotation(file): Object3D's T·R·S exactly.
    scanned.position.set(...transform.translation);
    scanned.quaternion.set(...transform.rotation);
    scanned.scale.setScalar(transform.metersPerUnit);
    scanned.initialized.then(
      () => onState?.({ state: "ready", splats: splat?.count ?? 0 }),
      (err: unknown) =>
        onState?.({ state: "error", message: `Couldn't load this room (${String(err)}).` }),
    );
    return scanned;
  }, [scene, onState]);

  // Keep the scan out of the space play surfaces and other features need.
  const clear = useMemo(() => {
    const sdfs = clearances.map((c) => {
      const sdf = new SplatEditSdf({ type: SplatEditSdfType.BOX, opacity: 0 });
      sdf.position.set(...c.center);
      sdf.rotation.set(0, c.yaw, 0);
      sdf.scale.set(...c.half); // a box's half extents
      return sdf;
    });
    if (!sdfs.length) return null;
    const edit = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, sdfs });
    for (const sdf of sdfs) edit.add(sdf);
    return edit;
  }, [clearances]);

  useEffect(() => () => mesh.dispose(), [mesh]);
  useEffect(() => () => spark.dispose(), [spark]);

  return (
    <>
      <primitive object={spark} />
      <primitive object={mesh} />
      {clear && <primitive object={clear} />}
    </>
  );
}
