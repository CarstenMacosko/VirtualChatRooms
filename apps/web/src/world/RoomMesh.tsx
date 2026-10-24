import { useThree } from "@react-three/fiber";
import { useEffect, useState } from "react";
import {
  Euler,
  Group,
  type Material,
  Matrix4,
  type Mesh,
  MeshBasicMaterial,
  type MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { type Clearance, tableClearances } from "@vcr/engine";
import type { SceneAssets } from "@vcr/protocol";
import { assetUrl } from "../lib/api";
import type { RoomLoadState } from "./RoomSplats";

/**
 * Renders a textured mesh room (a photogrammetry scan's GLB) the way the phone showed it: unlit,
 * because the scan's photos already hold the room's light, and without tone mapping, so the
 * colors aren't shifted. Placed in the world by the manifest's transform, like splats.
 */
export function RoomMesh(props: { scene: SceneAssets; onState?: (state: RoomLoadState) => void }) {
  const gl = useThree((s) => s.gl);
  const { scene, onState } = props;
  const [root, setRoot] = useState<Group | null>(null);

  useEffect(() => {
    const { mesh, transform } = scene.manifest;
    const url = mesh ? scene.urls[mesh.key] : undefined;
    if (!url) {
      onState?.({ state: "error", message: "Couldn't load this room (its mesh is missing)." });
      return;
    }
    let cancelled = false;
    let loaded: Group | null = null;
    const anisotropy = gl.capabilities.getMaxAnisotropy();
    const hide = clearanceMatrices(tableClearances(scene.manifest.tables));
    new GLTFLoader().load(
      assetUrl(url),
      (gltf) => {
        const group = new Group();
        // world = translation + metersPerUnit · rotation(file): Object3D's T·R·S exactly.
        group.position.set(...transform.translation);
        group.quaternion.set(...transform.rotation);
        group.scale.setScalar(transform.metersPerUnit);
        gltf.scene.traverse((o) => {
          const m = o as Mesh;
          if (!m.isMesh) return;
          m.material = Array.isArray(m.material)
            ? m.material.map((x) => unlit(x, anisotropy, hide))
            : unlit(m.material, anisotropy, hide);
        });
        group.add(gltf.scene);
        loaded = group;
        if (cancelled) return dispose(group);
        setRoot(group);
        onState?.({ state: "ready", splats: 0 });
      },
      (e) => onState?.({ state: "loading", progress: e.total ? e.loaded / e.total : null }),
      (err) => {
        if (!cancelled) {
          onState?.({ state: "error", message: `Couldn't load this room (${String(err)}).` });
        }
      },
    );
    return () => {
      cancelled = true;
      if (loaded) dispose(loaded);
      setRoot(null);
    };
  }, [scene, onState, gl]);

  return root ? <primitive object={root} /> : null;
}

/** At most this many game tables have their clutter hidden. */
const MAX_CLEARANCES = 16;

/** World → each clearance's unit cube (|x|, |y|, |z| ≤ 1 inside). */
function clearanceMatrices(clearances: Clearance[]): Matrix4[] {
  return clearances
    .slice(0, MAX_CLEARANCES)
    .map((c) =>
      new Matrix4()
        .compose(
          new Vector3(...c.center),
          new Quaternion().setFromEuler(new Euler(0, c.yaw, 0)),
          new Vector3(...c.half),
        )
        .invert(),
    );
}

/** Discards the scan's surfaces inside the clearance boxes over game tables. */
function hideInside(material: MeshBasicMaterial, boxes: Matrix4[]) {
  if (!boxes.length) return;
  const padded = [...boxes];
  while (padded.length < MAX_CLEARANCES) padded.push(new Matrix4());
  material.onBeforeCompile = (shader) => {
    shader.uniforms.vcrClear = { value: padded };
    shader.uniforms.vcrClearCount = { value: boxes.length };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vcrWorld;")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvcrWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
varying vec3 vcrWorld;
uniform mat4 vcrClear[${MAX_CLEARANCES}];
uniform int vcrClearCount;`,
      )
      .replace(
        "void main() {",
        `void main() {
  for (int i = 0; i < ${MAX_CLEARANCES}; i++) {
    if (i >= vcrClearCount) break;
    vec3 q = (vcrClear[i] * vec4(vcrWorld, 1.0)).xyz;
    if (all(lessThanEqual(abs(q), vec3(1.0)))) discard;
  }`,
      );
  };
}

/** The material's texture and colors, without lighting or tone mapping. */
function unlit(material: Material, anisotropy: number, hide: Matrix4[]): Material {
  const lit = material as MeshStandardMaterial;
  if (lit.map) lit.map.anisotropy = anisotropy;
  const basic =
    material instanceof MeshBasicMaterial
      ? material
      : new MeshBasicMaterial({
          map: lit.map ?? null,
          color: lit.color,
          vertexColors: lit.vertexColors,
          side: lit.side,
          transparent: lit.transparent,
          opacity: lit.opacity,
          alphaTest: lit.alphaTest,
        });
  basic.toneMapped = false;
  hideInside(basic, hide);
  if (basic !== material) material.dispose();
  return basic;
}

function dispose(root: Group) {
  root.traverse((o) => {
    const m = o as Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    for (const material of Array.isArray(m.material) ? m.material : [m.material]) {
      (material as MeshBasicMaterial).map?.dispose();
      material.dispose();
    }
  });
}
