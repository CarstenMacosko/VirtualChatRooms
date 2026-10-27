import { Html } from "@react-three/drei";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CanvasTexture, SRGBColorSpace } from "three";
import { isComplete, type JigsawAction, type JigsawSetup } from "@vcr/games";
import type { TableFrame, TablePointer, TableSceneProps } from "@vcr/games-sdk";
import { Confetti, PuzzlePieces } from "./PuzzlePieces";

type Props = TableSceneProps<JigsawSetup, JigsawAction>;

// Heights above the play surface (meters), under the pieces.
const MAT_Y = 0.0008;
const BOARD_Y = 0.0014;
const GHOST_Y = 0.0019;

/** A shared jigsaw on a table: the empty board, or the puzzle and its pieces. */
export function JigsawScene(props: Props) {
  const { table, setup } = props;
  return (
    <group position={table.center} rotation-y={table.yaw}>
      {setup ? (
        <Puzzle key={`${setup.seed}:${setup.cols}`} {...props} setup={setup} />
      ) : (
        <EmptyBoard table={table} />
      )}
    </group>
  );
}

function Puzzle(props: Props & { setup: JigsawSetup }) {
  const { setup, lowPower, playing, setPointer } = props;
  const gl = useThree((s) => s.gl);
  const pieces = useMemo(
    () => new PuzzlePieces(setup, lowPower, Math.min(8, gl.capabilities.getMaxAnisotropy())),
    [setup, lowPower, gl],
  );
  useEffect(() => () => pieces.dispose(), [pieces]);
  const confetti = useMemo(() => new Confetti(), []);
  useEffect(() => () => confetti.dispose(), [confetti]);

  // Items and callbacks are read every frame and in pointer handlers: always the latest ones.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });

  useFrame((_, dt) => {
    pieces.update(Math.min(dt, 0.1), performance.now(), latest.current);
    confetti.update(dt);
  });

  // While playing, the host hands us pointer input already projected onto the table.
  useEffect(() => {
    if (!playing) return;
    const cancel = () => {
      const piece = pieces.cancel();
      if (piece >= 0) latest.current.act({ type: "release", piece });
    };
    const pointer: TablePointer = {
      down(x, z, touch) {
        const { items, self, act } = latest.current;
        const piece = pieces.grab(x, z, touch, items, self);
        if (piece < 0) return false;
        act({ type: "grab", piece });
        return true;
      },
      move(x, z) {
        const at = pieces.moveTo(x, z);
        if (at) latest.current.drag(at.piece, at.x, at.z);
      },
      up(x, z) {
        const at = pieces.drop(x, z, latest.current.items);
        if (at) latest.current.act({ type: "drop", piece: at.piece, x: at.x, z: at.z });
      },
      cancel,
    };
    setPointer(pointer);
    return () => {
      cancel();
      setPointer(null);
    };
  }, [playing, pieces, setPointer]);

  // Celebrate when the last piece goes in (not when arriving at a finished puzzle).
  const count = setup.cols * setup.rows;
  const ready = props.items.length === count;
  const complete = ready && isComplete(props.items);
  const [seenComplete, setSeenComplete] = useState<boolean | null>(null);
  const [bursts, setBursts] = useState(0);
  if (ready && seenComplete !== complete) {
    setSeenComplete(complete);
    if (seenComplete === false && complete) setBursts((n) => n + 1);
  }
  const board = [setup.cols * setup.cell, setup.rows * setup.cell] as const;
  const spread = Math.max(board[0], board[1]);
  useEffect(() => {
    if (bursts > 0) confetti.burst(spread);
  }, [bursts, confetti, spread]);

  // Name tags over pieces other people are holding.
  const held: Array<{ piece: number; name: string; color: string }> = [];
  props.items.forEach((item, piece) => {
    if (!item.heldBy || item.heldBy === props.self) return;
    const who = props.holder(item.heldBy);
    if (who) held.push({ piece, ...who });
  });

  const [bx, bz] = setup.bounds;
  return (
    <>
      <mesh rotation-x={-Math.PI / 2} position-y={MAT_Y}>
        <planeGeometry args={[bx * 2 + setup.cell, bz * 2 + setup.cell]} />
        <meshStandardMaterial color="#2c4a42" roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={BOARD_Y}>
        <planeGeometry args={[board[0] + setup.cell * 0.3, board[1] + setup.cell * 0.3]} />
        <meshStandardMaterial color={complete ? "#c9a94b" : "#182b26"} roughness={0.9} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={GHOST_Y} material={pieces.ghost}>
        <planeGeometry args={[board[0], board[1]]} />
      </mesh>
      <primitive object={pieces.group} />
      <primitive object={confetti.points} />
      {held.map(({ piece, name, color }) => {
        const mesh = pieces.piece(piece);
        return (
          mesh && (
            <Fragment key={piece}>
              {createPortal(
                <Html
                  center
                  position={[0, 0.02, 0]}
                  style={{ pointerEvents: "none" }}
                  zIndexRange={[3, 0]}
                >
                  <span className="holder-tag" style={{ background: color }}>
                    {name}
                  </span>
                </Html>,
                mesh,
              )}
            </Fragment>
          )
        );
      })}
    </>
  );
}

let emptyBoardTexture: CanvasTexture | null = null;

/** A tabletop decal inviting people to start a puzzle. Drawn once, shared by every table. */
function emptyBoardDecal() {
  if (emptyBoardTexture) return emptyBoardTexture;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 320;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "rgb(30 52 46 / 0.92)";
  ctx.beginPath();
  ctx.roundRect(8, 8, 496, 304, 28);
  ctx.fill();
  ctx.setLineDash([18, 12]);
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgb(255 255 255 / 0.55)";
  ctx.beginPath();
  ctx.roundRect(28, 28, 456, 264, 18);
  ctx.stroke();
  // A puzzle piece: a square with a tab on top and on the right.
  ctx.setLineDash([]);
  ctx.fillStyle = "#ffd166";
  ctx.beginPath();
  ctx.moveTo(206, 90);
  ctx.lineTo(240, 90);
  ctx.arc(256, 84, 18, Math.PI * 0.8, Math.PI * 0.2, false);
  ctx.lineTo(306, 90);
  ctx.lineTo(306, 124);
  ctx.arc(312, 140, 18, -Math.PI * 0.7, Math.PI * 0.7, false);
  ctx.lineTo(306, 190);
  ctx.lineTo(206, 190);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 40px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Jigsaw puzzle", 256, 250);
  emptyBoardTexture = new CanvasTexture(canvas);
  emptyBoardTexture.colorSpace = SRGBColorSpace;
  return emptyBoardTexture;
}

function EmptyBoard({ table }: { table: TableFrame }) {
  const [w, d] = table.size;
  // The decal's 8:5 shape, as big as fits in 80% of the table.
  const scale = Math.min((w * 0.8) / 1.6, d * 0.8);
  return (
    <mesh rotation-x={-Math.PI / 2} position-y={MAT_Y}>
      <planeGeometry args={[1.6 * scale, scale]} />
      <meshBasicMaterial map={emptyBoardDecal()} transparent />
    </mesh>
  );
}
