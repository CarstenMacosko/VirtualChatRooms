import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import type { ExpressionWeights } from "@vcr/engine";
import { type AvatarRecipe, type EmoteId, LocoState } from "@vcr/protocol";
import { AvatarInstance } from "./AvatarInstance";

export interface AvatarPreviewProps {
  recipe: AvatarRecipe;
  mood?: Partial<ExpressionWeights>;
  /** Changing `at` plays the emote. */
  emote?: { id: EmoteId; at: number } | null;
  focus?: "face" | "body";
}

const VIEWS = {
  body: { position: [0, 1.05, 3.9] as const, target: [0, 0.9, 0] as const },
  face: { position: [0, 1.52, 1.35] as const, target: [0, 1.48, 0] as const },
};

function Avatar(props: AvatarPreviewProps) {
  const [avatar] = useState(() => new AvatarInstance(props.recipe));
  useEffect(() => avatar.setRecipe(props.recipe), [avatar, props.recipe]);
  useEffect(() => avatar.setMood(props.mood ?? {}), [avatar, props.mood]);
  useEffect(() => {
    if (props.emote) avatar.playEmote(props.emote.id);
  }, [avatar, props.emote]);
  useEffect(() => () => avatar.dispose(), [avatar]);
  useFrame((_, dt) => {
    avatar.update(Math.min(dt, 0.1), {
      position: [0, 0, 0],
      yaw: 0,
      loco: LocoState.idle,
      speed: 0,
    });
  });
  return <primitive object={avatar.root} />;
}

/** Moves the camera when the creator switches between face and full-body views. */
function Focus({ focus }: { focus: "face" | "body" }) {
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    const [x, y, z] = VIEWS[focus].position;
    camera.position.set(x, y, z);
  }, [camera, focus]);
  return null;
}

/** The creator's live, orbitable preview of an avatar. */
export default function AvatarPreview(props: AvatarPreviewProps) {
  const view = VIEWS[props.focus ?? "body"];
  return (
    <Canvas camera={{ fov: 32, near: 0.05, far: 20, position: [...view.position] }}>
      <hemisphereLight args={["#fff8ee", "#6b5a4a", 1.4]} />
      <ambientLight intensity={0.45} />
      <directionalLight position={[1.5, 3, 2.5]} intensity={1.3} />
      <directionalLight position={[-2, 1.5, -1.5]} intensity={0.45} color="#9fb4ff" />
      <Avatar {...props} />
      <Focus focus={props.focus ?? "body"} />
      <OrbitControls
        key={props.focus}
        target={[...view.target]}
        enablePan={false}
        minDistance={0.6}
        maxDistance={4}
        minPolarAngle={0.6}
        maxPolarAngle={1.9}
      />
    </Canvas>
  );
}
