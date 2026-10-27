import { useEffect, useMemo, useState } from "react";
import { type LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import {
  BackSide,
  CanvasTexture,
  DoubleSide,
  type MeshStandardMaterialParameters,
  RepeatWrapping,
  SRGBColorSpace,
  type Texture,
  VideoTexture,
} from "three";
import {
  type BuiltInRoom as BuiltInRoomData,
  type Finish,
  OVAL_OFFICE,
  type Picture,
  type RoomPart,
  type ScreenPart,
} from "@vcr/engine";
import type { RoomLoadState } from "./RoomSplats";

/** A shared screen the projector can show: someone else's, or your own. */
export type ProjectorTrack = RemoteVideoTrack | LocalVideoTrack;

/**
 * A built-in room drawn as solid geometry from its parts in @vcr/engine, so its surfaces are
 * clean and match its collision exactly. Pictures (the parquet, the rug, windows) are painted once
 * onto small canvases. A projector screen shows `projector`, the newest screen shared in the call.
 */
export function BuiltInRoom({
  room,
  projector,
  onState,
}: {
  room: BuiltInRoomData;
  projector: ProjectorTrack | null;
  onState?: (state: RoomLoadState) => void;
}) {
  useEffect(() => onState?.({ state: "ready", splats: 0 }), [onState]);
  return (
    <group>
      {room.parts.map((part, i) =>
        part.kind === "screen" ? (
          <Screen key={i} part={part} track={projector} />
        ) : (
          <Part key={i} part={part} />
        ),
      )}
      {room.lights.map((light, i) => (
        <pointLight
          key={i}
          position={light.position}
          intensity={light.intensity}
          distance={light.distance}
          color={light.color}
        />
      ))}
    </group>
  );
}

const FINISHES: Record<Finish, MeshStandardMaterialParameters> = {
  paint: { roughness: 0.92 },
  trim: { roughness: 0.6 },
  wood: { roughness: 0.55 },
  darkWood: { roughness: 0.4 },
  fabric: { roughness: 0.95 },
  leather: { roughness: 0.5 },
  marble: { roughness: 0.25 },
  brass: { roughness: 0.32, metalness: 0.85 },
  metal: { roughness: 0.35, metalness: 0.7 },
  carpet: { roughness: 1 },
  glow: { roughness: 0.8 },
};

/** Pictures that tile once per meter; the rest stretch over their part. */
const TILED = new Set<Picture>(["parquet", "carpet"]);

function Material({
  part,
  repeat,
  side,
}: {
  part: RoomPart;
  /** The part's size in meters along the picture's U and V, for tiled pictures. */
  repeat?: [number, number];
  side?: typeof BackSide | typeof DoubleSide;
}) {
  const picture = "picture" in part ? part.picture : undefined;
  const [ru, rv] = repeat ?? [1, 1];
  const map = useMemo(
    () => (picture ? pictureTexture(picture, TILED.has(picture) ? [ru, rv] : [1, 1]) : null),
    [picture, ru, rv],
  );
  const glow = part.finish === "glow";
  return (
    <meshStandardMaterial
      {...FINISHES[part.finish]}
      color={map ? "#ffffff" : part.color}
      map={map}
      emissive={glow ? (map ? "#ffffff" : part.color) : "#000000"}
      emissiveMap={glow ? map : null}
      emissiveIntensity={glow ? 0.85 : 0}
      side={side}
    />
  );
}

function Part({ part }: { part: Exclude<RoomPart, ScreenPart> }) {
  switch (part.kind) {
    case "box":
      return (
        <mesh position={part.center} rotation-y={part.yaw ?? 0}>
          <boxGeometry args={part.size} />
          <Material part={part} repeat={[part.size[0], part.size[2]]} />
        </mesh>
      );
    case "cylinder":
      return (
        <mesh position={part.center}>
          <cylinderGeometry args={[part.radiusTop ?? part.radius, part.radius, part.height, 32]} />
          <Material part={part} />
        </mesh>
      );
    case "sphere":
      return (
        <mesh position={part.center}>
          <sphereGeometry args={[part.radius, 32, 16]} />
          <Material part={part} />
        </mesh>
      );
    case "oval":
      // A unit circle in XY: turned to face up (or down) and stretched to the oval.
      return (
        <mesh
          position={[0, part.y, 0]}
          rotation-x={part.down ? Math.PI / 2 : -Math.PI / 2}
          scale={[part.radii[0], part.radii[1], 1]}
        >
          <circleGeometry args={[1, 128]} />
          <Material part={part} repeat={[part.radii[0] * 2, part.radii[1] * 2]} />
        </mesh>
      );
    case "wallBand":
      return (
        <mesh position={[0, (part.y0 + part.y1) / 2, 0]} scale={[part.radii[0], 1, part.radii[1]]}>
          <cylinderGeometry args={[1, 1, part.y1 - part.y0, 160, 1, true]} />
          <Material part={part} side={BackSide} />
        </mesh>
      );
    case "panel":
      return (
        <mesh position={part.center} rotation-y={part.yaw}>
          <planeGeometry args={part.size} />
          <Material part={part} side={part.picture === "flag" ? DoubleSide : undefined} />
        </mesh>
      );
  }
}

// --- the projector screen --------------------------------------------------------------------

/**
 * What the projector tells LiveKit about where it shows a remote screen: always visible, at full
 * HD. With adaptive streaming LiveKit only sends video to elements it can see on the page, and the
 * projector draws into WebGL, not a visible <video>.
 */
function projectorElementInfo(element: HTMLVideoElement) {
  return {
    element,
    width: () => 1920,
    height: () => 1080,
    visible: true,
    pictureInPicture: false,
    visibilityChangedAt: 0,
    observe() {},
    stopObserving() {},
  };
}

/** The shared screen as a texture, and its aspect once the first frame's size is known. */
function useScreenTexture(track: ProjectorTrack | null) {
  const [screen, setScreen] = useState<{ texture: VideoTexture; aspect: number } | null>(null);
  useEffect(() => {
    if (!track) return;
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    // Kept in the page (iOS only decodes video elements that are), but invisible.
    Object.assign(video.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "2px",
      height: "2px",
      opacity: "0",
      pointerEvents: "none",
    });
    document.body.appendChild(video);
    video.srcObject = new MediaStream([track.mediaStreamTrack]);
    const texture = new VideoTexture(video);
    texture.colorSpace = SRGBColorSpace;
    let alive = true;
    const sized = () => {
      if (alive && video.videoWidth > 0 && video.videoHeight > 0) {
        setScreen({ texture, aspect: video.videoWidth / video.videoHeight });
      }
    };
    video.addEventListener("loadedmetadata", sized);
    video.addEventListener("resize", sized);
    void video.play().catch(() => {});
    const info = track instanceof RemoteVideoTrack ? projectorElementInfo(video) : null;
    if (info) (track as RemoteVideoTrack).observeElementInfo(info);
    return () => {
      alive = false;
      if (info) (track as RemoteVideoTrack).stopObservingElementInfo(info);
      video.removeEventListener("loadedmetadata", sized);
      video.removeEventListener("resize", sized);
      video.pause();
      video.srcObject = null;
      video.remove();
      texture.dispose();
      setScreen(null);
    };
  }, [track]);
  return screen;
}

function Screen({ part, track }: { part: ScreenPart; track: ProjectorTrack | null }) {
  const screen = useScreenTexture(track);
  const idle = useMemo(() => idleScreenTexture(track ? "loading" : "idle"), [track]);
  const [w, h] = part.size;
  // The shared screen fits inside the projector screen, letterboxed in black.
  const fit: [number, number] = screen
    ? screen.aspect > w / h
      ? [w, w / screen.aspect]
      : [h * screen.aspect, h]
    : [w, h];
  return (
    <group position={part.center} rotation-y={part.yaw}>
      <mesh>
        <planeGeometry args={part.size} />
        {/* Separate materials (keys): one material switching between them keeps a stale shader. */}
        {screen ? (
          <meshBasicMaterial key="letterbox" color="#000000" />
        ) : (
          <meshBasicMaterial key="idle" map={idle} toneMapped={false} />
        )}
      </mesh>
      {screen && (
        <mesh position={[0, 0, 0.004]}>
          <planeGeometry args={fit} />
          <meshBasicMaterial map={screen.texture} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

const idleTextures = new Map<"idle" | "loading", Texture>();

/** The projector screen when nothing is being shown. */
function idleScreenTexture(state: "idle" | "loading"): Texture {
  let texture = idleTextures.get(state);
  if (!texture) {
    const [el, ctx] = canvas(1280, 720);
    const bg = ctx.createLinearGradient(0, 0, 0, 720);
    bg.addColorStop(0, "#f7f8fa");
    bg.addColorStop(1, "#e4e8ee");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1280, 720);
    // A simple monitor with an arrow: "share your screen".
    ctx.strokeStyle = "#5b6b82";
    ctx.lineWidth = 14;
    ctx.lineJoin = "round";
    ctx.strokeRect(540, 190, 200, 130);
    ctx.beginPath();
    ctx.moveTo(600, 360);
    ctx.lineTo(680, 360);
    ctx.stroke();
    if (state === "idle") {
      ctx.beginPath();
      ctx.moveTo(640, 290);
      ctx.lineTo(640, 225);
      ctx.moveTo(612, 252);
      ctx.lineTo(640, 224);
      ctx.lineTo(668, 252);
      ctx.stroke();
    }
    ctx.fillStyle = "#2d3b52";
    ctx.textAlign = "center";
    ctx.font = "600 56px system-ui, -apple-system, sans-serif";
    ctx.fillText(
      state === "idle" ? "Share your screen to show it here" : "Loading the shared screen…",
      640,
      470,
    );
    ctx.fillStyle = "#6b7a90";
    ctx.font = "400 34px system-ui, -apple-system, sans-serif";
    if (state === "idle") {
      ctx.fillText("Anyone in the call can present from the call controls.", 640, 535);
    }
    texture = new CanvasTexture(el);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 4;
    idleTextures.set(state, texture);
  }
  return texture;
}

// --- pictures ------------------------------------------------------------------------------

const canvases = new Map<Picture, HTMLCanvasElement>();
const textures = new Map<string, Texture>();

/** A picture's texture, repeated `repeat` times along U and V (tiled pictures are 1 m tiles). */
function pictureTexture(picture: Picture, repeat: [number, number]): Texture {
  const key = `${picture}:${repeat[0]}:${repeat[1]}`;
  let texture = textures.get(key);
  if (!texture) {
    let image = canvases.get(picture);
    if (!image) canvases.set(picture, (image = PAINTERS[picture]()));
    texture = new CanvasTexture(image);
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 4;
    if (repeat[0] !== 1 || repeat[1] !== 1) {
      texture.wrapS = texture.wrapT = RepeatWrapping;
      texture.repeat.set(repeat[0], repeat[1]);
    }
    textures.set(key, texture);
  }
  return texture;
}

function canvas(width: number, height: number) {
  const el = document.createElement("canvas");
  el.width = width;
  el.height = height;
  return [el, el.getContext("2d")!] as const;
}

/** A canvas with the Oval Office's aspect, so circles drawn on it stay round on its floor. */
function ovalCanvas(height: number) {
  const { max } = OVAL_OFFICE.bounds;
  return canvas(Math.round((height * max[0]) / max[2]), height);
}

/** A tiny repeatable random, so every client paints the same room. */
function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function star(ctx: CanvasRenderingContext2D, x: number, y: number, outer: number, points = 5) {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 ? outer * 0.45 : outer;
    const a = (i * Math.PI) / points - Math.PI / 2;
    ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
}

const PAINTERS: Record<Picture, () => HTMLCanvasElement> = {
  parquet() {
    // 2 × 2 squares per meter, planks alternating direction: classic parquet.
    const [el, ctx] = canvas(512, 512);
    const rand = seeded(7);
    for (let sy = 0; sy < 2; sy++) {
      for (let sx = 0; sx < 2; sx++) {
        const across = (sx + sy) % 2 === 0;
        for (let p = 0; p < 5; p++) {
          const t = rand() * 0.14 - 0.07;
          ctx.fillStyle = `rgb(${(0.6 + t) * 255}, ${(0.42 + t * 0.8) * 255}, ${(0.26 + t * 0.5) * 255})`;
          const [x, y, w, h] = across
            ? [sx * 256, sy * 256 + p * 51.2, 256, 51.2]
            : [sx * 256 + p * 51.2, sy * 256, 51.2, 256];
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = "rgba(60, 35, 20, 0.35)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x, y, w, h);
        }
      }
    }
    return el;
  },
  rug() {
    const [el, ctx] = ovalCanvas(1024);
    const cx = el.width / 2;
    const cy = el.height / 2;
    const ring = (inset: number, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.ellipse(cx, cy, cx - inset, cy - inset, 0, 0, Math.PI * 2);
      ctx.fill();
    };
    ctx.fillStyle = "#c9a24a";
    ctx.fillRect(0, 0, el.width, el.height);
    ring(18, "#1f2d4d");
    ring(52, "#c9a24a");
    ring(60, "#22335a");
    ring(200, "#2a3d68");
    ring(206, "#c9a24a");
    ring(212, "#22335a");
    // A ring of stars and a gold sunburst in the middle (not any official seal).
    ctx.fillStyle = "#d9b45a";
    for (let i = 0; i < 13; i++) {
      const a = (i / 13) * Math.PI * 2;
      star(ctx, cx + Math.cos(a) * 150, cy + Math.sin(a) * 150, 13);
    }
    ctx.fillStyle = "#c9a24a";
    star(ctx, cx, cy, 95, 16);
    ctx.fillStyle = "#e3c675";
    star(ctx, cx, cy, 55, 8);
    return el;
  },
  ceiling() {
    const [el, ctx] = ovalCanvas(512);
    ctx.fillStyle = "#f8f5ee";
    ctx.fillRect(0, 0, el.width, el.height);
    const cx = el.width / 2;
    const cy = el.height / 2;
    for (const [r, color] of [
      [118, "#ece6d8"],
      [110, "#f8f5ee"],
      [70, "#efe9dc"],
      [62, "#fbf9f4"],
    ] as const) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    return el;
  },
  window() {
    const [el, ctx] = canvas(256, 640);
    const sky = ctx.createLinearGradient(0, 0, 0, 640);
    sky.addColorStop(0, "#9cc8ee");
    sky.addColorStop(0.75, "#dcecf7");
    sky.addColorStop(1, "#a9c79a");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 256, 640);
    ctx.fillStyle = "#f7f4ec";
    ctx.fillRect(0, 0, 256, 18);
    ctx.fillRect(0, 622, 256, 18);
    ctx.fillRect(0, 0, 18, 640);
    ctx.fillRect(238, 0, 18, 640);
    for (const x of [86, 162]) ctx.fillRect(x, 0, 8, 640);
    for (const y of [160, 320, 480]) ctx.fillRect(0, y - 4, 256, 8);
    return el;
  },
  door() {
    const [el, ctx] = canvas(256, 632);
    ctx.fillStyle = "#f6f2e8";
    ctx.fillRect(0, 0, 256, 632);
    ctx.strokeStyle = "#d8d0bf";
    ctx.lineWidth = 6;
    for (const [y, h] of [
      [40, 150],
      [220, 200],
      [450, 150],
    ]) {
      for (const x of [34, 138]) ctx.strokeRect(x, y!, 84, h!);
    }
    ctx.fillStyle = "#c9a24a";
    ctx.beginPath();
    ctx.arc(222, 330, 9, 0, Math.PI * 2);
    ctx.fill();
    return el;
  },
  painting() {
    const [el, ctx] = canvas(520, 400);
    ctx.fillStyle = "#b8913c";
    ctx.fillRect(0, 0, 520, 400);
    ctx.fillStyle = "#8a6a26";
    ctx.fillRect(26, 26, 468, 348);
    const sky = ctx.createLinearGradient(0, 34, 0, 250);
    sky.addColorStop(0, "#7fa9c9");
    sky.addColorStop(1, "#f1d9a8");
    ctx.fillStyle = sky;
    ctx.fillRect(34, 34, 452, 332);
    ctx.fillStyle = "#8c96a8";
    ctx.beginPath();
    ctx.moveTo(34, 230);
    ctx.lineTo(150, 140);
    ctx.lineTo(240, 210);
    ctx.lineTo(340, 120);
    ctx.lineTo(486, 220);
    ctx.lineTo(486, 366);
    ctx.lineTo(34, 366);
    ctx.fill();
    ctx.fillStyle = "#5d7d4a";
    ctx.beginPath();
    ctx.moveTo(34, 290);
    ctx.quadraticCurveTo(200, 230, 486, 280);
    ctx.lineTo(486, 366);
    ctx.lineTo(34, 366);
    ctx.fill();
    ctx.fillStyle = "#9cc0d8";
    ctx.beginPath();
    ctx.moveTo(200, 366);
    ctx.quadraticCurveTo(250, 300, 330, 282);
    ctx.lineTo(345, 286);
    ctx.quadraticCurveTo(290, 320, 270, 366);
    ctx.fill();
    return el;
  },
  books() {
    const [el, ctx] = canvas(256, 540);
    ctx.fillStyle = "#f3efe5";
    ctx.fillRect(0, 0, 256, 540);
    const rand = seeded(11);
    const spines = ["#7a2a24", "#24426e", "#c49a3e", "#2f5a3e", "#e9e2d0", "#4b3460", "#5c3a24"];
    for (let shelf = 0; shelf < 4; shelf++) {
      const top = 22 + shelf * 128;
      ctx.fillStyle = "#e4dccb";
      ctx.fillRect(12, top, 232, 110);
      let x = 16;
      while (x < 236) {
        const w = 8 + rand() * 10;
        const h = 70 + rand() * 34;
        ctx.fillStyle = spines[Math.floor(rand() * spines.length)]!;
        ctx.fillRect(x, top + 110 - h, Math.min(w, 240 - x), h);
        x += w + 1;
      }
    }
    return el;
  },
  firebox() {
    const [el, ctx] = canvas(256, 216);
    ctx.fillStyle = "#1c1410";
    ctx.fillRect(0, 0, 256, 216);
    const glow = ctx.createRadialGradient(128, 190, 10, 128, 190, 120);
    glow.addColorStop(0, "#ffb347");
    glow.addColorStop(0.35, "#e0561e");
    glow.addColorStop(1, "rgba(28, 20, 16, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 60, 256, 156);
    ctx.fillStyle = "#3b2416";
    ctx.fillRect(60, 180, 140, 16);
    ctx.fillRect(80, 168, 100, 14);
    return el;
  },
  flag() {
    const [el, ctx] = canvas(380, 500);
    // Hung vertically: stripes run top to bottom, the canton at the top left.
    for (let i = 0; i < 13; i++) {
      ctx.fillStyle = i % 2 ? "#ffffff" : "#b22234";
      ctx.fillRect((i * 380) / 13, 0, 380 / 13 + 1, 500);
    }
    ctx.fillStyle = "#3c3b6e";
    ctx.fillRect(0, 0, (380 * 7) / 13, 270);
    ctx.fillStyle = "#ffffff";
    for (let row = 0; row < 11; row++) {
      for (let col = 0; col < (row % 2 ? 4 : 5); col++) {
        star(ctx, 20 + col * 38 + (row % 2 ? 19 : 0), 16 + row * 24, 7);
      }
    }
    return el;
  },
  carpet() {
    // Low-pile office carpet: a charcoal blue with fine flecks, a 1 m tile.
    const [el, ctx] = canvas(256, 256);
    ctx.fillStyle = "#3d4656";
    ctx.fillRect(0, 0, 256, 256);
    const rand = seeded(5);
    for (let i = 0; i < 2600; i++) {
      const t = rand();
      ctx.fillStyle = t < 0.5 ? "rgba(255, 255, 255, 0.07)" : "rgba(0, 0, 0, 0.12)";
      ctx.fillRect(rand() * 256, rand() * 256, 2, 2);
    }
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, 256, 256);
    return el;
  },
  acoustic() {
    // A fabric acoustic panel with vertical grooves.
    const [el, ctx] = canvas(440, 320);
    ctx.fillStyle = "#56677f";
    ctx.fillRect(0, 0, 440, 320);
    ctx.fillStyle = "#4a5a71";
    for (let x = 20; x < 440; x += 40) ctx.fillRect(x, 0, 6, 320);
    ctx.strokeStyle = "#3e4c60";
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, 432, 312);
    return el;
  },
  cityWindow() {
    // Floor-to-ceiling glass onto a skyline at dusk.
    const [el, ctx] = canvas(520, 560);
    const sky = ctx.createLinearGradient(0, 0, 0, 560);
    sky.addColorStop(0, "#3c5a8a");
    sky.addColorStop(0.55, "#d79a7a");
    sky.addColorStop(1, "#f1c995");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, 520, 560);
    const rand = seeded(23);
    let x = 0;
    while (x < 520) {
      const w = 30 + rand() * 50;
      const h = 120 + rand() * 260;
      ctx.fillStyle = rand() < 0.5 ? "#2a3550" : "#34405e";
      ctx.fillRect(x, 560 - h, w, h);
      ctx.fillStyle = "rgba(255, 221, 150, 0.75)";
      for (let wy = 560 - h + 10; wy < 548; wy += 16) {
        for (let wx = x + 5; wx < x + w - 6; wx += 10) {
          if (rand() < 0.35) ctx.fillRect(wx, wy, 5, 7);
        }
      }
      x += w + 2;
    }
    ctx.fillStyle = "#cfd5dd";
    ctx.fillRect(0, 0, 520, 14);
    ctx.fillRect(0, 546, 520, 14);
    ctx.fillRect(0, 0, 12, 560);
    ctx.fillRect(508, 0, 12, 560);
    ctx.fillRect(254, 0, 12, 560);
    return el;
  },
};
