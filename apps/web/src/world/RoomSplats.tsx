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
import { Color, Quaternion, Vector3 } from "three";
import { buildSampleRoomSplats, type Clearance } from "@vcr/engine";
import type { SceneAssets } from "@vcr/protocol";
import { assetUrl } from "../lib/api";

export type RoomLoadState =
  | { state: "loading"; progress: number | null }
  | { state: "ready"; splats: number }
  | { state: "error"; message: string };

/**
 * Renders the room's Gaussian splats with Spark: the procedural sample room, or a scanned room
 * loaded from its signed URL and placed in the world by the manifest's transform. Splats inside
 * `clearances` are hidden (see `roomClearances`).
 */
export function RoomSplats(props: {
  spacing: number;
  scene: SceneAssets | null;
  clearances: readonly Clearance[];
  onState?: (state: RoomLoadState) => void;
}) {
  const gl = useThree((s) => s.gl);
  const spark = useMemo(() => new SparkRenderer({ renderer: gl }), [gl]);
  const { spacing, scene, clearances, onState } = props;

  const mesh = useMemo(() => {
    const splat = scene?.manifest.splat;
    if (scene && splat) {
      const { transform } = scene.manifest;
      const url = scene.urls[splat.key];
      const scanned = new SplatMesh({
        url: url ? assetUrl(url) : "",
        fileType: splat.format === "ply" ? SplatFileType.PLY : SplatFileType.SPZ,
        onProgress: (e) =>
          onState?.({ state: "loading", progress: e.total ? e.loaded / e.total : null }),
      });
      // world = translation + metersPerUnit · rotation(file): Object3D's T·R·S exactly.
      scanned.position.set(...transform.translation);
      scanned.quaternion.set(...transform.rotation);
      scanned.scale.setScalar(transform.metersPerUnit);
      scanned.initialized.then(
        () => onState?.({ state: "ready", splats: splat.count }),
        (err: unknown) =>
          onState?.({ state: "error", message: `Couldn't load this room (${String(err)}).` }),
      );
      return scanned;
    }
    const center = new Vector3();
    const scale = new Vector3();
    const quat = new Quaternion();
    const color = new Color();
    return new SplatMesh({
      constructSplats: (splats) => {
        const count = buildSampleRoomSplats(spacing, (c, s, q, opacity, rgb) => {
          splats.pushSplat(
            center.set(...c),
            scale.set(...s),
            quat.set(...q),
            opacity,
            color.setRGB(...rgb),
          );
        });
        onState?.({ state: "ready", splats: count });
      },
    });
  }, [spacing, scene, onState]);

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
