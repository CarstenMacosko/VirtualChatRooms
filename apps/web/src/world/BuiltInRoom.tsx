import { useEffect, useMemo, useState } from "react";
import { type LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import { type Object3D, SRGBColorSpace, type Texture, VideoTexture } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  type BuiltInRoom as BuiltInRoomData,
  builtInRoomFingerprint,
  SCREEN_BORDER,
  SCREEN_DEPTH,
  type ScreenPart,
} from "@vcr/engine";
import { buildRoomScene, disposeModel, idleScreenTexture, SCREEN_NODE } from "./builtInRoomScene";
import type { RoomLoadState } from "./RoomSplats";

/** A shared screen the projector can show: someone else's, or your own. */
export type ProjectorTrack = RemoteVideoTrack | LocalVideoTrack;

/**
 * A built-in room: its 3D model (public/rooms/<id>.glb, exported from its parts in @vcr/engine,
 * so it matches its collision exactly), the room's lights, and a live projector screen showing
 * `projector`, the newest screen shared in the call. If the model is missing or older than the
 * parts, the room is built from its parts right here instead, which looks the same.
 */
export function BuiltInRoom({
  room,
  projector,
  onState,
}: {
  room: BuiltInRoomData;
  projector: ProjectorTrack | null;
  onState?: (state: RoomLoadState) => void;
}) {
  const model = useRoomModel(room);
  useEffect(
    () => onState?.(model ? { state: "ready", splats: 0 } : { state: "loading", progress: null }),
    [model, onState],
  );
  return (
    <group>
      {model && <primitive object={model} />}
      {room.parts.map((part, i) =>
        part.kind === "screen" ? <ProjectorScreen key={i} screen={part} track={projector} /> : null,
      )}
      {room.lights.map((light, i) => (
        <pointLight
          key={i}
          position={light.position}
          intensity={light.intensity}
          distance={light.distance}
          color={light.color}
        />
      ))}
    </group>
  );
}

/** Where a built-in room's model is served from. */
export const roomModelUrl = (room: BuiltInRoomData) => `/rooms/${room.id}.glb`;

/** The room's model, loaded (or built from its parts when that fails), with its screens hidden. */
function useRoomModel(room: BuiltInRoomData): Object3D | null {
  const [model, setModel] = useState<{ room: string; root: Object3D } | null>(null);
  useEffect(() => {
    let alive = true;
    // The loaded model owns its textures; a built one shares the painted pictures.
    let loaded: { root: Object3D; own: boolean } | null = null;
    const use = (root: Object3D, own: boolean) => {
      loaded = { root, own };
      // The live projector screens draw where the model's stand-ins are.
      root.traverse((o) => {
        if (o.name.startsWith(SCREEN_NODE)) o.visible = false;
      });
      if (alive) setModel({ room: room.id, root });
      else disposeModel(root, { textures: own });
    };
    new GLTFLoader()
      .loadAsync(roomModelUrl(room))
      .then((gltf) => {
        const fingerprint = gltf.scene.userData.fingerprint as unknown;
        if (fingerprint !== builtInRoomFingerprint(room)) {
          disposeModel(gltf.scene, { textures: true });
          throw new Error(`${roomModelUrl(room)} is out of date; re-export it`);
        }
        gltf.scene.traverse((o) => {
          const m = (o as { material?: { map?: Texture | null } }).material;
          if (m?.map) m.map.anisotropy = 4;
        });
        use(gltf.scene, true);
      })
      .catch((error: unknown) => {
        console.warn("Drawing the room from its parts:", error);
        if (alive) use(buildRoomScene(room), false);
      });
    return () => {
      alive = false;
      if (loaded) disposeModel(loaded.root, { textures: loaded.own });
    };
  }, [room]);
  return model?.room === room.id ? model.root : null;
}

// --- the projector screen --------------------------------------------------------------------

/**
 * What the projector tells LiveKit about where it shows a remote screen: always visible, at full
 * HD. With adaptive streaming LiveKit only sends video to elements it can see on the page, and the
 * projector draws into WebGL, not a visible <video>.
 */
function projectorElementInfo(element: HTMLVideoElement) {
  return {
    element,
    width: () => 1920,
    height: () => 1080,
    visible: true,
    pictureInPicture: false,
    visibilityChangedAt: 0,
    observe() {},
    stopObserving() {},
  };
}

/** The shared screen as a texture, and its aspect once the first frame's size is known. */
function useScreenTexture(track: ProjectorTrack | null) {
  const [screen, setScreen] = useState<{ texture: VideoTexture; aspect: number } | null>(null);
  useEffect(() => {
    if (!track) return;
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    // Kept in the page (iOS only decodes video elements that are), but invisible.
    Object.assign(video.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "2px",
      height: "2px",
      opacity: "0",
      pointerEvents: "none",
    });
    document.body.appendChild(video);
    video.srcObject = new MediaStream([track.mediaStreamTrack]);
    const texture = new VideoTexture(video);
    texture.colorSpace = SRGBColorSpace;
    let alive = true;
    const sized = () => {
      if (alive && video.videoWidth > 0 && video.videoHeight > 0) {
        setScreen({ texture, aspect: video.videoWidth / video.videoHeight });
      }
    };
    video.addEventListener("loadedmetadata", sized);
    video.addEventListener("resize", sized);
    void video.play().catch(() => {});
    const info = track instanceof RemoteVideoTrack ? projectorElementInfo(video) : null;
    if (info) (track as RemoteVideoTrack).observeElementInfo(info);
    return () => {
      alive = false;
      if (info) (track as RemoteVideoTrack).stopObservingElementInfo(info);
      video.removeEventListener("loadedmetadata", sized);
      video.removeEventListener("resize", sized);
      video.pause();
      video.srcObject = null;
      video.remove();
      texture.dispose();
      setScreen(null);
    };
  }, [track]);
  return screen;
}

/**
 * A projector screen showing `track` (or a hint to share), facing `yaw`. `bezel` adds a frame
 * reaching back into the wall, as deep as the scan is cleared behind it (`screenClearance`).
 */
export function ProjectorScreen({
  screen: part,
  track,
  bezel = false,
}: {
  screen: Pick<ScreenPart, "center" | "size" | "yaw">;
  track: ProjectorTrack | null;
  bezel?: boolean;
}) {
  const screen = useScreenTexture(track);
  const idle = useMemo(() => idleScreenTexture(track ? "loading" : "idle"), [track]);
  const [w, h] = part.size;
  // The shared screen fits inside the projector screen, letterboxed in black.
  const fit: [number, number] = screen
    ? screen.aspect > w / h
      ? [w, w / screen.aspect]
      : [h * screen.aspect, h]
    : [w, h];
  return (
    <group position={part.center} rotation-y={part.yaw}>
      {bezel && (
        <mesh position={[0, 0, -SCREEN_DEPTH / 2 - 0.002]}>
          <boxGeometry args={[w + 2 * SCREEN_BORDER, h + 2 * SCREEN_BORDER, SCREEN_DEPTH]} />
          <meshStandardMaterial color="#15181d" roughness={0.5} metalness={0.3} />
        </mesh>
      )}
      <mesh>
        <planeGeometry args={part.size} />
        {/* Separate materials (keys): one material switching between them keeps a stale shader. */}
        {screen ? (
          <meshBasicMaterial key="letterbox" color="#000000" />
        ) : (
          <meshBasicMaterial key="idle" map={idle} toneMapped={false} />
        )}
      </mesh>
      {screen && (
        <mesh position={[0, 0, 0.004]}>
          <planeGeometry args={fit} />
          <meshBasicMaterial map={screen.texture} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}
