import { BufferAttribute, type BufferGeometry, ExtrudeGeometry, Shape } from "three";
import {
  flattenOutline,
  type JigsawSetup,
  type Outline,
  pieceOutline,
  type Point,
  puzzleCuts,
} from "@vcr/games";

export interface PieceShapes {
  /** One per piece, centered on its cell: x/z in meters, bottom at y = 0, top at `thickness`. */
  geometries: BufferGeometry[];
  /** Each piece's outline in cell units, for picking it up. */
  polygons: Point[][];
  thickness: number;
}

/** The cardboard edge of a piece, as a share of the picture's brightness. */
const EDGE_SHADE = 0.72;

/**
 * Thin extruded jigsaw pieces with the picture mapped onto them, so each shows its part of it.
 * Shapes are unique per piece, but all of them share one material (and one texture).
 */
export function buildPieceShapes(setup: JigsawSetup, curveSegments: number): PieceShapes {
  const { cols, rows, cell } = setup;
  const cuts = puzzleCuts(setup.seed, cols, rows);
  const thickness = Math.min(0.004, cell * 0.07);
  const geometries: BufferGeometry[] = [];
  const polygons: Point[][] = [];
  for (let i = 0; i < cols * rows; i++) {
    const outline = pieceOutline(cuts, i);
    polygons.push(flattenOutline(outline, 6));
    const geometry = new ExtrudeGeometry(toShape(outline), {
      depth: 1,
      bevelEnabled: false,
      curveSegments,
    });
    // Shape (x, y) with depth along +z becomes (x, depth, -y): the outline's z was negated in
    // toShape, so x and z come out as in the outline and the piece stands along +y.
    geometry.rotateX(-Math.PI / 2);
    mapPicture(geometry, i % cols, Math.floor(i / cols), cols, rows);
    geometry.scale(cell, thickness, cell);
    geometry.computeBoundingSphere();
    geometries.push(geometry);
  }
  return { geometries, polygons, thickness };
}

function toShape(outline: Outline): Shape {
  const shape = new Shape();
  shape.moveTo(outline.start[0], -outline.start[1]);
  for (const s of outline.segments) {
    if (s.kind === "line") shape.lineTo(s.to[0], -s.to[1]);
    else shape.bezierCurveTo(s.c1[0], -s.c1[1], s.c2[0], -s.c2[1], s.to[0], -s.to[1]);
  }
  return shape;
}

/** UVs from each vertex's place in the picture; edges get a darker vertex color. */
function mapPicture(
  geometry: BufferGeometry,
  col: number,
  row: number,
  cols: number,
  rows: number,
) {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = new Float32Array(position.count * 2);
  const color = new Float32Array(position.count * 3);
  for (let v = 0; v < position.count; v++) {
    uv[v * 2] = (col + 0.5 + position.getX(v)) / cols;
    uv[v * 2 + 1] = 1 - (row + 0.5 + position.getZ(v)) / rows;
    const shade = Math.abs(normal.getY(v)) > 0.5 ? 1 : EDGE_SHADE;
    color.fill(shade, v * 3, v * 3 + 3);
  }
  geometry.setAttribute("uv", new BufferAttribute(uv, 2));
  geometry.setAttribute("color", new BufferAttribute(color, 3));
}
