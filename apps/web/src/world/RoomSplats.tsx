import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Color, Quaternion, Vector3 } from "three";
import { buildSampleRoomSplats } from "@vcr/engine";

/**
 * Renders the room's Gaussian splats with Spark. Phase 1 builds the procedural sample room;
 * scanned rooms (Phase 4) pass a signed URL from the manifest instead: `new SplatMesh({ url })`.
 */
export function RoomSplats(props: { spacing: number; onCount?: (count: number) => void }) {
  const gl = useThree((s) => s.gl);
  const spark = useMemo(() => new SparkRenderer({ renderer: gl }), [gl]);
  const { spacing, onCount } = props;

  const mesh = useMemo(() => {
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
        onCount?.(count);
      },
    });
  }, [spacing, onCount]);

  useEffect(() => () => mesh.dispose(), [mesh]);
  useEffect(() => () => spark.dispose(), [spark]);

  return (
    <>
      <primitive object={spark} />
      <primitive object={mesh} />
    </>
  );
}
