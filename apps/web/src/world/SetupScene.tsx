import { OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import {
  SplatEdit,
  SplatEditRgbaBlendMode,
  SplatEditSdf,
  SplatEditSdfType,
} from "@sparkjsdev/spark";
import {
  type ComponentRef,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BufferGeometry,
  CanvasTexture,
  DoubleSide,
  Float32BufferAttribute,
  type Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MOUSE,
  type PerspectiveCamera,
  Plane,
  Raycaster,
  SRGBColorSpace,
  TOUCH,
  Vector2,
  Vector3,
} from "three";
import {
  dropWalkwayTriangles,
  nextSeatId,
  newSetupId,
  passableWalkways,
  rectFromCorners,
  resizeTableFromCorner,
  seatsAlongLine,
  tableCorners,
  type Vec3,
  walkwayBigEnough,
  walkwayColliders,
  yawTowards,
  type Clearance,
} from "@vcr/engine";
import type { RoomSetup, SceneAssets, Seat, Table, Walkway } from "@vcr/protocol";
import type { RoomCollision } from "./collision";
import { RoomMesh } from "./RoomMesh";
import { type RoomLoadState, RoomSplats } from "./RoomSplats";

/**
 * The room setup editor's 3D view: the room, its walkways, seats and tables drawn over it, the
 * collision boxes as they'll be once walkways open them up, and the pointer gestures that place
 * and edit things. Picking hits the collision boxes, which work for splat and mesh rooms alike;
 * mesh rooms are also hit-tested against the visible mesh when a tap places something.
 */

export type Tool = "select" | "walkway" | "seat" | "couch" | "table";
export type Selection =
  { kind: "walkway"; id: string } | { kind: "seat"; id: number } | { kind: "table"; id: string };
type XZ = [number, number];
type Edit = (setup: RoomSetup) => RoomSetup;

/** The manifest's limits (`RoomSetup` in @vcr/protocol). */
export const SETUP_LIMITS = { walkways: 64, seats: 200, tables: 16 };
export const DEFAULT_TABLE_SIZE: [number, number] = [0.9, 0.6];

const COLORS = {
  walkway: "#3ecf8e",
  seat: "#f5a524",
  table: "#6ea8fe",
  selected: "#ffffff",
  collision: "#9fb2d0",
};
/** Pointer slop before a press counts as a drag, and how close a handle must be, in CSS pixels. */
const TAP_SLOP = 8;
const HANDLE_REACH = 26;
/** Where a seat's facing arrow ends (its turn handle), meters in front of the seat. */
const SEAT_ARROW = 0.45;
/** How far beyond a table's front edge its turn handle sits, meters. */
const TABLE_KNOB = 0.3;
/** Overlays draw over the room, after it. */
const OVERLAY = 10;

const round = (v: number) => Math.round(v * 1000) / 1000;
const roundVec = (v: Vector3): Vec3 => [round(v.x), round(v.y), round(v.z)];

// --- edits shared with the editor's panel ------------------------------------------------

/** Changing a suggested seat or table makes it the owner's. */
export const editSeat =
  (id: number, patch: Partial<Seat>): Edit =>
  (s) => ({
    ...s,
    seats: s.seats.map((x) => (x.id === id ? { ...x, ...patch, source: "user" } : x)),
  });
export const editTable =
  (id: string, patch: Partial<Table>): Edit =>
  (s) => ({
    ...s,
    tables: s.tables.map((x) => (x.id === id ? { ...x, ...patch, source: "user" } : x)),
  });
export const editWalkway =
  (id: string, patch: Partial<Walkway>): Edit =>
  (s) => ({ ...s, walkways: s.walkways.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
export const removeItem =
  (sel: Selection): Edit =>
  (s) => ({
    walkways: sel.kind === "walkway" ? s.walkways.filter((x) => x.id !== sel.id) : s.walkways,
    seats: sel.kind === "seat" ? s.seats.filter((x) => x.id !== sel.id) : s.seats,
    tables: sel.kind === "table" ? s.tables.filter((x) => x.id !== sel.id) : s.tables,
  });

export interface SetupSceneProps {
  scene: SceneAssets;
  collision: RoomCollision | null;
  setup: RoomSetup;
  selected: Selection | null;
  tool: Tool;
  topView: boolean;
  showCollision: boolean;
  /** What kind new seats are. */
  seatKind: Seat["kind"];
  /** The element the canvas sits in; gestures are read from it before the camera controls. */
  surface: RefObject<HTMLDivElement | null>;
  onSelect(selection: Selection | null): void;
  onEdit(edit: Edit): void;
  onRoomState(state: RoomLoadState): void;
  /** Something the owner should know (e.g. a limit was reached). */
  onNotice(text: string): void;
}

type Controls = ComponentRef<typeof OrbitControls>;

/** The editor shows the whole scan, so tables can be lined up with its real tabletops. */
const NO_CLEARANCES: Clearance[] = [];
type Draft =
  { kind: "walkway"; min: XZ; max: XZ } | { kind: "couch"; a: Vec3; b: Vec3; facing: XZ };

export function SetupScene(props: SetupSceneProps) {
  const { scene, collision, setup, selected } = props;
  const { manifest } = scene;
  const visual = useRef<Group>(null);
  const controls = useRef<Controls>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  // The collision mesh, merged, for picking (never drawn).
  const pickMesh = useMemo(() => {
    if (!collision) return null;
    const total = collision.meshes.reduce((n, m) => n + m.vertices.length, 0);
    const positions = new Float32Array(total);
    const indices: number[] = [];
    let offset = 0;
    for (const m of collision.meshes) {
      positions.set(m.vertices, offset);
      for (const i of m.indices) indices.push(i + offset / 3);
      offset += m.vertices.length;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, new MeshBasicMaterial({ side: DoubleSide }));
    mesh.updateMatrixWorld();
    return mesh;
  }, [collision]);
  useEffect(() => () => pickMesh?.geometry.dispose(), [pickMesh]);

  return (
    <>
      <color attach="background" args={["#0f1424"]} />
      <hemisphereLight args={["#fff8ee", "#6b5a4a", 1.3]} />
      <ambientLight color={manifest.lighting.ambientColor} intensity={0.4} />
      <group ref={visual}>
        {manifest.mesh ? (
          <RoomMesh scene={scene} clearances={NO_CLEARANCES} onState={props.onRoomState} />
        ) : (
          <>
            <RoomSplats scene={scene} clearances={NO_CLEARANCES} onState={props.onRoomState} />
            <CeilingCut height={manifest.bounds.max[1] - 0.3} />
          </>
        )}
      </group>
      {props.showCollision && collision && (
        <CollisionLines collision={collision} walkways={setup.walkways} />
      )}
      {setup.walkways.map((w) => (
        <WalkwayRect
          key={w.id}
          walkway={w}
          selected={selected?.kind === "walkway" && selected.id === w.id}
        />
      ))}
      {setup.tables.map((t) => (
        <TableMarker
          key={t.id}
          table={t}
          selected={selected?.kind === "table" && selected.id === t.id}
        />
      ))}
      {setup.seats.map((s) => (
        <SeatMarker
          key={s.id}
          seat={s}
          selected={selected?.kind === "seat" && selected.id === s.id}
        />
      ))}
      {draft?.kind === "walkway" && <WalkwayRect walkway={{ id: "", ...draft }} draft />}
      {draft?.kind === "couch" && <CouchDraft {...draft} />}
      <Cameras
        bounds={manifest.bounds}
        topView={props.topView}
        tool={props.tool}
        controls={controls}
      />
      <Gestures
        {...props}
        visual={visual}
        pickMesh={pickMesh}
        controls={controls}
        setDraft={setDraft}
      />
    </>
  );
}

// --- camera ------------------------------------------------------------------------------

/**
 * Orbiting (drag to turn, pinch or scroll to zoom, right-drag or two fingers to pan) or a view
 * straight down. While drawing walkways or couches one finger draws, so the camera moves with
 * two fingers or the right mouse button.
 */
function Cameras(props: {
  bounds: { min: Vec3; max: Vec3 };
  topView: boolean;
  tool: Tool;
  controls: RefObject<Controls | null>;
}) {
  const { bounds, topView, tool, controls } = props;
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const get = useThree((s) => s.get);

  useEffect(() => {
    const c = controls.current;
    if (!c) return;
    const { width: w, height: h } = get().size;
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    const width = bounds.max[0] - bounds.min[0];
    const depth = bounds.max[2] - bounds.min[2];
    const half = Math.tan(((camera.fov / 2) * Math.PI) / 180);
    // Far enough to see the whole floor.
    const reach = Math.max(depth / 2 / half, width / 2 / (half * (w / Math.max(1, h)))) * 1.1;
    if (topView) {
      c.target.set(cx, 0, cz);
      camera.position.set(cx, reach + 0.5, cz + 0.001);
    } else {
      c.target.set(cx, 0.3, cz);
      const dir = new Vector3(0.35, 1, 0.8).normalize();
      camera.position.set(cx, 0.3, cz).addScaledVector(dir, reach);
    }
    c.update();
  }, [topView, bounds, camera, controls, get]);

  // Without a LEFT button or ONE finger, the controls leave those to the drawing tools.
  const drawing = tool === "walkway" || tool === "couch";
  const look = topView ? MOUSE.PAN : MOUSE.ROTATE;
  const mouseButtons = drawing
    ? { MIDDLE: MOUSE.DOLLY, RIGHT: look }
    : { LEFT: look, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
  const touches = drawing
    ? { TWO: TOUCH.DOLLY_PAN }
    : { ONE: topView ? TOUCH.PAN : TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN };

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      zoomToCursor
      mouseButtons={mouseButtons}
      touches={touches}
      enableRotate={!topView}
      minPolarAngle={0}
      maxPolarAngle={topView ? 0 : Math.PI / 2 - 0.05}
      minDistance={0.5}
      maxDistance={60}
    />
  );
}

/** Splat rooms: hides the ceiling so the room can be seen from above. */
function CeilingCut({ height }: { height: number }) {
  const edit = useMemo(() => {
    const e = new SplatEdit({ rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY });
    // A plane SDF is negative below its local XY plane; turned so local +Z points down, the
    // inside is everything above `height`, and opacity 0 hides it.
    const sdf = new SplatEditSdf({ type: SplatEditSdfType.PLANE, opacity: 0 });
    sdf.position.set(0, height, 0);
    sdf.rotation.x = Math.PI / 2;
    e.add(sdf);
    return e;
  }, [height]);
  return <primitive object={edit} />;
}

// --- gestures ----------------------------------------------------------------------------

type Gesture =
  | { kind: "tap"; x: number; y: number }
  | { kind: "draw-walkway"; start: XZ; rect: Pick<Walkway, "min" | "max"> }
  | { kind: "couch"; start: Vec3; end: Vec3 }
  | { kind: "walkway-corner"; id: string; fixed: XZ }
  | { kind: "walkway-move"; id: string; grab: XZ; min: XZ; max: XZ }
  | { kind: "seat-yaw"; id: number }
  | { kind: "seat-move"; id: number }
  | { kind: "table-corner"; id: string; corner: number }
  | { kind: "table-rotate"; id: string }
  | { kind: "table-move"; id: string; grab: XZ; center: Vec3 };

const corners = (w: Pick<Walkway, "min" | "max">): XZ[] => [
  [w.min[0], w.min[1]],
  [w.max[0], w.min[1]],
  [w.max[0], w.max[1]],
  [w.min[0], w.max[1]],
];

const inTable = (t: Table, x: number, z: number) => {
  const dx = x - t.center[0];
  const dz = z - t.center[2];
  const c = Math.cos(t.yaw);
  const s = Math.sin(t.yaw);
  return Math.abs(dx * c - dz * s) <= t.size[0] / 2 && Math.abs(dx * s + dz * c) <= t.size[1] / 2;
};
const inRect = (w: Pick<Walkway, "min" | "max">, x: number, z: number) =>
  x >= w.min[0] && x <= w.max[0] && z >= w.min[1] && z <= w.max[1];
const seatArrowTip = (s: Seat): Vec3 => [
  s.position[0] + Math.sin(s.yaw) * SEAT_ARROW,
  s.position[1],
  s.position[2] + Math.cos(s.yaw) * SEAT_ARROW,
];
const tableKnob = (t: Table): Vec3 => {
  const r = t.size[1] / 2 + TABLE_KNOB;
  return [t.center[0] + Math.sin(t.yaw) * r, t.center[1], t.center[2] + Math.cos(t.yaw) * r];
};

/** Reads presses, drags and taps on the canvas before the camera controls see them. */
function Gestures(
  props: SetupSceneProps & {
    visual: RefObject<Group | null>;
    pickMesh: Mesh | null;
    controls: RefObject<Controls | null>;
    setDraft(draft: Draft | null): void;
  },
) {
  const get = useThree((s) => s.get);
  // The handlers below are set up once and read the latest props from here.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const el = props.surface.current;
    if (!el) return;
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    const projected = new Vector3();
    const hit = new Vector3();
    const pointers = new Set<number>();
    let gesture: Gesture | null = null;
    let lastEvent: PointerEvent | null = null;

    const aim = (e: PointerEvent) => {
      const rect = get().gl.domElement.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, get().camera);
    };
    /** Where the pointer meets the horizontal plane at height `y`. */
    const onPlane = (e: PointerEvent, y = 0): XZ | null => {
      aim(e);
      const p = raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), -y), hit);
      return p ? [p.x, p.z] : null;
    };
    /**
     * The surface under the pointer: the visible mesh when `precise` (mesh rooms, on taps), else
     * the collision boxes, else the floor.
     */
    const pick = (e: PointerEvent, precise: boolean): Vec3 | null => {
      aim(e);
      const { visual, pickMesh, scene } = latest.current;
      if (precise && scene.manifest.mesh && visual.current) {
        const [first] = raycaster.intersectObject(visual.current, true);
        if (first) return roundVec(first.point);
      }
      if (pickMesh) {
        const [first] = raycaster.intersectObject(pickMesh, false);
        if (first) return roundVec(first.point);
      }
      const floor = raycaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), hit);
      return floor ? roundVec(floor) : null;
    };
    /** Screen distance (CSS pixels) from the pointer to a world point. */
    const screenDistance = (e: PointerEvent, p: Vec3) => {
      const rect = get().gl.domElement.getBoundingClientRect();
      projected.set(...p).project(get().camera);
      if (projected.z > 1) return Infinity;
      const x = rect.left + ((projected.x + 1) / 2) * rect.width;
      const y = rect.top + ((1 - projected.y) / 2) * rect.height;
      return Math.hypot(x - e.clientX, y - e.clientY);
    };
    const near = (e: PointerEvent, p: Vec3) => screenDistance(e, p) <= HANDLE_REACH;
    /**
     * Where new seats face: the owner, who usually looks at a couch from the room, or the
     * middle of the room when looking straight down on it.
     */
    const viewpoint = (p: Vec3): XZ => {
      const { x, z } = get().camera.position;
      if (Math.hypot(x - p[0], z - p[2]) > 1.5) return [x, z];
      const { min, max } = latest.current.scene.manifest.bounds;
      return [(min[0] + max[0]) / 2, (min[2] + max[2]) / 2];
    };

    /** The seat, table or walkway under the pointer (seats first: they're smallest). */
    const itemAt = (e: PointerEvent): Selection | null => {
      const { setup } = latest.current;
      let best: { id: number; d: number } | null = null;
      for (const s of setup.seats) {
        const d = screenDistance(e, s.position);
        if (d <= HANDLE_REACH && (!best || d < best.d)) best = { id: s.id, d };
      }
      if (best) return { kind: "seat", id: best.id };
      for (const t of setup.tables) {
        const p = onPlane(e, t.center[1]);
        if (p && inTable(t, ...p)) return { kind: "table", id: t.id };
      }
      const floor = onPlane(e);
      const w = floor && setup.walkways.find((x) => inRect(x, ...floor));
      return w ? { kind: "walkway", id: w.id } : null;
    };

    /** A press on a handle, or on the selected thing, or one a drawing tool starts with. */
    const startDrag = (e: PointerEvent): Gesture | null => {
      const { setup, selected, tool } = latest.current;
      const walkway =
        selected?.kind === "walkway" ? setup.walkways.find((w) => w.id === selected.id) : null;
      const seat = selected?.kind === "seat" ? setup.seats.find((s) => s.id === selected.id) : null;
      const table =
        selected?.kind === "table" ? setup.tables.find((t) => t.id === selected.id) : null;

      if (walkway) {
        const cs = corners(walkway);
        const i = cs.findIndex(([x, z]) => near(e, [x, 0, z]));
        if (i >= 0) return { kind: "walkway-corner", id: walkway.id, fixed: cs[(i + 2) % 4]! };
      }
      if (seat && near(e, seatArrowTip(seat))) return { kind: "seat-yaw", id: seat.id };
      if (table) {
        if (near(e, tableKnob(table))) return { kind: "table-rotate", id: table.id };
        const cs = tableCorners(table);
        const i = cs.findIndex(([x, z]) => near(e, [x, table.center[1], z]));
        if (i >= 0) return { kind: "table-corner", id: table.id, corner: i };
      }
      if (tool === "walkway") {
        const p = onPlane(e);
        if (p) return { kind: "draw-walkway", start: p, rect: { min: p, max: p } };
      }
      if (tool === "couch") {
        const p = pick(e, true);
        if (p) return { kind: "couch", start: p, end: p };
      }
      if (seat && near(e, seat.position)) return { kind: "seat-move", id: seat.id };
      if (table) {
        const p = onPlane(e, table.center[1]);
        if (p && inTable(table, ...p)) {
          return { kind: "table-move", id: table.id, grab: p, center: table.center };
        }
      }
      if (walkway) {
        const p = onPlane(e);
        if (p && inRect(walkway, ...p)) {
          return {
            kind: "walkway-move",
            id: walkway.id,
            grab: p,
            min: walkway.min,
            max: walkway.max,
          };
        }
      }
      return null;
    };

    const drag = (e: PointerEvent, g: Gesture) => {
      const { onEdit, scene, setDraft } = latest.current;
      const { bounds } = scene.manifest;
      switch (g.kind) {
        case "draw-walkway": {
          const p = onPlane(e);
          if (!p) return;
          g.rect = rectFromCorners(g.start, p, bounds);
          setDraft({ kind: "walkway", ...g.rect });
          return;
        }
        case "couch": {
          const p = pick(e, false);
          if (!p) return;
          g.end = p;
          setDraft({ kind: "couch", a: g.start, b: p, facing: viewpoint(g.start) });
          return;
        }
        case "walkway-corner": {
          const p = onPlane(e);
          if (!p) return;
          const rect = rectFromCorners(g.fixed, p, bounds);
          if (walkwayBigEnough(rect)) onEdit(editWalkway(g.id, roundRect(rect)));
          return;
        }
        case "walkway-move": {
          const p = onPlane(e);
          if (!p) return;
          // Moved as a whole, but never out of the room.
          const dx = clampShift(p[0] - g.grab[0], g.min[0], g.max[0], bounds.min[0], bounds.max[0]);
          const dz = clampShift(p[1] - g.grab[1], g.min[1], g.max[1], bounds.min[2], bounds.max[2]);
          onEdit(
            editWalkway(
              g.id,
              roundRect({
                min: [g.min[0] + dx, g.min[1] + dz],
                max: [g.max[0] + dx, g.max[1] + dz],
              }),
            ),
          );
          return;
        }
        case "seat-yaw": {
          const seat = latest.current.setup.seats.find((s) => s.id === g.id);
          const p = seat && onPlane(e, seat.position[1]);
          if (!seat || !p) return;
          const yaw = yawTowards([seat.position[0], seat.position[2]], p);
          onEdit(editSeat(g.id, { yaw: Math.round(yaw * 1000) / 1000 }));
          return;
        }
        case "seat-move": {
          const p = pick(e, false);
          if (p) onEdit(editSeat(g.id, { position: p, height: Math.max(0.02, p[1]) }));
          return;
        }
        case "table-corner": {
          const table = latest.current.setup.tables.find((t) => t.id === g.id);
          const p = table && onPlane(e, table.center[1]);
          if (!table || !p) return;
          const { center, size } = resizeTableFromCorner(table, g.corner, p);
          onEdit(
            editTable(g.id, {
              center: [round(center[0]), center[1], round(center[2])],
              size: [round(size[0]), round(size[1])],
            }),
          );
          return;
        }
        case "table-rotate": {
          const table = latest.current.setup.tables.find((t) => t.id === g.id);
          const p = table && onPlane(e, table.center[1]);
          if (!table || !p) return;
          const yaw = yawTowards([table.center[0], table.center[2]], p);
          onEdit(editTable(g.id, { yaw: Math.round(yaw * 1000) / 1000 }));
          return;
        }
        case "table-move": {
          const p = onPlane(e, g.center[1]);
          if (!p) return;
          onEdit(
            editTable(g.id, {
              center: [
                round(g.center[0] + p[0] - g.grab[0]),
                g.center[1],
                round(g.center[2] + p[1] - g.grab[1]),
              ],
            }),
          );
          return;
        }
        case "tap":
          return;
      }
    };

    const finish = (e: PointerEvent, g: Gesture) => {
      const { onEdit, onSelect, onNotice, setDraft, setup, scene } = latest.current;
      setDraft(null);
      if (g.kind === "draw-walkway") {
        if (!walkwayBigEnough(g.rect)) return;
        if (setup.walkways.length >= SETUP_LIMITS.walkways) {
          return onNotice(`A room can have up to ${SETUP_LIMITS.walkways} walkways.`);
        }
        const id = newSetupId(setup.walkways.map((w) => w.id));
        onEdit((s) => ({ ...s, walkways: [...s.walkways, { id, ...roundRect(g.rect) }] }));
        onSelect({ kind: "walkway", id });
      } else if (g.kind === "couch") {
        const placed = seatsAlongLine(g.start, g.end, viewpoint(g.start));
        const room = SETUP_LIMITS.seats - setup.seats.length;
        if (room <= 0) return onNotice(`A room can have up to ${SETUP_LIMITS.seats} seats.`);
        const seats: Seat[] = [];
        let all = setup.seats;
        for (const { position, yaw } of placed.slice(0, room)) {
          const seat: Seat = {
            id: nextSeatId(all),
            position: [round(position[0]), round(position[1]), round(position[2])],
            yaw: Math.round(yaw * 1000) / 1000,
            height: Math.max(0.02, round(position[1])),
            kind: "sofa",
            source: "user",
          };
          seats.push(seat);
          all = [...all, seat];
        }
        onEdit((s) => ({ ...s, seats: [...s.seats, ...seats] }));
        if (seats.length) onSelect({ kind: "seat", id: seats[0]!.id });
      } else if (g.kind === "seat-move" && scene.manifest.mesh) {
        // Settle on the visible mesh where the drag ended.
        const p = pick(e, true);
        if (p) onEdit(editSeat(g.id, { position: p, height: Math.max(0.02, p[1]) }));
      }
    };

    const tap = (e: PointerEvent) => {
      const { tool, setup, onEdit, onSelect, onNotice, seatKind } = latest.current;
      const item = itemAt(e);
      if (tool === "seat" && item?.kind !== "seat") {
        if (setup.seats.length >= SETUP_LIMITS.seats) {
          return onNotice(`A room can have up to ${SETUP_LIMITS.seats} seats.`);
        }
        const p = pick(e, true);
        if (!p) return;
        const seat: Seat = {
          id: nextSeatId(setup.seats),
          position: p,
          yaw: Math.round(yawTowards([p[0], p[2]], viewpoint(p)) * 1000) / 1000,
          height: Math.max(0.02, p[1]),
          kind: seatKind,
          source: "user",
        };
        onEdit((s) => ({ ...s, seats: [...s.seats, seat] }));
        return onSelect({ kind: "seat", id: seat.id });
      }
      if (tool === "table" && item?.kind !== "table") {
        if (setup.tables.length >= SETUP_LIMITS.tables) {
          return onNotice(`A room can have up to ${SETUP_LIMITS.tables} tables.`);
        }
        const p = pick(e, true);
        if (!p) return;
        const table: Table = {
          id: newSetupId(setup.tables.map((t) => t.id)),
          name: `Table ${setup.tables.length + 1}`,
          center: p,
          yaw: 0,
          size: DEFAULT_TABLE_SIZE,
          source: "user",
          games: ["jigsaw"],
        };
        onEdit((s) => ({ ...s, tables: [...s.tables, table] }));
        return onSelect({ kind: "table", id: table.id });
      }
      onSelect(item);
    };

    const end = (enable = true) => {
      gesture = null;
      latest.current.setDraft(null);
      if (enable && latest.current.controls.current) latest.current.controls.current.enabled = true;
    };

    const onDown = (e: PointerEvent) => {
      // Only presses on the room itself (not the toolbar over it).
      if (e.target !== get().gl.domElement) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointers.add(e.pointerId);
      if (pointers.size > 1) {
        // A second finger: the camera's turn (pinch and pan), not a drag.
        if (gesture && gesture.kind !== "tap") end();
        gesture = null;
        return;
      }
      lastEvent = e;
      const g = startDrag(e);
      if (g) {
        // Before the camera controls see this press, so they leave it alone. Drawing tools take
        // one finger from the controls already, and leave them two for pinching.
        const { tool, controls } = latest.current;
        if (tool !== "walkway" && tool !== "couch" && controls.current) {
          controls.current.enabled = false;
        }
        gesture = g;
      } else {
        gesture = { kind: "tap", x: e.clientX, y: e.clientY };
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!gesture || !pointers.has(e.pointerId)) return;
      lastEvent = e;
      if (gesture.kind === "tap") {
        if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > TAP_SLOP) gesture = null;
        return;
      }
      drag(e, gesture);
    };
    const onUp = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      const g = gesture;
      if (!g) return;
      if (e.type === "pointercancel") return end();
      end();
      if (g.kind === "tap") tap(e);
      else finish(lastEvent ?? e, g);
    };

    el.addEventListener("pointerdown", onDown, { capture: true });
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      el.removeEventListener("pointerdown", onDown, { capture: true });
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [get, props.surface]);

  return null;
}

const roundRect = (r: Pick<Walkway, "min" | "max">): Pick<Walkway, "min" | "max"> => ({
  min: [round(r.min[0]), round(r.min[1])],
  max: [round(r.max[0]), round(r.max[1])],
});

/** A shift `d` limited so [lo, hi] stays within [min, max]. */
const clampShift = (d: number, lo: number, hi: number, min: number, max: number) =>
  Math.min(Math.max(d, min - lo), max - hi);

// --- what's drawn over the room ----------------------------------------------------------

/** The collision as walkways leave it (what people walking the room meet), as faint lines. */
function CollisionLines({
  collision,
  walkways,
}: {
  collision: RoomCollision;
  walkways: readonly Walkway[];
}) {
  const lines = useMemo(() => {
    const positions: number[] = [];
    if (collision.boxes) {
      for (const { min, max } of walkwayColliders(collision.boxes, walkways)) {
        const c = (i: number): Vec3 => [
          i & 4 ? max[0] : min[0],
          i & 2 ? max[1] : min[1],
          i & 1 ? max[2] : min[2],
        ];
        // The 12 edges: corner pairs differing in one bit.
        for (let i = 0; i < 8; i++) {
          for (const bit of [1, 2, 4]) if (!(i & bit)) positions.push(...c(i), ...c(i | bit));
        }
      }
    } else {
      for (const m of collision.meshes) {
        const indices = dropWalkwayTriangles(m.vertices, m.indices, passableWalkways(walkways));
        for (let t = 0; t + 2 < indices.length; t += 3) {
          for (const [a, b] of [
            [t, t + 1],
            [t + 1, t + 2],
            [t + 2, t],
          ]) {
            const ia = indices[a!]! * 3;
            const ib = indices[b!]! * 3;
            positions.push(...m.vertices.subarray(ia, ia + 3), ...m.vertices.subarray(ib, ib + 3));
          }
        }
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    return new LineSegments(
      geometry,
      new LineBasicMaterial({ color: COLORS.collision, transparent: true, opacity: 0.22 }),
    );
  }, [collision, walkways]);
  useEffect(() => () => lines.geometry.dispose(), [lines]);
  return <primitive object={lines} />;
}

/** Outline width, meters (GL lines are a single pixel wide, too thin to see on a busy scan). */
const OUTLINE_WIDTH = 0.025;
const DASH = 0.08;
const GAP = 0.06;

/**
 * A flat ribbon through world X/Z points at height `y`, closed unless `open`, solid or dashed.
 */
function Outline(props: {
  points: XZ[];
  y: number;
  color: string;
  dashed?: boolean;
  open?: boolean;
}) {
  const { points, y, color, dashed, open } = props;
  const geometry = useMemo(() => {
    const positions: number[] = [];
    const quad = (a: XZ, b: XZ) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) return;
      const nx = (-(b[1] - a[1]) / len) * (OUTLINE_WIDTH / 2);
      const nz = ((b[0] - a[0]) / len) * (OUTLINE_WIDTH / 2);
      const [p, q, r, t] = [
        [a[0] + nx, y, a[1] + nz],
        [a[0] - nx, y, a[1] - nz],
        [b[0] - nx, y, b[1] - nz],
        [b[0] + nx, y, b[1] + nz],
      ];
      positions.push(...p!, ...q!, ...r!, ...p!, ...r!, ...t!);
    };
    const count = open ? points.length - 1 : points.length;
    for (let i = 0; i < count; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      if (!dashed) {
        quad(a, b);
        continue;
      }
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let d = 0; d < len; d += DASH + GAP) {
        const t0 = d / len;
        const t1 = Math.min(1, (d + DASH) / len);
        quad(
          [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0],
          [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1],
        );
      }
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(positions, 3));
    return g;
  }, [points, y, dashed, open]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} renderOrder={OVERLAY + 1}>
      <meshBasicMaterial
        color={color}
        transparent
        depthTest={false}
        depthWrite={false}
        side={DoubleSide}
        toneMapped={false}
      />
    </mesh>
  );
}

function WalkwayRect(props: { walkway: Walkway; selected?: boolean; draft?: boolean }) {
  const { walkway: w, selected, draft } = props;
  const points = useMemo(() => corners(w), [w]);
  const width = w.max[0] - w.min[0];
  const depth = w.max[1] - w.min[1];
  return (
    <>
      <mesh
        position={[(w.min[0] + w.max[0]) / 2, 0.015, (w.min[1] + w.max[1]) / 2]}
        rotation-x={-Math.PI / 2}
        scale={[Math.max(width, 0.001), Math.max(depth, 0.001), 1]}
        renderOrder={OVERLAY}
      >
        <planeGeometry />
        <meshBasicMaterial
          color={COLORS.walkway}
          transparent
          opacity={selected ? 0.45 : 0.3}
          toneMapped={false}
          depthTest={false}
          depthWrite={false}
          side={DoubleSide}
        />
      </mesh>
      <Outline
        points={points}
        y={0.02}
        color={selected ? COLORS.selected : COLORS.walkway}
        dashed={draft}
      />
      {selected && points.map(([x, z], i) => <Handle key={i} position={[x, 0.02, z]} />)}
    </>
  );
}

function SeatMarker({ seat, selected }: { seat: Seat; selected: boolean }) {
  const suggested = seat.source === "auto";
  const color = selected ? COLORS.selected : COLORS.seat;
  const opacity = suggested && !selected ? 0.4 : 0.85;
  const ring = useMemo(
    () =>
      Array.from({ length: 24 }, (_, i): XZ => {
        const a = (i / 24) * Math.PI * 2;
        return [Math.sin(a) * 0.2, Math.cos(a) * 0.2];
      }),
    [],
  );
  return (
    <group position={seat.position} rotation-y={seat.yaw}>
      <mesh position-y={0.03} renderOrder={OVERLAY}>
        <cylinderGeometry args={[0.17, 0.17, 0.05, 24]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>
      {suggested && <Outline points={ring} y={0.06} color={COLORS.seat} dashed />}
      {/* Which way the sitter faces. */}
      <mesh position={[0, 0.05, 0.2]} renderOrder={OVERLAY}>
        <boxGeometry args={[0.035, 0.02, 0.2]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, 0.05, SEAT_ARROW - 0.07]} rotation-x={Math.PI / 2} renderOrder={OVERLAY}>
        <coneGeometry args={[0.07, 0.14, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={opacity}
          depthTest={false}
          toneMapped={false}
        />
      </mesh>
      {/* Behind the seat, clear of its arrow and cushion. */}
      <Label text={String(seat.id)} position={[0, 0.1, -0.3]} dim={suggested && !selected} />
      {selected && <Handle position={[0, 0.05, SEAT_ARROW]} />}
    </group>
  );
}

function TableMarker({ table, selected }: { table: Table; selected: boolean }) {
  const suggested = table.source === "auto";
  const points = useMemo(() => tableCorners(table), [table]);
  const y = table.center[1] + 0.01;
  const knob = tableKnob(table);
  return (
    <>
      <mesh
        position={[table.center[0], y, table.center[2]]}
        rotation={[-Math.PI / 2, 0, table.yaw]}
        scale={[table.size[0], table.size[1], 1]}
        renderOrder={OVERLAY}
      >
        <planeGeometry />
        <meshBasicMaterial
          color={COLORS.table}
          transparent
          opacity={suggested && !selected ? 0.15 : 0.35}
          toneMapped={false}
          depthTest={false}
          depthWrite={false}
          side={DoubleSide}
        />
      </mesh>
      <Outline
        points={points}
        y={y}
        color={selected ? COLORS.selected : COLORS.table}
        dashed={suggested}
      />
      <Label
        text={table.name || "Table"}
        // Beyond the back edge, clear of the tabletop and its handles.
        position={[
          table.center[0] - Math.sin(table.yaw) * (table.size[1] / 2 + 0.2),
          y + 0.05,
          table.center[2] - Math.cos(table.yaw) * (table.size[1] / 2 + 0.2),
        ]}
        dim={suggested && !selected}
      />
      {selected && (
        <>
          {points.map(([x, z], i) => (
            <Handle key={i} position={[x, y, z]} />
          ))}
          <Handle position={[knob[0], y, knob[2]]} turn />
        </>
      )}
    </>
  );
}

function CouchDraft({ a, b, facing }: { a: Vec3; b: Vec3; facing: XZ }) {
  const seats = seatsAlongLine(a, b, facing);
  return (
    <>
      <Outline
        points={[
          [a[0], a[2]],
          [b[0], b[2]],
        ]}
        y={(a[1] + b[1]) / 2 + 0.03}
        color={COLORS.seat}
        dashed
        open
      />
      {seats.map((s, i) => (
        <SeatMarker
          key={i}
          seat={{ ...s, id: i + 1, height: s.position[1], kind: "sofa", source: "auto" }}
          selected={false}
        />
      ))}
    </>
  );
}

// --- sprites -----------------------------------------------------------------------------

const textures = new Map<string, CanvasTexture>();

/** A cached canvas texture: a handle dot, or a label pill. */
function spriteTexture(key: string, draw: (ctx: CanvasRenderingContext2D) => void, w: number) {
  let texture = textures.get(key);
  if (!texture) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = 64;
    draw(canvas.getContext("2d")!);
    texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    textures.set(key, texture);
  }
  return texture;
}

/** A drag handle: a dot that stays the same size on screen. */
function Handle({ position, turn }: { position: Vec3; turn?: boolean }) {
  const map = spriteTexture(
    turn ? "turn" : "handle",
    (ctx) => {
      ctx.fillStyle = "#ffffff";
      ctx.strokeStyle = turn ? COLORS.table : "#2f5bea";
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.arc(32, 32, 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    },
    64,
  );
  return (
    <sprite position={position} scale={[0.035, 0.035, 1]} renderOrder={OVERLAY + 2}>
      <spriteMaterial map={map} sizeAttenuation={false} depthTest={false} transparent />
    </sprite>
  );
}

/** A seat number or table name that stays readable at any distance. */
function Label({ text, position, dim }: { text: string; position: Vec3; dim?: boolean }) {
  const label = text.slice(0, 16);
  const width = Math.max(64, Math.min(256, 24 + label.length * 22));
  const map = spriteTexture(
    `label:${label}`,
    (ctx) => {
      ctx.fillStyle = "rgba(10, 22, 40, 0.85)";
      ctx.beginPath();
      ctx.roundRect(2, 6, width - 4, 52, 26);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "600 34px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, width / 2, 33);
    },
    width,
  );
  const h = 0.03;
  return (
    <sprite position={position} scale={[(h * width) / 64, h, 1]} renderOrder={OVERLAY + 2}>
      <spriteMaterial
        map={map}
        sizeAttenuation={false}
        depthTest={false}
        transparent
        opacity={dim ? 0.6 : 1}
      />
    </sprite>
  );
}
