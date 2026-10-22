import { Grid, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useMemo, useRef } from "react";
import { Vector3 } from "three";
import type { ParticipantView } from "@vcr/protocol";
import type { ActiveEmote } from "../lib/realm";
import { colorFor, EMOTE_DURATION_MS, EMOTE_GLYPHS } from "./emotes";

type Vec3 = [number, number, number];
type LabelMap = Map<string, HTMLDivElement>;

const LABEL_HEIGHT = 2.1;

/**
 * Phase 0 placeholder scene: a floor and one capsule per participant, arranged in a circle.
 * Phase 1 replaces it with the splat room, VRM avatars and real movement.
 */
export function LobbyScene(props: {
  participants: ParticipantView[];
  selfId: string | null;
  emotes: Record<string, ActiveEmote>;
  now: number;
}) {
  const labels = useRef<LabelMap>(new Map());
  const placed = useMemo(() => {
    const sorted = [...props.participants].sort((a, b) => a.id.localeCompare(b.id));
    const radius = sorted.length === 1 ? 0 : Math.max(1.5, sorted.length * 0.45);
    return sorted.map((p, i) => {
      // Start at the side rather than the front so small groups stand side by side on screen.
      const angle = (i / sorted.length) * Math.PI * 2 + Math.PI / 2;
      const position: Vec3 = [Math.sin(angle) * radius, 0, Math.cos(angle) * radius];
      return { ...p, position };
    });
  }, [props.participants]);

  return (
    <>
      <Canvas camera={{ position: [0, 4, 8], fov: 50 }} shadows="percentage">
        <color attach="background" args={["#0f1424"]} />
        <hemisphereLight args={["#cfe3ff", "#2a2238", 0.9]} />
        <directionalLight position={[4, 8, 3]} intensity={1.4} castShadow />
        <Grid
          infiniteGrid
          cellSize={0.5}
          sectionSize={2}
          cellColor="#2b3557"
          sectionColor="#4b5b94"
          fadeDistance={30}
        />

        {placed.map((p) => (
          <group key={p.id} position={p.position}>
            <mesh position={[0, 0.85, 0]} castShadow>
              <capsuleGeometry args={[0.35, 1, 8, 16]} />
              <meshStandardMaterial color={colorFor(p.userId)} roughness={0.5} />
            </mesh>
            {p.id === props.selfId && (
              <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.01, 0]}>
                <ringGeometry args={[0.5, 0.6, 48]} />
                <meshBasicMaterial color="#ffffff" />
              </mesh>
            )}
          </group>
        ))}

        <LabelProjector anchors={placed} labels={labels} />
        <OrbitControls
          makeDefault
          maxPolarAngle={Math.PI / 2.1}
          minDistance={3}
          maxDistance={20}
          target={[0, 1, 0]}
        />
      </Canvas>

      <div className="labels" aria-hidden>
        {placed.map((p) => {
          const emote = props.emotes[p.id];
          const showEmote = emote && props.now - emote.at < EMOTE_DURATION_MS;
          return (
            <div
              key={p.id}
              className="nameplate"
              ref={(el) => {
                if (!el) return;
                labels.current.set(p.id, el);
                return () => {
                  labels.current.delete(p.id);
                };
              }}
            >
              {showEmote && <span className="emote-bubble">{EMOTE_GLYPHS[emote.emote]}</span>}
              {p.name}
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * Moves DOM name labels to follow avatars by projecting their head positions each frame.
 * Cheaper than one React root per label, which matters at 25 people.
 */
function LabelProjector(props: {
  anchors: { id: string; position: Vec3 }[];
  labels: RefObject<LabelMap>;
}) {
  const { camera, size } = useThree();
  const v = useMemo(() => new Vector3(), []);

  useFrame(() => {
    for (const { id, position } of props.anchors) {
      const el = props.labels.current.get(id);
      if (!el) continue;
      v.set(position[0], position[1] + LABEL_HEIGHT, position[2]).project(camera);
      const x = (v.x * 0.5 + 0.5) * size.width;
      const y = (-v.y * 0.5 + 0.5) * size.height;
      el.style.display = v.z < 1 ? "" : "none"; // hide labels behind the camera
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    }
  });

  return null;
}
