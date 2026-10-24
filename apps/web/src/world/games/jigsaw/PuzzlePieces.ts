import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Points,
  PointsMaterial,
  SRGBColorSpace,
} from "three";
import {
  clampToBounds,
  correctSpot,
  isPlaced,
  type JigsawSetup,
  pointInPolygon,
  snapsAt,
} from "@vcr/games";
import type { Holder, TableItem } from "@vcr/games-sdk";
import { buildPieceShapes, type PieceShapes } from "../pieceGeometry";
import { pictureCanvas } from "../pictures";

// Heights above the tabletop (meters). Loose pieces stack by how recently they moved.
export const PIECE_Y = 0.0024;
const STACK_STEP = 0.00012;
/** A held piece floats this high, so everyone can see it's in someone's hand. */
const LIFT = 0.012;
/** How far a holder's colored outline shows around the piece. */
const OUTLINE_SCALE = 1.14;
/** A grab the realm hasn't confirmed by now was refused (someone else got there first). */
const GRAB_TIMEOUT_MS = 1500;
/** How long a dropped piece shows where we dropped it while waiting for the realm. */
const PENDING_MS = 1500;
/** Fingers are blunt: a touch this close to a piece's center (in cells) picks it up. */
const TOUCH_REACH = 0.8;
/** How quickly pieces glide to where the realm (or someone's drag) says they are. */
const FOLLOW_RATE = 18;

export interface PiecesFrame {
  items: readonly TableItem[];
  self: string;
  liveDrag(item: number, out: { x: number; z: number }): boolean;
  holder(id: string): Holder | null;
}

interface Drag {
  piece: number;
  /** Piece center minus the pointer, so it doesn't jump under the finger. */
  dx: number;
  dz: number;
  x: number;
  z: number;
  since: number;
}

/** A drop we've sent but the realm hasn't answered yet. */
interface Pending {
  x: number;
  z: number;
  placed: boolean;
  at: number;
  /** The item as synced when we dropped it; any change means the realm has moved on. */
  was: TableItem;
}

/**
 * Every piece of one puzzle, drawn and moved imperatively: 96 meshes sharing one material and
 * one picture texture, updated in place each frame without allocating. Also tracks this
 * client's own drag and shows its drops right away while the realm confirms them.
 */
export class PuzzlePieces {
  readonly group = new Group();
  /** The picture, faint, on the board: the box lid to work from. */
  readonly ghost: MeshBasicMaterial;
  private readonly shapes: PieceShapes;
  private readonly texture: CanvasTexture;
  private readonly material: MeshStandardMaterial;
  private readonly pieces: Mesh[] = [];
  private readonly outlines: Mesh[] = [];
  private readonly outlineMaterials = new Map<string, MeshBasicMaterial>();
  private readonly count: number;
  private readonly display: Float32Array;
  private readonly lastX: Float32Array;
  private readonly lastZ: Float32Array;
  /** Piece indices, bottom of the pile first. */
  private readonly order: number[];
  private readonly rank: Int16Array;
  private orderChanged = true;
  private started = false;
  private drag: Drag | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly scratch = { x: 0, z: 0 };

  constructor(
    private readonly setup: JigsawSetup,
    lowPower: boolean,
    anisotropy: number,
  ) {
    this.count = setup.cols * setup.rows;
    this.shapes = buildPieceShapes(setup, lowPower ? 4 : 7);
    const canvas = pictureCanvas(setup.picture, lowPower ? 1024 : 2048, setup.cols / setup.rows);
    this.texture = new CanvasTexture(canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = anisotropy;
    this.material = new MeshStandardMaterial({
      map: this.texture,
      vertexColors: true,
      roughness: 0.7,
    });
    this.ghost = new MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    });
    for (const geometry of this.shapes.geometries) {
      const mesh = new Mesh(geometry, this.material);
      const outline = new Mesh(geometry, this.material);
      outline.scale.set(OUTLINE_SCALE, 0.5, OUTLINE_SCALE);
      outline.position.y = -0.0005;
      outline.visible = false;
      mesh.add(outline);
      this.outlines.push(outline);
      this.pieces.push(mesh);
      this.group.add(mesh);
    }
    this.display = new Float32Array(this.count * 2);
    this.lastX = new Float32Array(this.count).fill(Number.NaN);
    this.lastZ = new Float32Array(this.count).fill(Number.NaN);
    this.order = Array.from({ length: this.count }, (_, i) => i);
    this.rank = new Int16Array(this.count);
  }

  /** The mesh of piece `index`, e.g. to hang a name tag on. */
  piece(index: number): Mesh | undefined {
    return this.pieces[index];
  }

  update(dt: number, now: number, frame: PiecesFrame) {
    const { items, self } = frame;
    const { display, lastX, lastZ, rank, pending, scratch } = this;
    const k = 1 - Math.exp(-dt * FOLLOW_RATE);

    if (this.drag) {
      const heldBy = items[this.drag.piece]?.heldBy ?? "";
      const refused = heldBy !== "" && heldBy !== self;
      if (refused || (heldBy !== self && now - this.drag.since > GRAB_TIMEOUT_MS)) this.drag = null;
    }

    // Pieces that moved go on top of the pile.
    for (let i = 0; i < this.count; i++) {
      const item = items[i];
      if (!item || (item.x === lastX[i] && item.z === lastZ[i])) continue;
      if (this.started) this.bump(i);
      else {
        display[i * 2] = item.x;
        display[i * 2 + 1] = item.z;
      }
      lastX[i] = item.x;
      lastZ[i] = item.z;
    }
    this.started = items.length >= this.count;
    if (this.orderChanged) {
      this.order.forEach((piece, r) => (rank[piece] = r));
      this.orderChanged = false;
    }

    for (let i = 0; i < this.count; i++) {
      const item = items[i];
      const mesh = this.pieces[i]!;
      mesh.visible = !!item;
      if (!item) continue;
      const p = pending.get(i);
      if (p) {
        const was = p.was;
        const moved = was.x !== item.x || was.z !== item.z || was.flags !== item.flags;
        const answered = (moved || was.heldBy !== item.heldBy) && item.heldBy !== self;
        if (answered || now - p.at > PENDING_MS) pending.delete(i);
      }
      const drop = pending.get(i);
      const dragging = this.drag?.piece === i;
      let tx = item.x;
      let tz = item.z;
      let placed = isPlaced(item);
      if (this.drag && dragging) {
        tx = this.drag.x;
        tz = this.drag.z;
        placed = false;
      } else if (drop) {
        tx = drop.x;
        tz = drop.z;
        placed = drop.placed;
      } else if (item.heldBy && item.heldBy !== self && frame.liveDrag(i, scratch)) {
        tx = scratch.x;
        tz = scratch.z;
      }
      const x = dragging ? tx : display[i * 2]! + (tx - display[i * 2]!) * k;
      const z = dragging ? tz : display[i * 2 + 1]! + (tz - display[i * 2 + 1]!) * k;
      display[i * 2] = x;
      display[i * 2 + 1] = z;
      const holderId = dragging ? self : drop ? "" : item.heldBy;
      let y = placed ? PIECE_Y : PIECE_Y + STACK_STEP * (1 + rank[i]!);
      if (holderId && !placed) y += LIFT;
      mesh.position.set(x, y, z);

      const outline = this.outlines[i]!;
      const who = holderId ? frame.holder(holderId) : null;
      outline.visible = who !== null;
      if (who) outline.material = this.outlineMaterial(who.color);
    }
  }

  /** Starts dragging the piece under (x, z), if there's one free to take; returns it or -1. */
  grab(x: number, z: number, touch: boolean, items: readonly TableItem[], self: string): number {
    if (this.drag) return this.drag.piece;
    const piece = this.pick(x, z, touch, items, self);
    if (piece < 0) return -1;
    const cx = this.display[piece * 2]!;
    const cz = this.display[piece * 2 + 1]!;
    this.drag = { piece, dx: cx - x, dz: cz - z, x: cx, z: cz, since: performance.now() };
    this.pending.delete(piece);
    this.bump(piece);
    return piece;
  }

  /** Moves the dragged piece to follow the pointer; returns where it is now. */
  moveTo(x: number, z: number): { piece: number; x: number; z: number } | null {
    const drag = this.drag;
    if (!drag) return null;
    const at = clampToBounds(this.setup, x + drag.dx, z + drag.dz);
    drag.x = at.x;
    drag.z = at.z;
    return { piece: drag.piece, x: at.x, z: at.z };
  }

  /** Lets go of the dragged piece at (x, z), showing it there (or snapped) right away. */
  drop(x: number, z: number, items: readonly TableItem[]) {
    const at = this.moveTo(x, z);
    this.drag = null;
    if (!at) return null;
    const item = items[at.piece];
    const placed = snapsAt(this.setup, at.piece, at.x, at.z);
    const { cols, rows, cell } = this.setup;
    const spot = placed ? correctSpot(at.piece, cols, rows, cell) : at;
    if (item) {
      this.pending.set(at.piece, {
        x: spot.x,
        z: spot.z,
        placed,
        at: performance.now(),
        was: { ...item },
      });
    }
    return at;
  }

  /** Stops dragging without a drop; returns the piece that was being dragged, or -1. */
  cancel(): number {
    const piece = this.drag?.piece ?? -1;
    this.drag = null;
    return piece;
  }

  dispose() {
    this.shapes.geometries.forEach((g) => g.dispose());
    this.texture.dispose();
    this.material.dispose();
    this.ghost.dispose();
    this.outlineMaterials.forEach((m) => m.dispose());
  }

  /** The topmost free piece under (x, z); on touch, else the nearest one within reach. */
  private pick(x: number, z: number, touch: boolean, items: readonly TableItem[], self: string) {
    const free = (i: number) => {
      const item = items[i];
      return !!item && !isPlaced(item) && (!item.heldBy || item.heldBy === self);
    };
    const { cell } = this.setup;
    for (let r = this.order.length - 1; r >= 0; r--) {
      const i = this.order[r]!;
      if (!free(i)) continue;
      const px = (x - this.display[i * 2]!) / cell;
      const pz = (z - this.display[i * 2 + 1]!) / cell;
      if (Math.abs(px) > 0.8 || Math.abs(pz) > 0.8) continue;
      if (pointInPolygon(this.shapes.polygons[i]!, px, pz)) return i;
    }
    if (!touch) return -1;
    let best = -1;
    let bestDistance = TOUCH_REACH * cell;
    for (let i = 0; i < this.count; i++) {
      if (!free(i)) continue;
      const d = Math.hypot(x - this.display[i * 2]!, z - this.display[i * 2 + 1]!);
      if (d < bestDistance) {
        best = i;
        bestDistance = d;
      }
    }
    return best;
  }

  private bump(piece: number) {
    const at = this.order.indexOf(piece);
    if (at >= 0) this.order.splice(at, 1);
    this.order.push(piece);
    this.orderChanged = true;
  }

  private outlineMaterial(color: string) {
    let m = this.outlineMaterials.get(color);
    if (!m) {
      m = new MeshBasicMaterial({ color });
      this.outlineMaterials.set(color, m);
    }
    return m;
  }
}

const CONFETTI_COUNT = 160;
const CONFETTI_SECONDS = 3.5;
const CONFETTI_COLORS = ["#ff595e", "#ffca3a", "#8ac926", "#1982c4", "#6a4c93", "#ffffff"];

/** A burst of confetti over a finished puzzle. */
export class Confetti {
  readonly points: Points;
  private readonly positions = new Float32Array(CONFETTI_COUNT * 3);
  private readonly velocity = new Float32Array(CONFETTI_COUNT * 3);
  private readonly material = new PointsMaterial({
    size: 0.03,
    vertexColors: true,
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  private age = 0;

  constructor() {
    const colors = new Float32Array(CONFETTI_COUNT * 3);
    const color = new Color();
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      color.set(CONFETTI_COLORS[i % CONFETTI_COLORS.length]!);
      colors.set([color.r, color.g, color.b], i * 3);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(this.positions, 3));
    geometry.setAttribute("color", new BufferAttribute(colors, 3));
    this.points = new Points(geometry, this.material);
    this.points.visible = false;
    this.points.frustumCulled = false;
  }

  /** Throws confetti up from across an area `spread` meters wide. */
  burst(spread: number) {
    const { positions, velocity } = this;
    for (let i = 0; i < CONFETTI_COUNT; i++) {
      const angle = Math.random() * Math.PI * 2;
      const out = 0.3 + Math.random() * 0.6;
      positions.set(
        [(Math.random() - 0.5) * spread, 0.02, (Math.random() - 0.5) * spread * 0.6],
        i * 3,
      );
      velocity.set(
        [Math.cos(angle) * out, 1.4 + Math.random() * 1.2, Math.sin(angle) * out],
        i * 3,
      );
    }
    this.age = 0;
    this.points.visible = true;
  }

  update(rawDt: number) {
    if (!this.points.visible) return;
    const dt = Math.min(rawDt, 0.05);
    this.age += dt;
    const { positions, velocity } = this;
    const drag = 1 - 1.5 * dt;
    for (let i = 0; i < CONFETTI_COUNT * 3; i += 3) {
      velocity[i + 1] = (velocity[i + 1]! - 3 * dt) * drag;
      velocity[i] = velocity[i]! * drag;
      velocity[i + 2] = velocity[i + 2]! * drag;
      positions[i] = positions[i]! + velocity[i]! * dt;
      positions[i + 1] = Math.max(0.004, positions[i + 1]! + velocity[i + 1]! * dt);
      positions[i + 2] = positions[i + 2]! + velocity[i + 2]! * dt;
    }
    this.points.geometry.getAttribute("position").needsUpdate = true;
    this.material.opacity = Math.max(0, 1 - this.age / CONFETTI_SECONDS);
    if (this.age > CONFETTI_SECONDS) this.points.visible = false;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
