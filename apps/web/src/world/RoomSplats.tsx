import { SparkRenderer, SplatFileType, SplatMesh } from "@sparkjsdev/spark";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Color, Quaternion, Vector3 } from "three";
import { buildSampleRoomSplats } from "@vcr/engine";
import type { SceneAssets } from "@vcr/protocol";
import { assetUrl } from "../lib/api";

export type RoomLoadState =
  | { state: "loading"; progress: number | null }
  | { state: "ready"; splats: number }
  | { state: "error"; message: string };

/**
 * Renders the room's Gaussian splats with Spark: the procedural sample room, or a scanned room
 * loaded from its signed URL and placed in the world by the manifest's transform.
 */
export function RoomSplats(props: {
  spacing: number;
  scene: SceneAssets | null;
  onState?: (state: RoomLoadState) => void;
}) {
  const gl = useThree((s) => s.gl);
  const spark = useMemo(() => new SparkRenderer({ renderer: gl }), [gl]);
  const { spacing, scene, onState } = props;

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

  useEffect(() => () => mesh.dispose(), [mesh]);
  useEffect(() => () => spark.dispose(), [spark]);

  return (
    <>
      <primitive object={spark} />
      <primitive object={mesh} />
    </>
  );
}
