import { useThree } from "@react-three/fiber";
import { useEffect, useMemo, useState } from "react";
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
import type { Clearance } from "@vcr/engine";
import type { SceneAssets } from "@vcr/protocol";
import { assetUrl } from "../lib/api";
import type { RoomLoadState } from "./RoomSplats";

/**
 * Renders a textured mesh room (a photogrammetry scan's GLB) the way the phone showed it: unlit,
 * because the scan's photos already hold the room's light, and without tone mapping, so the
 * colors aren't shifted. Placed in the world by the manifest's transform, like splats. Surfaces
 * inside `clearances` are hidden (see `roomClearances`).
 */
export function RoomMesh(props: {
  scene: SceneAssets;
  clearances: readonly Clearance[];
  onState?: (state: RoomLoadState) => void;
}) {
  const gl = useThree((s) => s.gl);
  const { scene, clearances, onState } = props;
  const [root, setRoot] = useState<Group | null>(null);
  // Shared by every material, so the boxes can change without reloading the room.
  const clear = useMemo<ClearUniforms>(
    () => ({
      vcrClear: { value: Array.from({ length: MAX_CLEARANCES }, () => new Matrix4()) },
      vcrClearCount: { value: 0 },
    }),
    [],
  );
  useEffect(() => setClearances(clear, clearances), [clear, clearances]);

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
            ? m.material.map((x) => unlit(x, anisotropy, clear))
            : unlit(m.material, anisotropy, clear);
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
  }, [scene, onState, gl, clear]);

  return root ? <primitive object={root} /> : null;
}

/** At most this many boxes hide the scan; past that, the rest are ignored. */
const MAX_CLEARANCES = 16;

/** World → each clearance's unit cube (|x|, |y|, |z| ≤ 1 inside), and how many are in use. */
interface ClearUniforms {
  vcrClear: { value: Matrix4[] };
  vcrClearCount: { value: number };
}

function setClearances(uniforms: ClearUniforms, clearances: readonly Clearance[]) {
  const used = clearances.slice(0, MAX_CLEARANCES);
  used.forEach((c, i) =>
    uniforms.vcrClear.value[i]!.compose(
      new Vector3(...c.center),
      new Quaternion().setFromEuler(new Euler(0, c.yaw, 0)),
      new Vector3(...c.half),
    ).invert(),
  );
  uniforms.vcrClearCount.value = used.length;
}

/** Discards the scan's surfaces inside the clearance boxes. */
function hideInside(material: MeshBasicMaterial, uniforms: ClearUniforms) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.vcrClear = uniforms.vcrClear;
    shader.uniforms.vcrClearCount = uniforms.vcrClearCount;
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
function unlit(material: Material, anisotropy: number, hide: ClearUniforms): Material {
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
