import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Color, Euler, Group, PerspectiveCamera, Quaternion, Vector3 } from "three";
import {
  autopilotStep,
  CameraRig,
  CharacterController,
  type DeviceProfile,
  forwardFromYaw,
  InputSystem,
  lerp,
  PHYSICS_DT,
  PhysicsWorld,
  type PoseHub,
  PoseSender,
  rightFromYaw,
  type RoomLayout,
  SAMPLE_ROOM_LAYOUT,
  sampleRoomColliders,
  scannedRoomLayout,
  seatedCameraBody,
  spawnPointFor,
  type Vec3,
} from "@vcr/engine";
import type { AvatarRecipe, ParticipantView, Quat, SceneAssets } from "@vcr/protocol";
import { EMOTE_DURATION_MS, EMOTE_GLYPHS } from "../components/emotes";
import { recipeOf } from "../lib/avatar";
import type { ActiveEmote } from "../lib/realm";
import type { TrackedFace } from "../media/FaceTracker";
import { LOCAL_VOICE, type SpatialAudio } from "../media/SpatialAudio";
import { AVATAR_LAYER, AvatarInstance } from "./AvatarInstance";
import { addRoomColliders, loadRoomCollision } from "./collision";
import { headshotTargets } from "./headshots";
import { RoomMesh } from "./RoomMesh";
import { type RoomLoadState, RoomSplats } from "./RoomSplats";
import {
  LocalSeating,
  promptKey,
  remotePlacement,
  remoteSeat,
  type SeatingLink,
  type SeatPrompt,
  SeatPromptView,
} from "./sitting";
import { TouchControls } from "./TouchControls";

export interface Autopilot {
  targetId: string | null;
}

/** Label anchors above each avatar's head, keyed by realm session id. */
type Anchors = Map<string, Vec3>;
type LabelMap = Map<string, HTMLDivElement>;

const LABEL_HEIGHT = 2.0;
/** How much lower a seated person's label sits. */
const SEATED_LABEL_DROP = 0.45;
const MAX_STEPS_PER_FRAME = 5;

export interface WorldProps {
  participants: ParticipantView[];
  selfId: string | null;
  emotes: Record<string, ActiveEmote>;
  now: number;
  poseHub: PoseHub;
  /** Voices follow avatars; the listener follows the camera. */
  audio: SpatialAudio | null;
  /** Set `targetId` to walk your avatar over to that person; moving yourself cancels it. */
  autopilotRef: RefObject<Autopilot>;
  /** Your face from the webcam while face tracking is on; null otherwise. */
  trackedFaceRef: RefObject<TrackedFace | null>;
  profile: DeviceProfile;
  /** A scanned room's manifest and signed URLs; null for the built-in sample room. */
  scene: SceneAssets | null;
  debug: boolean;
  /** Seat claims through the realm (ADR 0020); without it you can still sit, unshared. */
  seating?: SeatingLink;
}

/** The shared 3D room: splats, physics, your avatar, everyone else, cameras and name labels. */
export default function World(props: WorldProps) {
  const [sim, setSim] = useState<Sim | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input] = useState(() => new InputSystem());
  const [roomState, setRoomState] = useState<RoomLoadState>({ state: "loading", progress: null });
  const splatCount = roomState.state === "ready" ? roomState.splats : 0;
  const anchors = useRef<Anchors>(new Map());
  const labels = useRef<LabelMap>(new Map());
  const stats = useRef<HTMLPreElement>(null);
  const [seatPrompt, setSeatPrompt] = useState<SeatPrompt>(null);

  const self = props.participants.find((p) => p.id === props.selfId);
  const selfUserId = self?.userId;
  const { poseHub, scene } = props;
  // Read when the simulation is created; later changes go through setRecipe.
  const selfRecipe = useRef<AvatarRecipe | null>(null);
  useEffect(() => {
    if (self) selfRecipe.current = recipeOf(self);
  }, [self]);

  // Physics and your character are created once per signed-in user, so a realm reconnect keeps
  // your place in the room. Doing this in an async callback (not render) keeps StrictMode's double
  // mount from leaving a stray character collider behind.
  useEffect(() => {
    if (!selfUserId) return;
    let alive = true;
    let created: Sim | null = null;
    Promise.all([PhysicsWorld.create(), loadColliders(scene)])
      .then(([physics, colliders]) => {
        if (!alive) return physics.dispose();
        created = createSim(
          physics,
          colliders,
          poseHub,
          selfUserId,
          selfRecipe.current ?? recipeOf({ userId: selfUserId, avatar: "" }),
        );
        setSim(created);
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(`Couldn't load this room. ${String(err)}`);
      });
    return () => {
      alive = false;
      if (created) disposeSim(created);
    };
  }, [selfUserId, poseHub, scene]);

  const attachInput = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      input.attach(el);
      return () => input.detach();
    },
    [input],
  );

  return (
    <div className="world" ref={attachInput}>
      {sim ? (
        <Canvas
          gl={{ antialias: false }}
          dpr={[1, props.profile.maxDpr]}
          camera={{ fov: 60, near: 0.05, far: 100 }}
        >
          <color attach="background" args={["#0f1424"]} />
          <hemisphereLight args={["#fff8ee", "#6b5a4a", 1.3]} />
          <ambientLight color={sim.layout.lighting.ambientColor} intensity={0.4} />
          <directionalLight position={[2, 4, 3]} intensity={1.2} />
          {scene?.manifest.mesh ? (
            <RoomMesh scene={scene} onState={setRoomState} />
          ) : (
            <RoomSplats spacing={props.profile.splatSpacing} scene={scene} onState={setRoomState} />
          )}
          <Simulation
            sim={sim}
            input={input}
            poseHub={poseHub}
            audio={props.audio}
            autopilotRef={props.autopilotRef}
            trackedFaceRef={props.trackedFaceRef}
            emotes={props.emotes}
            selfId={props.selfId}
            participants={props.participants}
            anchors={anchors}
            labels={labels}
            stats={props.debug ? stats : null}
            splatCount={splatCount}
            seating={props.seating}
            onSeatPrompt={setSeatPrompt}
          />
        </Canvas>
      ) : (
        <div className="world-loading">{loadError ?? "Loading room…"}</div>
      )}
      {sim && roomState.state !== "ready" && (
        <div className="world-loading overlay">
          {roomState.state === "error"
            ? roomState.message
            : `Loading room…${roomState.progress !== null ? ` ${Math.round(roomState.progress * 100)}%` : ""}`}
        </div>
      )}

      <div className="labels" aria-hidden>
        {props.participants.map((p) => {
          const emote = props.emotes[p.id];
          const showEmote = emote && props.now - emote.at < EMOTE_DURATION_MS;
          return (
            <div
              key={p.id}
              className="nameplate"
              style={{ display: "none" }}
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

      {sim && <SeatPromptView prompt={seatPrompt} touch={props.profile.touch} input={input} />}
      {props.profile.touch ? (
        <TouchControls input={input} />
      ) : (
        <p className="controls-hint">
          WASD to move · Shift to run · Space to jump · E to sit · drag to look · scroll to zoom · V
          for first person
        </p>
      )}
      {props.debug && <pre className="debug-stats" ref={stats} />}
    </div>
  );
}

/**
 * The room's collision geometry: the sample room's boxes, or a scan's collision mesh (a GLB in
 * the scan's file space) moved into the world by the manifest transform, with its walkways
 * opened up.
 */
type Colliders = { layout: RoomLayout; add(physics: PhysicsWorld): void };

async function loadColliders(scene: SceneAssets | null): Promise<Colliders> {
  if (!scene) {
    return {
      layout: SAMPLE_ROOM_LAYOUT,
      add: (physics) => sampleRoomColliders().forEach((box) => physics.addBox(box)),
    };
  }
  const collision = await loadRoomCollision(scene);
  const layout = scannedRoomLayout(scene.manifest);
  return { layout, add: (physics) => addRoomColliders(physics, collision, layout.walkways) };
}

const pitchQuat = (pitch: number): Quat => [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)];

const scratchQuat = new Quaternion();
const scratchEuler = new Euler();
const clampLook = (v: number) => Math.max(-0.7, Math.min(0.7, v));
/** Head rotation from a pose's head quaternion, limited to what a neck can do. */
function headLookFromQuat(q: Quat) {
  scratchEuler.setFromQuaternion(scratchQuat.set(...q), "XYZ");
  return {
    pitch: clampLook(scratchEuler.x),
    yaw: clampLook(scratchEuler.y),
    roll: clampLook(scratchEuler.z),
  };
}

interface Sim {
  physics: PhysicsWorld;
  layout: RoomLayout;
  spawn: { position: Vec3; yaw: number };
  character: CharacterController;
  rig: CameraRig;
  sender: PoseSender;
  local: AvatarInstance;
  seating: LocalSeating;
}

/** Mutable per-frame bookkeeping for the simulation loop. */
interface LoopState {
  accumulator: number;
  previous: Vec3;
  pendingJump: boolean;
  frames: number;
  statsAt: number;
  /** The seat prompt last shown, so React only hears about changes. */
  promptKey: string;
}

function createSim(
  physics: PhysicsWorld,
  colliders: Colliders,
  poseHub: PoseHub,
  userId: string,
  recipe: AvatarRecipe,
): Sim {
  colliders.add(physics);
  const spawn = spawnPointFor(userId, colliders.layout);
  const character = new CharacterController(physics, spawn);
  return {
    physics,
    layout: colliders.layout,
    spawn,
    character,
    rig: new CameraRig(spawn.yaw),
    sender: new PoseSender((bytes) => poseHub.send(bytes)),
    local: new AvatarInstance(recipe),
    seating: new LocalSeating(character, colliders.layout),
  };
}

function disposeSim(sim: Sim) {
  sim.local.dispose();
  sim.character.dispose();
  sim.physics.dispose();
}

function Simulation(props: {
  sim: Sim;
  input: InputSystem;
  poseHub: PoseHub;
  audio: SpatialAudio | null;
  autopilotRef: RefObject<Autopilot>;
  trackedFaceRef: RefObject<TrackedFace | null>;
  emotes: Record<string, ActiveEmote>;
  /** Null while reconnecting to the realm; the room keeps running locally meanwhile. */
  selfId: string | null;
  participants: ParticipantView[];
  anchors: RefObject<Anchors>;
  labels: RefObject<LabelMap>;
  stats: RefObject<HTMLPreElement | null> | null;
  splatCount: number;
  seating: SeatingLink | undefined;
  onSeatPrompt(prompt: SeatPrompt): void;
}) {
  const { sim, input, poseHub, audio, autopilotRef, trackedFaceRef, selfId, anchors, labels } =
    props;
  const { physics } = sim;
  const size = useThree((s) => s.size);

  // Remote avatars follow the roster.
  const remoteGroup = useMemo(() => new Group(), []);
  const remotes = useRef(new Map<string, AvatarInstance>());
  useEffect(() => {
    const ids = new Set(props.participants.filter((p) => p.id !== selfId).map((p) => p.id));
    for (const [id, avatar] of remotes.current) {
      if (!ids.has(id)) {
        avatar.dispose();
        remotes.current.delete(id);
        anchors.current.delete(id);
        audio?.forget(id);
      }
    }
    for (const p of props.participants) {
      if (p.id === selfId) {
        sim.local.setRecipe(recipeOf(p)); // no-op unless they changed their avatar
        continue;
      }
      const existing = remotes.current.get(p.id);
      if (existing) {
        existing.setRecipe(recipeOf(p));
        continue;
      }
      const avatar = new AvatarInstance(recipeOf(p));
      avatar.root.visible = false; // until their first pose arrives
      remoteGroup.add(avatar.root);
      remotes.current.set(p.id, avatar);
    }
    poseHub.retain(ids);
  }, [props.participants, selfId, poseHub, audio, remoteGroup, anchors, sim]);

  // Emotes play on the avatars as well as showing a bubble.
  const playedEmotes = useRef(new Map<string, number>());
  useEffect(() => {
    for (const [id, { emote, at }] of Object.entries(props.emotes)) {
      if ((playedEmotes.current.get(id) ?? 0) >= at) continue;
      playedEmotes.current.set(id, at);
      const avatar = id === selfId ? sim.local : remotes.current.get(id);
      avatar?.playEmote(emote);
    }
  }, [props.emotes, selfId, sim]);
  useEffect(() => {
    const map = remotes.current;
    return () => map.forEach((a) => a.dispose());
  }, []);

  const projected = useMemo(() => new Vector3(), []);
  const facing = useMemo(() => new Vector3(), []);
  const loop = useRef<LoopState>({
    accumulator: 0,
    previous: [...sim.spawn.position],
    pendingJump: false,
    frames: 0,
    statsAt: 0,
    promptKey: "",
  });

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const now = performance.now();
    const { character, rig } = sim;
    const l = loop.current;

    // 1. Input → intents → camera and movement command.
    const intents = input.sample(dt);
    rig.applyIntents(intents);
    if (intents.jump) l.pendingJump = true;
    const firstPerson = rig.mode === "first";
    const fwd = forwardFromYaw(rig.yaw);
    const right = rightFromYaw(rig.yaw);
    let move = {
      x: fwd.x * intents.move.y + right.x * intents.move.x,
      z: fwd.z * intents.move.y + right.z * intents.move.x,
    };
    let run = intents.run;

    // Sitting: offer the seat in front of you, claim it, or get up (ADR 0020).
    const prompt = sim.seating.update(now, intents, input, props.seating);
    if (promptKey(prompt) !== l.promptKey) {
      l.promptKey = promptKey(prompt);
      props.onSeatPrompt(prompt);
    }

    // "Walk over to them" (double-clicked a tile), until you steer yourself or arrive.
    const targetId = autopilotRef.current.targetId;
    if (targetId) {
      const target = poseHub.sample(targetId, now);
      const steering = Math.hypot(intents.move.x, intents.move.y) > 0.1 || intents.jump;
      if (!target || steering) {
        autopilotRef.current.targetId = null;
      } else {
        const p = sim.character.current.position;
        const step = autopilotStep(
          { x: p[0], z: p[2] },
          { x: target.position[0], z: target.position[2] },
        );
        if (step.arrived) autopilotRef.current.targetId = null;
        move = step.move;
        run = step.run;
      }
    }

    // 2. Fixed-step physics; render interpolates between the last two steps.
    l.accumulator += dt;
    let steps = 0;
    while (l.accumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_FRAME) {
      l.previous = [...character.current.position];
      character.step(PHYSICS_DT, {
        move,
        run,
        jump: l.pendingJump,
        faceYaw: firstPerson ? rig.yaw : undefined,
      });
      l.pendingJump = false;
      physics.step();
      l.accumulator -= PHYSICS_DT;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) l.accumulator = 0; // tab was in the background
    const c = character.current;
    if (c.position[1] < sim.layout.bounds.min[1] - 5) {
      character.teleport(sim.spawn.position, sim.spawn.yaw); // fell out of the world
    }
    const alpha = l.accumulator / PHYSICS_DT;
    const feet: Vec3 = [
      lerp(l.previous[0], c.position[0], alpha),
      lerp(l.previous[1], c.position[1], alpha),
      lerp(l.previous[2], c.position[2], alpha),
    ];

    // 3. Local avatar, outgoing pose, camera.
    const tracked = trackedFaceRef.current;
    sim.local.setHeadVisible(!firstPerson);
    sim.local.setFace({
      tracked: tracked?.blendshapes ?? null,
      voice: audio?.levelOf(LOCAL_VOICE) ?? 0,
    });
    sim.local.update(dt, {
      position: feet,
      yaw: c.yaw,
      loco: c.loco,
      speed: c.speed,
      lookPitch: firstPerson ? rig.pitch : 0,
      ...(character.seat && { seatHeight: character.seat.seat.height }),
      ...(tracked && { headLook: headLookFromQuat(tracked.head) }),
    });
    // Others see your tracked head turn, or (in first person) where you're looking.
    const head = tracked ? tracked.head : firstPerson ? pitchQuat(rig.pitch * 0.6) : undefined;
    sim.sender.update(now, {
      position: c.position,
      yaw: c.yaw,
      loco: c.loco,
      ...(c.seatId !== undefined && { seatId: c.seatId }),
      ...(head && { head }),
      ...(tracked && { face: tracked.blendshapes }),
    });
    const cam = rig.compute(
      feet,
      (origin, dir, max) => physics.castRay(origin, dir, max, character.collider),
      dt,
      seatedCameraBody(character.seat?.seat.height ?? 0, c.sitAmount),
    );
    state.camera.position.set(...cam.position);
    state.camera.lookAt(...cam.lookAt);
    if (audio) {
      state.camera.getWorldDirection(facing);
      audio.setListener(cam.position, [facing.x, facing.y, facing.z]);
    }
    if (selfId) {
      if (firstPerson) anchors.current.delete(selfId);
      else {
        const height = LABEL_HEIGHT - SEATED_LABEL_DROP * c.sitAmount;
        anchors.current.set(selfId, [feet[0], feet[1] + height, feet[2]]);
      }
    }

    // 4. Remote avatars from their interpolation buffers.
    for (const [id, avatar] of remotes.current) {
      const pose = poseHub.sample(id, now);
      if (!pose || pose.stale) {
        avatar.setVisible(false);
        anchors.current.delete(id);
        continue;
      }
      avatar.setVisible(true);
      // Seated people sit on the seat from our own copy of the layout.
      const seat = remoteSeat(pose, sim.layout);
      const { position, yaw } = remotePlacement(pose, seat);
      audio?.setPosition(id, position);
      avatar.setFace({ tracked: pose.face ?? null, voice: audio?.levelOf(id) ?? 0 });
      avatar.update(dt, {
        position,
        yaw,
        loco: pose.loco,
        speed: pose.speed,
        ...(seat && { seatHeight: seat.height }),
        ...(pose.head && { headLook: headLookFromQuat(pose.head) }),
      });
      const label = LABEL_HEIGHT - (seat ? SEATED_LABEL_DROP : 0);
      anchors.current.set(id, [position[0], position[1] + label, position[2]]);
    }

    // 5. Name labels follow anchors in screen space.
    for (const [id, el] of labels.current) {
      const anchor = anchors.current.get(id);
      projected.set(...(anchor ?? [0, 0, 0])).project(state.camera);
      const visible = anchor !== undefined && projected.z <= 1; // z > 1: behind the camera
      placeLabel(
        el,
        visible
          ? {
              x: (projected.x * 0.5 + 0.5) * size.width,
              y: (-projected.y * 0.5 + 0.5) * size.height,
            }
          : null,
      );
    }

    // 6. Debug stats (?debug).
    l.frames++;
    if (props.stats?.current && now - l.statsAt > 500) {
      const fps = (l.frames * 1000) / (now - l.statsAt);
      writeText(props.stats.current, [
        `fps ${fps.toFixed(0)}`,
        `splats ${props.splatCount.toLocaleString()}`,
        `people ${remotes.current.size + 1}`,
        `pos ${c.position.map((v) => v.toFixed(2)).join(", ")}`,
        `loco ${c.loco} · ${c.grounded ? "grounded" : "airborne"} · ${rig.mode}`,
        `poses in · livekit ${poseHub.received.direct} · relay ${poseHub.received.relayed}`,
        `dropped packets ${poseHub.dropped}`,
      ]);
      l.frames = 0;
      l.statsAt = now;
    }
  });

  // Headshots for camera-off tiles, then the main view. A frame callback with priority 1 makes R3F
  // leave rendering to us, so the headshot draws happen in the same frame, before the main render.
  const headshot = useMemo(() => {
    const camera = new PerspectiveCamera(26, 1, 0.05, 10);
    camera.layers.set(AVATAR_LAYER);
    return { camera, at: new Vector3(), background: new Color() };
  }, []);
  const headshotTurnRef = useRef({ next: 0, cursor: 0 });
  const lightsOnAvatarLayer = useRef(false);
  useFrame((state) => {
    const { gl, scene, camera } = state;
    const now = performance.now();
    const targets = [...headshotTargets.entries()];
    const turn = headshotTurnRef.current;
    if (targets.length > 0 && now >= turn.next) {
      turn.next = now + 120;
      if (!lightsOnAvatarLayer.current) {
        scene.traverse((o) => {
          if ((o as { isLight?: boolean }).isLight) o.layers.enable(AVATAR_LAYER);
        });
        lightsOnAvatarLayer.current = true;
      }
      const previousBackground = scene.background;
      const pixelRatio = gl.getPixelRatio();
      // A few per frame, round-robin, so 25 tiles cost about the same as 4.
      for (let n = 0; n < Math.min(4, targets.length); n++) {
        const [id, canvases] = targets[turn.cursor++ % targets.length]!;
        const avatar = id === selfId ? sim.local : remotes.current.get(id);
        if (!avatar?.loaded || !avatar.root.visible) continue;
        const list = [...canvases];
        const px = Math.max(...list.map((t) => t.canvas.width));
        let drawn = false;
        avatar.withHeadShown(() => {
          avatar.root.updateMatrixWorld(true);
          if (!avatar.faceWorldPosition(headshot.at)) return;
          const yaw = avatar.root.rotation.y;
          headshot.camera.position.set(
            headshot.at.x + Math.sin(yaw) * 1.05,
            headshot.at.y + 0.03,
            headshot.at.z + Math.cos(yaw) * 1.05,
          );
          headshot.camera.lookAt(headshot.at);
          headshot.camera.updateMatrixWorld();
          scene.background = headshot.background.set(list[0]!.color);
          gl.setScissorTest(true);
          gl.setScissor(0, 0, px / pixelRatio, px / pixelRatio);
          gl.setViewport(0, 0, px / pixelRatio, px / pixelRatio);
          gl.render(scene, headshot.camera);
          drawn = true;
        });
        if (!drawn) continue;
        const source = gl.domElement;
        for (const { canvas } of list) {
          canvas
            .getContext("2d")
            ?.drawImage(source, 0, source.height - px, px, px, 0, 0, canvas.width, canvas.height);
        }
      }
      scene.background = previousBackground;
      gl.setScissorTest(false);
      gl.setViewport(0, 0, state.size.width, state.size.height);
    }
    gl.render(scene, camera);
  }, 1);

  return (
    <>
      <primitive object={sim.local.root} />
      <primitive object={remoteGroup} />
    </>
  );
}

/** Positions a name label in screen space, or hides it when `at` is null. */
function placeLabel(el: HTMLElement, at: { x: number; y: number } | null) {
  if (!at) {
    el.style.display = "none";
    return;
  }
  el.style.display = "";
  el.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, -100%)`;
}

function writeText(el: HTMLElement, lines: string[]) {
  el.textContent = lines.join("\n");
}
