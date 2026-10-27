import type { PlaySurface } from "@vcr/engine";

/** A warm tabletop wood, so the slab reads as the table itself rather than something on it. */
const SURFACE_COLOR = "#7a5638";

/**
 * The smooth slabs laid over game tables (see `playSurfaces`). The room renderers hide the scan
 * inside them, and games draw on their tops.
 */
export function PlaySurfaces({ surfaces }: { surfaces: readonly PlaySurface[] }) {
  return (
    <>
      {surfaces.map((s) => (
        <mesh
          key={s.id}
          position={[s.center[0], s.center[1] - s.thickness / 2, s.center[2]]}
          rotation-y={s.yaw}
        >
          <boxGeometry args={[s.size[0], s.thickness, s.size[1]]} />
          <meshStandardMaterial color={SURFACE_COLOR} roughness={0.65} />
        </mesh>
      ))}
    </>
  );
}
