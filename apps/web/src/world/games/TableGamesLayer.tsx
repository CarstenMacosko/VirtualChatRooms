import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { type PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from "three";
import type { Vec3 } from "@vcr/engine";
import type { TablePointer } from "@vcr/games-sdk";
import type { ParticipantView, Table } from "@vcr/protocol";
import type { TableGamesSync } from "../../lib/tableGames";
import { sideOf, worldToTable } from "./focus";
import {
  holderColor,
  type PlayableTable,
  playableTables,
  reachOf,
  type TableGamesUi,
  useUi,
} from "./ui";

export interface TableGamesLayerProps {
  tables: readonly Table[];
  sync: TableGamesSync;
  ui: TableGamesUi;
  /** Realm session id; "" while reconnecting. */
  selfId: string;
  /** Your avatar; its feet are read every frame. */
  character: { readonly current: { readonly position: Vec3 } };
  participants: ParticipantView[];
  /** Top of the room, so the puzzle view's camera stays below the ceiling. */
  ceiling: number;
  lowPower: boolean;
}

const PROXIMITY_INTERVAL = 0.2;

/**
 * The GameLayer (PLAN.md § 3.5): every table that offers a game shows it, for everyone. Finds the
 * table you're near, and while you play one it owns the camera (through `ui.focus`) and turns
 * pointer and touch drags into table coordinates for the game.
 */
export function TableGamesLayer(props: TableGamesLayerProps) {
  const { sync, ui, character } = props;
  const playable = useMemo(() => playableTables(props.tables), [props.tables]);
  useSyncExternalStore(sync.subscribe, sync.version);
  const playing = useUi(ui, "playing");
  const [pointers] = useState(() => new Map<string, TablePointer>());

  const people = useMemo(
    () => new Map(props.participants.map((p) => [p.id, p.name])),
    [props.participants],
  );
  const holder = useCallback(
    (id: string) => {
      const name = people.get(id);
      return name === undefined ? null : { name, color: holderColor(id) };
    },
    [people],
  );

  // Who's near which table; walking away (or being walked away) ends the puzzle view.
  const tick = useRef(0);
  const size = useThree((s) => s.size);
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  useFrame((_, dt) => {
    ui.focus.setViewport(size.width / Math.max(1, size.height), size.height, camera.fov);
    tick.current += dt;
    if (tick.current < PROXIMITY_INTERVAL) return;
    tick.current = 0;
    const [x, , z] = character.current.position;
    let near: string | null = null;
    let nearest = Infinity;
    for (const t of playable) {
      const d = Math.hypot(x - t.frame.center[0], z - t.frame.center[2]);
      if (d <= reachOf(t.frame) && d < nearest) {
        near = t.id;
        nearest = d;
      }
    }
    const state = ui.store.getState();
    if (state.near !== near) ui.store.setState({ near });
    if (state.playing) {
      const t = playable.find((p) => p.id === state.playing);
      const far =
        !t || Math.hypot(x - t.frame.center[0], z - t.frame.center[2]) > reachOf(t.frame) + 1;
      if (far) ui.store.setState({ playing: null });
    }
  });

  // Entering and leaving the puzzle view.
  const playingTable = playable.find((t) => t.id === playing);
  const synced = playing ? sync.table(playing) : undefined;
  const setup = synced?.game === playingTable?.game ? synced?.setup : undefined;
  const ceiling = props.ceiling;
  useEffect(() => {
    if (!playingTable) {
      ui.focus.exit();
      return;
    }
    const [w, d] = playingTable.frame.size;
    const area = setup
      ? playingTable.module.client.viewArea(setup)
      : { bounds: [w / 2, d / 2] as [number, number], piece: 0.05 };
    const [x, , z] = character.current.position;
    ui.focus.enter(playingTable.frame, sideOf(playingTable.frame, x, z), area, ceiling);
  }, [playingTable, setup, ui, character, ceiling]);
  useEffect(() => () => ui.focus.exit(), [ui]);

  usePlayPointer(playingTable ?? null, pointers, ui);

  return (
    <>
      {playable.map((t) => (
        <TableGame
          key={t.id}
          table={t}
          sync={sync}
          self={props.selfId}
          playing={playing === t.id}
          lowPower={props.lowPower}
          holder={holder}
          pointers={pointers}
        />
      ))}
    </>
  );
}

function TableGame(props: {
  table: PlayableTable;
  sync: TableGamesSync;
  self: string;
  playing: boolean;
  lowPower: boolean;
  holder: (id: string) => { name: string; color: string } | null;
  pointers: Map<string, TablePointer>;
}) {
  const { table, sync, pointers } = props;
  const synced = sync.table(table.id);
  const live = synced?.game === table.game ? synced : undefined;
  const act = useCallback((action: unknown) => sync.act(table.id, action), [sync, table.id]);
  const drag = useCallback(
    (item: number, x: number, z: number) => sync.drag(table.id, item, x, z),
    [sync, table.id],
  );
  const liveDrag = useCallback(
    (item: number, out: { x: number; z: number }) => {
      const d = sync.table(table.id)?.drags.get(item);
      if (!d) return false;
      out.x = d.x;
      out.z = d.z;
      return true;
    },
    [sync, table.id],
  );
  const setPointer = useCallback(
    (pointer: TablePointer | null) => {
      if (pointer) pointers.set(table.id, pointer);
      else pointers.delete(table.id);
    },
    [pointers, table.id],
  );
  const { Scene } = table;
  return (
    <Scene
      table={table.frame}
      setup={live?.setup ?? null}
      items={live?.items ?? NO_ITEMS}
      revision={live?.revision ?? -1}
      self={props.self}
      playing={props.playing}
      lowPower={props.lowPower}
      act={act}
      drag={drag}
      liveDrag={liveDrag}
      holder={props.holder}
      setPointer={setPointer}
    />
  );
}

const NO_ITEMS: never[] = [];

/** Pointer and touch on the canvas while playing: drags go to the game, or pan the view. */
function usePlayPointer(
  table: PlayableTable | null,
  pointers: Map<string, TablePointer>,
  ui: TableGamesUi,
) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    if (!table) return;
    const el = gl.domElement;
    const raycaster = new Raycaster();
    const ndc = new Vector2();
    const hit = new Vector3();
    // Pieces lie a few millimeters above the play surface.
    const height = table.frame.center[1] + 0.004;
    const plane = new Plane(new Vector3(0, 1, 0), -height);
    const local = { x: 0, z: 0 };
    const project = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      ndc.set(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      if (!raycaster.ray.intersectPlane(plane, hit)) return false;
      worldToTable(table.frame, hit.x, hit.z, local);
      return true;
    };

    let gesture: { id: number; game: boolean; x: number; y: number } | null = null;
    const abort = new AbortController();
    const signal = abort.signal;
    // Our listeners are on the canvas, below the World's own (which would turn drags into
    // looking around), so stopping propagation keeps them to ourselves.
    el.addEventListener(
      "pointerdown",
      (e) => {
        e.stopPropagation();
        if (gesture || e.button > 0) return; // one finger at a time; no right-click drags
        try {
          el.setPointerCapture(e.pointerId);
        } catch {
          // The pointer is already gone (released before this ran); the gesture still works.
        }
        const pointer = pointers.get(table.id);
        const game =
          !!pointer && project(e) && pointer.down(local.x, local.z, e.pointerType === "touch");
        gesture = { id: e.pointerId, game, x: e.clientX, y: e.clientY };
      },
      { signal },
    );
    el.addEventListener(
      "pointermove",
      (e) => {
        if (gesture?.id !== e.pointerId) return;
        e.stopPropagation();
        if (gesture.game) {
          if (project(e)) pointers.get(table.id)?.move(local.x, local.z);
        } else {
          ui.focus.panBy(e.clientX - gesture.x, e.clientY - gesture.y);
        }
        gesture.x = e.clientX;
        gesture.y = e.clientY;
      },
      { signal },
    );
    const end = (e: PointerEvent, cancelled: boolean) => {
      if (gesture?.id !== e.pointerId) return;
      e.stopPropagation();
      const pointer = pointers.get(table.id);
      if (gesture.game && pointer) {
        if (!cancelled && project(e)) pointer.up(local.x, local.z);
        else pointer.cancel();
      }
      gesture = null;
    };
    el.addEventListener("pointerup", (e) => end(e, false), { signal });
    el.addEventListener("pointercancel", (e) => end(e, true), { signal });
    el.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        ui.focus.zoomBy(Math.exp(e.deltaY * 0.0015));
      },
      { signal, passive: false },
    );
    return () => {
      abort.abort();
      if (gesture?.game) pointers.get(table.id)?.cancel();
    };
  }, [table, gl, camera, pointers, ui]);
}
