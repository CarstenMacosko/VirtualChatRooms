import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Group, Vector3 } from "three";
import {
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
  SAMPLE_ROOM,
  sampleRoomColliders,
  type Vec3,
} from "@vcr/engine";
import type { ParticipantView, Quat } from "@vcr/protocol";
import { colorFor, EMOTE_DURATION_MS, EMOTE_GLYPHS } from "../components/emotes";
import type { ActiveEmote } from "../lib/realm";
import { AvatarInstance, PLACEHOLDER_AVATAR_URL } from "./AvatarInstance";
import { RoomSplats } from "./RoomSplats";
import { TouchControls } from "./TouchControls";

/** Label anchors above each avatar's head, keyed by realm session id. */
type Anchors = Map<string, Vec3>;
type LabelMap = Map<string, HTMLDivElement>;

const LABEL_HEIGHT = 2.0;
const MAX_STEPS_PER_FRAME = 5;

export interface WorldProps {
  participants: ParticipantView[];
  selfId: string | null;
  emotes: Record<string, ActiveEmote>;
  now: number;
  poseHub: PoseHub;
  profile: DeviceProfile;
  debug: boolean;
}

/** The shared 3D room: splats, physics, your avatar, everyone else, cameras and name labels. */
export default function World(props: WorldProps) {
  const [sim, setSim] = useState<Sim | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [input] = useState(() => new InputSystem());
  const [splatCount, setSplatCount] = useState(0);
  const anchors = useRef<Anchors>(new Map());
  const labels = useRef<LabelMap>(new Map());
  const stats = useRef<HTMLPreElement>(null);

  const self = props.participants.find((p) => p.id === props.selfId);
  const selfUserId = self?.userId;
  const { poseHub } = props;

  // Physics and your character are created once per signed-in user, so a realm reconnect keeps
  // your place in the room. Doing this in an async callback (not render) keeps StrictMode's double
  // mount from leaving a stray character collider behind.
  useEffect(() => {
    if (!selfUserId) return;
    let alive = true;
    let created: Sim | null = null;
    PhysicsWorld.create()
      .then((physics) => {
        if (!alive) return physics.dispose();
        created = createSim(physics, poseHub, selfUserId);
        setSim(created);
      })
      .catch((err: unknown) => alive && setLoadError(String(err)));
    return () => {
      alive = false;
      if (created) disposeSim(created);
    };
  }, [selfUserId, poseHub]);

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
          <ambientLight color={SAMPLE_ROOM.lighting.ambientColor} intensity={0.4} />
          <directionalLight position={[2, 4, 3]} intensity={1.2} />
          <RoomSplats spacing={props.profile.splatSpacing} onCount={setSplatCount} />
          <Simulation
            sim={sim}
            input={input}
            poseHub={poseHub}
            selfId={props.selfId}
            participants={props.participants}
            anchors={anchors}
            labels={labels}
            stats={props.debug ? stats : null}
            splatCount={splatCount}
          />
        </Canvas>
      ) : (
        <div className="world-loading">{loadError ?? "Loading room…"}</div>
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

      {props.profile.touch ? (
        <TouchControls input={input} />
      ) : (
        <p className="controls-hint">
          WASD to move · Shift to run · Space to jump · drag to look · scroll to zoom · V for first
          person
        </p>
      )}
      {props.debug && <pre className="debug-stats" ref={stats} />}
    </div>
  );
}

function spawnFor(id: string) {
  const [base] = SAMPLE_ROOM.spawnPoints;
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  // Spread people around the spawn point so they don't appear inside each other.
  const angle = ((Math.abs(hash) % 360) * Math.PI) / 180;
  const position: Vec3 = [
    base!.position[0] + Math.sin(angle) * 0.8,
    base!.position[1] + 0.05,
    base!.position[2] + Math.cos(angle) * 0.6,
  ];
  return { position, yaw: base!.yaw };
}

const pitchQuat = (pitch: number): Quat => [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)];
const pitchFromQuat = (q: Quat) => 2 * Math.atan2(q[0], q[3]);

interface Sim {
  physics: PhysicsWorld;
  spawn: { position: Vec3; yaw: number };
  character: CharacterController;
  rig: CameraRig;
  sender: PoseSender;
  local: AvatarInstance;
}

/** Mutable per-frame bookkeeping for the simulation loop. */
interface LoopState {
  accumulator: number;
  previous: Vec3;
  pendingJump: boolean;
  frames: number;
  statsAt: number;
}

function createSim(physics: PhysicsWorld, poseHub: PoseHub, userId: string): Sim {
  for (const box of sampleRoomColliders()) physics.addBox(box);
  const spawn = spawnFor(userId);
  return {
    physics,
    spawn,
    character: new CharacterController(physics, spawn),
    rig: new CameraRig(spawn.yaw),
    sender: new PoseSender((bytes) => poseHub.send(bytes)),
    local: new AvatarInstance(PLACEHOLDER_AVATAR_URL, colorFor(userId)),
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
  /** Null while reconnecting to the realm; the room keeps running locally meanwhile. */
  selfId: string | null;
  participants: ParticipantView[];
  anchors: RefObject<Anchors>;
  labels: RefObject<LabelMap>;
  stats: RefObject<HTMLPreElement | null> | null;
  splatCount: number;
}) {
  const { sim, input, poseHub, selfId, anchors, labels } = props;
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
      }
    }
    for (const p of props.participants) {
      if (p.id === selfId || remotes.current.has(p.id)) continue;
      const avatar = new AvatarInstance(PLACEHOLDER_AVATAR_URL, colorFor(p.userId));
      avatar.root.visible = false; // until their first pose arrives
      remoteGroup.add(avatar.root);
      remotes.current.set(p.id, avatar);
    }
    poseHub.retain(ids);
  }, [props.participants, selfId, poseHub, remoteGroup, anchors]);
  useEffect(() => {
    const map = remotes.current;
    return () => map.forEach((a) => a.dispose());
  }, []);

  const projected = useMemo(() => new Vector3(), []);
  const loop = useRef<LoopState>({
    accumulator: 0,
    previous: [...sim.spawn.position],
    pendingJump: false,
    frames: 0,
    statsAt: 0,
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
    const move = {
      x: fwd.x * intents.move.y + right.x * intents.move.x,
      z: fwd.z * intents.move.y + right.z * intents.move.x,
    };

    // 2. Fixed-step physics; render interpolates between the last two steps.
    l.accumulator += dt;
    let steps = 0;
    while (l.accumulator >= PHYSICS_DT && steps < MAX_STEPS_PER_FRAME) {
      l.previous = [...character.current.position];
      character.step(PHYSICS_DT, {
        move,
        run: intents.run,
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
    if (c.position[1] < SAMPLE_ROOM.bounds.min[1] - 5) {
      character.teleport(sim.spawn.position, sim.spawn.yaw); // fell out of the world
    }
    const alpha = l.accumulator / PHYSICS_DT;
    const feet: Vec3 = [
      lerp(l.previous[0], c.position[0], alpha),
      lerp(l.previous[1], c.position[1], alpha),
      lerp(l.previous[2], c.position[2], alpha),
    ];

    // 3. Local avatar, outgoing pose, camera.
    sim.local.setHeadVisible(!firstPerson);
    sim.local.update(dt, {
      position: feet,
      yaw: c.yaw,
      loco: c.loco,
      speed: c.speed,
      lookPitch: firstPerson ? rig.pitch : 0,
    });
    sim.sender.update(now, {
      position: c.position,
      yaw: c.yaw,
      loco: c.loco,
      ...(firstPerson && { head: pitchQuat(rig.pitch) }),
    });
    const cam = rig.compute(
      feet,
      (origin, dir, max) => physics.castRay(origin, dir, max, character.collider),
      dt,
    );
    state.camera.position.set(...cam.position);
    state.camera.lookAt(...cam.lookAt);
    if (selfId) {
      if (firstPerson) anchors.current.delete(selfId);
      else anchors.current.set(selfId, [feet[0], feet[1] + LABEL_HEIGHT, feet[2]]);
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
      avatar.update(dt, {
        position: pose.position,
        yaw: pose.yaw,
        loco: pose.loco,
        speed: pose.speed,
        lookPitch: pose.head ? pitchFromQuat(pose.head) : 0,
      });
      anchors.current.set(id, [
        pose.position[0],
        pose.position[1] + LABEL_HEIGHT,
        pose.position[2],
      ]);
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
        `dropped packets ${poseHub.dropped}`,
      ]);
      l.frames = 0;
      l.statsAt = now;
    }
  });

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
