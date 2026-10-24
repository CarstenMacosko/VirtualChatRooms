import { Canvas } from "@react-three/fiber";
import {
  Armchair,
  Footprints,
  Map as MapIcon,
  MousePointer2,
  RectangleHorizontal,
  RotateCcw,
  RotateCw,
  Sofa,
  Trash,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { turnYaw } from "@vcr/engine";
import type { RoomSetup, SceneAssets, Seat, Table, Walkway } from "@vcr/protocol";
import { api, ApiRequestError } from "../lib/api";
import { loadRoomCollision, type RoomCollision } from "./collision";
import type { RoomLoadState } from "./RoomSplats";
import {
  editSeat,
  editTable,
  editWalkway,
  removeItem,
  type Selection,
  SetupScene,
  type Tool,
} from "./SetupScene";

/**
 * The room's owner sets up a scanned room here: walkways through scan clutter, seats on couches
 * and chairs, and tables for games. Saved to the manifest; gatherings pick it up when people
 * (re)join.
 */

const TOOLS: Array<{ id: Tool; label: string; icon: ReactNode; hint: string }> = [
  {
    id: "select",
    label: "Select",
    icon: <MousePointer2 size={18} />,
    hint: "Tap a seat, table or walkway to change it. Drag to look around.",
  },
  {
    id: "walkway",
    label: "Walkway",
    icon: <Footprints size={18} />,
    hint: "Drag on the floor to open a path people can walk through, e.g. past scan clutter in a doorway. Two fingers or right-drag move the view.",
  },
  {
    id: "seat",
    label: "Seat",
    icon: <Armchair size={18} />,
    hint: "Tap a chair seat or couch cushion to add a seat there.",
  },
  {
    id: "couch",
    label: "Couch",
    icon: <Sofa size={18} />,
    hint: "Drag along a couch, end to end, to add a seat every 60 cm. Two fingers or right-drag move the view.",
  },
  {
    id: "table",
    label: "Table",
    icon: <RectangleHorizontal size={18} />,
    hint: "Tap a tabletop to add a table people can play games at.",
  },
];

const SEAT_KINDS: Array<{ id: Seat["kind"]; label: string }> = [
  { id: "sofa", label: "Couch" },
  { id: "chair", label: "Chair" },
  { id: "bench", label: "Bench" },
  { id: "floor", label: "Floor" },
];

const errorText = (err: unknown) =>
  err instanceof ApiRequestError ? err.message : "Something went wrong. Try again.";

const degrees = (yaw: number) => `${Math.round((((yaw * 180) / Math.PI) % 360) + 360) % 360}°`;
const setupOf = (scene: SceneAssets): RoomSetup => ({
  walkways: scene.manifest.walkways,
  seats: scene.manifest.seats,
  tables: scene.manifest.tables,
});

export default function RoomSetupEditor(props: {
  room: { id: string; name: string };
  onClose(): void;
}) {
  const { room, onClose } = props;
  const [scene, setScene] = useState<SceneAssets | null>(null);
  const [collision, setCollision] = useState<RoomCollision | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [roomState, setRoomState] = useState<RoomLoadState>({ state: "loading", progress: null });
  const [saved, setSaved] = useState<RoomSetup | null>(null);
  const [setup, setSetup] = useState<RoomSetup | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [topView, setTopView] = useState(false);
  const [showCollision, setShowCollision] = useState(true);
  const [seatKind, setSeatKind] = useState<Seat["kind"]>("sofa");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api.roomScene(room.id).then(
      (s) => {
        if (!alive) return;
        setScene(s);
        setSaved(setupOf(s));
        setSetup(setupOf(s));
        loadRoomCollision(s).then(
          (c) => alive && setCollision(c),
          () =>
            alive && setNotice("Couldn't load the room's collision boxes; taps land on the floor."),
        );
      },
      (err: unknown) => alive && setLoadError(errorText(err)),
    );
    return () => {
      alive = false;
    };
  }, [room.id]);

  const dirty = useMemo(
    () => Boolean(setup && saved && JSON.stringify(setup) !== JSON.stringify(saved)),
    [setup, saved],
  );
  // Leaving the page with unsaved changes loses them; ask first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const close = useCallback(() => {
    if (dirty && !window.confirm("Leave without saving your changes?")) return;
    onClose();
  }, [dirty, onClose]);

  const edit = useCallback((change: (s: RoomSetup) => RoomSetup) => {
    setSetup((s) => (s ? change(s) : s));
    setError(null);
    setNotice(null);
  }, []);

  const remove = useCallback(
    (sel: Selection) => {
      edit(removeItem(sel));
      setSelected(null);
    },
    [edit],
  );

  // Escape lets go of the selection; Delete removes it (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest("input, select, textarea");
      if (e.key === "Escape") setSelected(null);
      else if ((e.key === "Delete" || e.key === "Backspace") && selected && !typing) {
        e.preventDefault();
        remove(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, remove]);

  const save = async () => {
    if (!setup) return;
    setSaving(true);
    setError(null);
    try {
      const result = await api.saveRoomSetup(room.id, setup);
      setSaved(result);
      setSetup(result);
      setNotice("Saved. People see the changes when they join or rejoin a gathering here.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const seat =
    selected?.kind === "seat" ? setup?.seats.find((s) => s.id === selected.id) : undefined;
  const table =
    selected?.kind === "table" ? setup?.tables.find((t) => t.id === selected.id) : undefined;
  const walkway =
    selected?.kind === "walkway" ? setup?.walkways.find((w) => w.id === selected.id) : undefined;
  const suggestions = setup
    ? setup.seats.filter((s) => s.source === "auto").length +
      setup.tables.filter((t) => t.source === "auto").length
    : 0;
  const hint = TOOLS.find((t) => t.id === tool)!.hint;

  // Over the whole page, outside the portal's light theme.
  return createPortal(
    <div className="setup-editor" role="dialog" aria-label={`Set up ${room.name}`}>
      <header className="setup-top">
        <div className="setup-title">
          <b>Set up {room.name}</b>
          <span className="muted">{dirty ? "Unsaved changes" : "Seats, tables and walkways"}</span>
        </div>
        <button
          className={`toggle${topView ? " on" : ""}`}
          onClick={() => setTopView(!topView)}
          aria-pressed={topView}
        >
          <MapIcon size={18} /> <span className="setup-label">Top view</span>
        </button>
        <button onClick={save} disabled={!dirty || saving || !setup}>
          {saving ? "Saving…" : "Save"}
        </button>
        <button className="secondary icon-only" onClick={close} aria-label="Close">
          <X size={18} />
        </button>
      </header>

      <div className="setup-body">
        <div className="setup-stage" ref={surface}>
          {scene && setup ? (
            <Canvas
              gl={{ antialias: true }}
              dpr={[1, 2]}
              camera={{ fov: 50, near: 0.05, far: 200 }}
            >
              <SetupScene
                scene={scene}
                collision={collision}
                setup={setup}
                selected={selected}
                tool={tool}
                topView={topView}
                showCollision={showCollision}
                seatKind={seatKind}
                surface={surface}
                onSelect={setSelected}
                onEdit={edit}
                onRoomState={setRoomState}
                onNotice={setNotice}
              />
            </Canvas>
          ) : (
            <div className="world-loading">{loadError ?? "Loading room…"}</div>
          )}
          {scene && roomState.state !== "ready" && (
            <div className="world-loading overlay">
              {roomState.state === "error"
                ? roomState.message
                : `Loading room…${roomState.progress !== null ? ` ${Math.round(roomState.progress * 100)}%` : ""}`}
            </div>
          )}
          <div className="setup-tools" role="toolbar" aria-label="Tools">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={`toggle${tool === t.id ? " on" : ""}`}
                aria-pressed={tool === t.id}
                onClick={() => setTool(t.id)}
              >
                {t.icon}
                <span className="setup-label">{t.label}</span>
              </button>
            ))}
          </div>
        </div>

        <aside className="setup-panel">
          <p className="hint setup-hint">{hint}</p>
          {tool === "seat" && (
            <label>
              New seats are
              <KindSelect value={seatKind} onChange={setSeatKind} />
            </label>
          )}
          {error && <p className="error">{error}</p>}
          {notice && <p className="setup-notice">{notice}</p>}

          {seat && (
            <SeatPanel
              seat={seat}
              onEdit={(patch) => edit(editSeat(seat.id, patch))}
              onRemove={() => remove({ kind: "seat", id: seat.id })}
            />
          )}
          {table && (
            <TablePanel
              table={table}
              onEdit={(patch) => edit(editTable(table.id, patch))}
              onRemove={() => remove({ kind: "table", id: table.id })}
            />
          )}
          {walkway && (
            <WalkwayPanel
              walkway={walkway}
              onEdit={(patch) => edit(editWalkway(walkway.id, patch))}
              onRemove={() => remove({ kind: "walkway", id: walkway.id })}
            />
          )}

          {!selected && setup && (
            <>
              {suggestions > 0 && (
                <div className="setup-card">
                  <p>
                    <b>{suggestions} suggested</b>{" "}
                    <span className="muted">
                      (dashed) seats and tables were found in the scan. Keep the ones that are
                      right.
                    </span>
                  </p>
                  <div className="row">
                    <button
                      className="secondary small"
                      onClick={() =>
                        edit((s) => ({
                          ...s,
                          seats: s.seats.map((x) => ({ ...x, source: "user" })),
                          tables: s.tables.map((x) => ({ ...x, source: "user" })),
                        }))
                      }
                    >
                      Keep all
                    </button>
                    <button
                      className="secondary small"
                      onClick={() =>
                        edit((s) => ({
                          ...s,
                          seats: s.seats.filter((x) => x.source !== "auto"),
                          tables: s.tables.filter((x) => x.source !== "auto"),
                        }))
                      }
                    >
                      Remove all
                    </button>
                  </div>
                </div>
              )}
              <ItemList setup={setup} onSelect={setSelected} />
            </>
          )}

          <label className="setup-check">
            <input
              type="checkbox"
              checked={showCollision}
              onChange={(e) => setShowCollision(e.target.checked)}
            />
            Show where people can't walk (collision boxes, with walkways cut out)
          </label>
        </aside>
      </div>
    </div>,
    document.body,
  );
}

function KindSelect(props: { value: Seat["kind"]; onChange(kind: Seat["kind"]): void }) {
  return (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value as Seat["kind"])}>
      {SEAT_KINDS.map((k) => (
        <option key={k.id} value={k.id}>
          {k.label}
        </option>
      ))}
    </select>
  );
}

/** A meters field that only reports numbers. */
function NumberField(props: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onChange(v: number): void;
}) {
  // What's being typed; otherwise the value, which follows drags in the room.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="setup-number">
      {props.label}
      <input
        type="number"
        inputMode="decimal"
        step={props.step ?? 0.05}
        min={props.min}
        max={props.max}
        value={draft ?? String(props.value)}
        onBlur={() => setDraft(null)}
        onChange={(e) => {
          setDraft(e.target.value);
          const v = Number(e.target.value);
          if (e.target.value !== "" && Number.isFinite(v)) props.onChange(v);
        }}
      />
    </label>
  );
}

function Suggested(props: { onKeep(): void; onRemove(): void }) {
  return (
    <div className="setup-card">
      <p className="muted">Suggested from the scan. Keep it if it's right.</p>
      <div className="row">
        <button className="small" onClick={props.onKeep}>
          Keep
        </button>
        <button className="secondary small" onClick={props.onRemove}>
          Remove
        </button>
      </div>
    </div>
  );
}

function Turn(props: { yaw: number; onTurn(yaw: number): void; label: string }) {
  return (
    <div className="setup-turn">
      <span>
        {props.label} <b>{degrees(props.yaw)}</b>
      </span>
      <button
        className="secondary small"
        aria-label="Turn left 15°"
        onClick={() => props.onTurn(turnYaw(props.yaw, 15))}
      >
        <RotateCcw size={16} /> 15°
      </button>
      <button
        className="secondary small"
        aria-label="Turn right 15°"
        onClick={() => props.onTurn(turnYaw(props.yaw, -15))}
      >
        <RotateCw size={16} /> 15°
      </button>
    </div>
  );
}

function SeatPanel(props: { seat: Seat; onEdit(patch: Partial<Seat>): void; onRemove(): void }) {
  const { seat, onEdit } = props;
  return (
    <section className="setup-inspector">
      <h3>Seat {seat.id}</h3>
      {seat.source === "auto" && <Suggested onKeep={() => onEdit({})} onRemove={props.onRemove} />}
      <label>
        Kind
        <KindSelect value={seat.kind} onChange={(kind) => onEdit({ kind })} />
      </label>
      <Turn label="Faces" yaw={seat.yaw} onTurn={(yaw) => onEdit({ yaw })} />
      <p className="hint">
        The arrow shows which way the sitter faces; drag its tip to turn it, or drag the cushion to
        move it. Seat height {seat.height.toFixed(2)} m.
      </p>
      <button className="danger small" onClick={props.onRemove}>
        <Trash size={16} /> Delete seat
      </button>
    </section>
  );
}

function TablePanel(props: {
  table: Table;
  onEdit(patch: Partial<Table>): void;
  onRemove(): void;
}) {
  const { table, onEdit } = props;
  const jigsaw = table.games.includes("jigsaw");
  return (
    <section className="setup-inspector">
      <h3>{table.name || "Table"}</h3>
      {table.source === "auto" && <Suggested onKeep={() => onEdit({})} onRemove={props.onRemove} />}
      <label>
        Name
        <input
          value={table.name}
          maxLength={40}
          placeholder="Coffee table"
          onChange={(e) => onEdit({ name: e.target.value })}
        />
      </label>
      <div className="setup-fields">
        <NumberField
          label="Width (m)"
          value={table.size[0]}
          min={0.2}
          max={10}
          onChange={(v) => v > 0 && v <= 10 && onEdit({ size: [v, table.size[1]] })}
        />
        <NumberField
          label="Depth (m)"
          value={table.size[1]}
          min={0.2}
          max={10}
          onChange={(v) => v > 0 && v <= 10 && onEdit({ size: [table.size[0], v] })}
        />
      </div>
      <Turn label="Turned" yaw={table.yaw} onTurn={(yaw) => onEdit({ yaw })} />
      <label className="setup-check">
        <input
          type="checkbox"
          checked={jigsaw}
          onChange={(e) => onEdit({ games: e.target.checked ? ["jigsaw"] : [] })}
        />
        Jigsaw puzzle
      </label>
      <p className="hint">
        Drag the corners to fit the tabletop, the blue dot to turn it, or the middle to move it.
      </p>
      <button className="danger small" onClick={props.onRemove}>
        <Trash size={16} /> Delete table
      </button>
    </section>
  );
}

function WalkwayPanel(props: {
  walkway: Walkway;
  onEdit(patch: Partial<Walkway>): void;
  onRemove(): void;
}) {
  const { walkway: w, onEdit } = props;
  // Edits that would turn the rectangle inside out are ignored.
  const set = (min: [number, number], max: [number, number]) => {
    if (min[0] < max[0] && min[1] < max[1]) onEdit({ min, max });
  };
  return (
    <section className="setup-inspector">
      <h3>Walkway</h3>
      <p className="hint">
        Nothing above the floor blocks people here. Drag the corners to resize it, or the middle to
        move it. {(w.max[0] - w.min[0]).toFixed(2)} × {(w.max[1] - w.min[1]).toFixed(2)} m.
      </p>
      <div className="setup-fields">
        <NumberField label="x from" value={w.min[0]} onChange={(v) => set([v, w.min[1]], w.max)} />
        <NumberField label="x to" value={w.max[0]} onChange={(v) => set(w.min, [v, w.max[1]])} />
        <NumberField label="z from" value={w.min[1]} onChange={(v) => set([w.min[0], v], w.max)} />
        <NumberField label="z to" value={w.max[1]} onChange={(v) => set(w.min, [w.max[0], v])} />
      </div>
      <button className="danger small" onClick={props.onRemove}>
        <Trash size={16} /> Delete walkway
      </button>
    </section>
  );
}

/** Everything placed so far, for picking things that are hard to tap in the room. */
function ItemList(props: { setup: RoomSetup; onSelect(sel: Selection): void }) {
  const { walkways, seats, tables } = props.setup;
  if (!walkways.length && !seats.length && !tables.length) {
    return (
      <p className="muted">
        Nothing set up yet. Pick a tool below the room view (or on top, on a phone) to add seats,
        tables and walkways.
      </p>
    );
  }
  const kind = (k: Seat["kind"]) => SEAT_KINDS.find((x) => x.id === k)!.label.toLowerCase();
  return (
    <ul className="setup-list">
      {seats.map((s) => (
        <li key={`s${s.id}`}>
          <button className="link" onClick={() => props.onSelect({ kind: "seat", id: s.id })}>
            <Armchair size={16} /> Seat {s.id} · {kind(s.kind)}
            {s.source === "auto" && " · suggested"}
          </button>
        </li>
      ))}
      {tables.map((t) => (
        <li key={`t${t.id}`}>
          <button className="link" onClick={() => props.onSelect({ kind: "table", id: t.id })}>
            <RectangleHorizontal size={16} /> {t.name || "Table"}
            {t.games.includes("jigsaw") && " · jigsaw"}
            {t.source === "auto" && " · suggested"}
          </button>
        </li>
      ))}
      {walkways.map((w, i) => (
        <li key={`w${w.id}`}>
          <button className="link" onClick={() => props.onSelect({ kind: "walkway", id: w.id })}>
            <Footprints size={16} /> Walkway {i + 1} · {(w.max[0] - w.min[0]).toFixed(1)} ×{" "}
            {(w.max[1] - w.min[1]).toFixed(1)} m
          </button>
        </li>
      ))}
    </ul>
  );
}
