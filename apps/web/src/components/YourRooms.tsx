import { type FormEvent, useEffect, useRef, useState } from "react";
import type { CaptureOptions, RoomInfo, UpAxis } from "@vcr/protocol";
import { api, ApiRequestError, uploadParts } from "../lib/api";

const errorText = (err: unknown) =>
  err instanceof ApiRequestError ? err.message : "Something went wrong. Try again.";

const meters = (v: number) => `${v.toFixed(1)} m`;

const UP_LABELS: Record<UpAxis, string> = {
  "+y": "+Y (most apps)",
  "-y": "−Y (upside down)",
  "+z": "+Z",
  "-z": "−Z",
  "+x": "+X",
  "-x": "−X",
};

const SCALE_SOURCES = {
  file: "from the scan",
  ceiling: "guessed from the ceiling",
  walls: "guessed from the walls",
  user: "set by you",
} as const;

/** Your rooms: the sample room plus scans you've imported, and importing a new one. */
export function YourRooms(props: {
  rooms: RoomInfo[];
  capture: CaptureOptions | null;
  onChanged(): void;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="your-rooms">
      <h2>Your rooms</h2>
      <ul className="list rooms">
        {props.rooms.map((r) => (
          <RoomRow key={r.id} room={r} onChanged={props.onChanged} />
        ))}
      </ul>
      {adding ? (
        <AddScan
          capture={props.capture}
          onDone={() => {
            setAdding(false);
            props.onChanged();
          }}
          onCreated={props.onChanged}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <button className="secondary" onClick={() => setAdding(true)}>
          Add a room from a scan
        </button>
      )}
    </div>
  );
}

function RoomRow({ room, onChanged }: { room: RoomInfo; onChanged(): void }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scan = room.scan;

  const remove = async () => {
    if (!window.confirm(`Delete "${room.name}"? Its scan is deleted too.`)) return;
    try {
      await api.deleteRoom(room.id);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <li className="room-row">
      <div className="room-head">
        <span>
          <b>{room.name}</b>
          <span className="muted">
            {" "}
            ·{" "}
            {room.kind === "sample"
              ? "built-in sample room"
              : room.status === "ready" && scan
                ? `${meters(scan.size.width)} × ${meters(scan.size.depth)}, ${meters(scan.size.height)} tall`
                : room.status === "processing"
                  ? `getting it ready… ${Math.round((room.progress ?? 0) * 100)}%`
                  : room.status === "uploading"
                    ? "waiting for the upload"
                    : "couldn't be used"}
          </span>
        </span>
        {room.kind === "scan" && (
          <span className="row">
            {room.status === "ready" && (
              <button className="link" onClick={() => setOpen(!open)}>
                {open ? "Done" : "Adjust"}
              </button>
            )}
            <button className="link" onClick={remove}>
              Delete
            </button>
          </span>
        )}
      </div>
      {room.status === "processing" && <Progress value={room.progress ?? 0} />}
      {room.status === "failed" && room.error && <p className="error">{room.error}</p>}
      {error && <p className="error">{error}</p>}
      {open && scan && (
        <AdjustRoom
          room={room}
          onSaved={() => {
            setOpen(false);
            onChanged();
          }}
        />
      )}
    </li>
  );
}

/** The room setup fallback: name, size (when the scale estimate is off) and which way is up. */
function AdjustRoom({ room, onSaved }: { room: RoomInfo; onSaved(): void }) {
  const scan = room.scan!;
  const [name, setName] = useState(room.name);
  const [height, setHeight] = useState(scan.size.height);
  const [up, setUp] = useState<UpAxis>(scan.up ?? "+y");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const k = height / scan.size.height;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.updateRoom(room.id, {
        ...(name.trim() !== room.name && { name: name.trim() }),
        ...(Math.abs(height - scan.size.height) > 0.01 && { heightMeters: height }),
        ...(up !== (scan.up ?? "+y") && { up }),
      });
      onSaved();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="adjust-room" onSubmit={save}>
      <label>
        Name
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      </label>
      <label>
        Ceiling height: <b>{meters(height)}</b>{" "}
        <span className="muted">
          (scale {SCALE_SOURCES[scan.scaleSource]}; most rooms are 2.4–2.7 m)
        </span>
        <input
          type="range"
          min={1.8}
          max={4.5}
          step={0.05}
          value={height}
          onChange={(e) => setHeight(Number(e.target.value))}
        />
        <span className="hint">
          Floor: {meters(scan.size.width * k)} × {meters(scan.size.depth * k)}. If doorways looked
          too big or too small in the room, change this.
        </span>
      </label>
      <label>
        Which way is up in the scan file?
        <select value={up} onChange={(e) => setUp(e.target.value as UpAxis)}>
          {(Object.keys(UP_LABELS) as UpAxis[]).map((axis) => (
            <option key={axis} value={axis}>
              {UP_LABELS[axis]}
              {axis === scan.up ? " · detected" : ""}
            </option>
          ))}
        </select>
        <span className="hint">Only change this if the room came out sideways or upside down.</span>
      </label>
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>{busy ? "Saving…" : "Save"}</button>
    </form>
  );
}

function Progress({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(value * 100)}>
      <div style={{ width: `${Math.max(2, value * 100)}%` }} />
    </div>
  );
}

function AddScan(props: {
  capture: CaptureOptions | null;
  onCreated(): void;
  onDone(): void;
  onCancel(): void;
}) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const maxMb = Math.round((props.capture?.maxScanBytes ?? 500 * 1024 * 1024) / 1024 / 1024);

  // Leaving the page mid-upload loses it; ask first.
  useEffect(() => {
    if (progress === null) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [progress]);
  useEffect(() => () => abort.current?.abort(), []);

  const pick = (f: File | null) => {
    setFile(f);
    setError(null);
    if (f && !name)
      setName(
        f.name
          .replace(/\.(ply|spz)$/i, "")
          .replace(/[_-]+/g, " ")
          .slice(0, 60),
      );
  };

  async function upload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (!/\.(ply|spz)$/i.test(file.name)) {
      setError("Choose a .ply or .spz file exported from your scanning app.");
      return;
    }
    setError(null);
    setProgress(0);
    abort.current = new AbortController();
    let roomId: string | null = null;
    try {
      const { room, upload: plan } = await api.createScan({
        name: name.trim() || "My room",
        fileName: file.name,
        size: file.size,
      });
      roomId = room.id;
      props.onCreated();
      const parts = await uploadParts(file, plan, setProgress, abort.current.signal);
      await api.completeUpload(room.id, { parts });
      props.onDone();
    } catch (err) {
      setError(errorText(err));
      setProgress(null);
      // Don't leave a half-uploaded room behind.
      if (roomId) await api.deleteRoom(roomId).catch(() => {});
      props.onCreated();
    }
  }

  const uploading = progress !== null;
  return (
    <form className="add-scan callout" onSubmit={upload}>
      <h3>Add a room from a scan</h3>
      <p className="muted">
        Scan your room with a free phone app, export it as a Gaussian splat (<b>.spz</b> or{" "}
        <b>.ply</b>), and upload it here. Gatherings can then happen in your own room.
      </p>
      <details>
        <summary>How to export from Scaniverse, Polycam or KIRI</summary>
        <ul className="howto">
          <li>
            <b>Scaniverse</b> (free, iPhone and Android): scan in <i>Splat</i> mode, open the scan,
            tap <i>Share</i> / <i>Export</i>, and pick <b>SPZ</b> (smallest) or <b>PLY</b>.
          </li>
          <li>
            <b>Polycam</b>: make a <i>Gaussian Splat</i> capture, then <i>Export</i> it as a splat{" "}
            <b>PLY</b>.
          </li>
          <li>
            <b>KIRI Engine</b> app: make a <i>3DGS</i> scan, then export it as <b>PLY</b>.
          </li>
          <li>
            For a good room: walk slowly around the edges, sweep the whole floor and every wall,
            keep the lights on, and avoid filming mirrors head-on. Files up to {maxMb} MB.
          </li>
        </ul>
      </details>
      <label>
        Room name
        <input
          value={name}
          maxLength={60}
          placeholder="Living room"
          onChange={(e) => setName(e.target.value)}
          disabled={uploading}
        />
      </label>
      <label>
        Scan file
        <input
          type="file"
          accept=".ply,.spz"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
          disabled={uploading}
        />
      </label>
      {file && (
        <p className="hint">
          {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB
        </p>
      )}
      {uploading && (
        <>
          <Progress value={progress} />
          <p className="hint">
            Uploading… {Math.round(progress * 100)}%. Keep this page open; after that we get the
            room ready on our side (you can leave then).
          </p>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <div className="row">
        <button disabled={!file || uploading}>{uploading ? "Uploading…" : "Upload"}</button>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            abort.current?.abort();
            props.onCancel();
          }}
        >
          Cancel
        </button>
      </div>
      {props.capture && !props.capture.video.available && (
        <p className="hint">
          No scan yet? Recording a video in the app is coming. {props.capture.video.reason}
        </p>
      )}
    </form>
  );
}
