import { useEffect, useRef, useState } from "react";
import {
  isComplete,
  JIGSAW_PICTURES,
  JIGSAW_PIECE_COUNTS,
  type JigsawAction,
  type JigsawOptions,
  type JigsawPicture,
  type JigsawPieceCount,
  type JigsawSetup,
  placedCount,
} from "@vcr/games";
import type { TableHudProps, TableStartProps } from "@vcr/games-sdk";
import { drawPicture, PICTURE_NAMES } from "../pictures";

/** The picture, drawn into a canvas at its displayed size. */
function PictureThumb({ picture, aspect }: { picture: JigsawPicture; aspect: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.width = 240;
    canvas.height = Math.round(240 / aspect);
    drawPicture(ctx, picture, canvas.width, canvas.height);
  }, [picture, aspect]);
  return <canvas ref={ref} className="puzzle-thumb" aria-hidden />;
}

/** Choose a picture and how many pieces. */
export function JigsawStart({ table, start, cancel }: TableStartProps<JigsawOptions>) {
  const [picture, setPicture] = useState<JigsawPicture>("sunset");
  // Small tables get fewer, bigger pieces by default.
  const small = table.size[0] * table.size[1] < 0.5;
  const [pieces, setPieces] = useState<JigsawPieceCount>(small ? 24 : 48);
  return (
    <div className="puzzle-start" role="dialog" aria-label="Start a puzzle">
      <h3>Start a puzzle</h3>
      <div className="puzzle-pictures" role="radiogroup" aria-label="Picture">
        {JIGSAW_PICTURES.map((id) => (
          <button
            key={id}
            role="radio"
            aria-checked={picture === id}
            className={`puzzle-picture${picture === id ? " selected" : ""}`}
            onClick={() => setPicture(id)}
          >
            <PictureThumb picture={id} aspect={1.5} />
            <span>{PICTURE_NAMES[id]}</span>
          </button>
        ))}
      </div>
      <div className="puzzle-counts" role="radiogroup" aria-label="Pieces">
        {JIGSAW_PIECE_COUNTS.map((n) => (
          <button
            key={n}
            role="radio"
            aria-checked={pieces === n}
            className={pieces === n ? "selected" : "secondary"}
            onClick={() => setPieces(n)}
          >
            {n} pieces
          </button>
        ))}
      </div>
      <div className="row end">
        <button className="secondary" onClick={cancel}>
          Cancel
        </button>
        <button onClick={() => start({ picture, pieces })}>Start</button>
      </div>
    </div>
  );
}

/** Progress, and the picture on the box to work from. */
export function JigsawHud({ setup, items }: TableHudProps<JigsawSetup, JigsawAction>) {
  const [showPicture, setShowPicture] = useState(false);
  if (!setup) return null;
  const placed = placedCount(items);
  const done = isComplete(items);
  return (
    <div className="puzzle-hud">
      {done ? (
        <p className="puzzle-done">Puzzle complete!</p>
      ) : (
        <div className="puzzle-progress" aria-label={`${placed} of ${items.length} pieces placed`}>
          <span>
            {placed} / {items.length}
          </span>
          <div className="puzzle-bar">
            <div style={{ width: `${(placed / Math.max(1, items.length)) * 100}%` }} />
          </div>
        </div>
      )}
      <button
        className="secondary small"
        aria-pressed={showPicture}
        onClick={() => setShowPicture((v) => !v)}
      >
        {showPicture ? "Hide picture" : "Picture"}
      </button>
      {showPicture && (
        <div className="puzzle-reference">
          <PictureThumb picture={setup.picture} aspect={setup.cols / setup.rows} />
        </div>
      )}
    </div>
  );
}
