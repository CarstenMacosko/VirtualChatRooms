import { hashString, type JigsawPicture, seededRandom } from "@vcr/games";

/**
 * Jigsaw pictures, painted procedurally on a canvas: nothing to download, nothing copyrighted,
 * and the same picture on every client for the same id (ADR 0021). Drawing uses fractions of
 * the canvas, so a thumbnail is the same picture as the full-size texture.
 *
 * A host-uploaded photo would come in here too: a "photo:<key>" id resolved to a signed URL and
 * drawn (cropped to the puzzle's shape) instead of painted.
 */

export const PICTURE_NAMES: Record<JigsawPicture, string> = {
  sunset: "Sunset lake",
  fields: "Color fields",
  mosaic: "Mosaic",
  starry: "Starry night",
};

type Ctx = CanvasRenderingContext2D;

export function drawPicture(ctx: Ctx, picture: JigsawPicture, w: number, h: number) {
  const random = seededRandom(hashString(picture));
  ctx.save();
  PAINTERS[picture](ctx, w, h, random);
  ctx.restore();
}

/** A canvas holding the picture at `width` pixels wide, `aspect` = width / height. */
export function pictureCanvas(picture: JigsawPicture, width: number, aspect: number) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width);
  canvas.height = Math.round(width / aspect);
  const ctx = canvas.getContext("2d");
  if (ctx) drawPicture(ctx, picture, canvas.width, canvas.height);
  return canvas;
}

const PAINTERS: Record<JigsawPicture, (ctx: Ctx, w: number, h: number, r: () => number) => void> = {
  sunset: paintSunset,
  fields: paintFields,
  mosaic: paintMosaic,
  starry: paintStarry,
};

const between = (r: () => number, a: number, b: number) => a + (b - a) * r();

/** A ridge line across the picture: a few sines with random phases. */
function ridge(r: () => number, base: number, amplitude: number, w: number) {
  const waves = Array.from({ length: 4 }, (_, i) => ({
    freq: (i + 1) * between(r, 0.8, 1.6),
    phase: r() * Math.PI * 2,
    amp: amplitude / (i + 1),
  }));
  return (x: number) =>
    base -
    waves.reduce((sum, wave) => sum + Math.sin((x / w) * wave.freq * 6 + wave.phase) * wave.amp, 0);
}

function paintSunset(ctx: Ctx, w: number, h: number, r: () => number) {
  const horizon = h * 0.62;
  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#2b1a4f");
  sky.addColorStop(0.45, "#a8436b");
  sky.addColorStop(0.8, "#f2855a");
  sky.addColorStop(1, "#ffd68a");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, horizon);

  // Sun with a soft glow, low over the hills.
  const sunX = w * between(r, 0.35, 0.65);
  const sunY = horizon - h * 0.12;
  const glow = ctx.createRadialGradient(sunX, sunY, 0, sunX, sunY, h * 0.45);
  glow.addColorStop(0, "rgb(255 236 170 / 0.9)");
  glow.addColorStop(1, "rgb(255 180 120 / 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, horizon);
  ctx.fillStyle = "#fff1c4";
  ctx.beginPath();
  ctx.arc(sunX, sunY, h * 0.08, 0, Math.PI * 2);
  ctx.fill();

  // Long thin clouds.
  for (let i = 0; i < 9; i++) {
    const y = between(r, 0.08, 0.45) * h;
    const x = r() * w;
    ctx.fillStyle = `rgb(${between(r, 200, 255)} ${between(r, 120, 170)} ${between(r, 150, 190)} / ${between(r, 0.25, 0.55)})`;
    ctx.beginPath();
    ctx.ellipse(x, y, between(r, 0.08, 0.22) * w, between(r, 0.006, 0.018) * h, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Hills, far to near, each darker.
  const hills = ["#8d4a78", "#5f3366", "#3b2350", "#22173a"];
  hills.forEach((color, i) => {
    const line = ridge(r, horizon - h * (0.16 - i * 0.045), h * (0.05 + i * 0.012), w);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, horizon);
    for (let x = 0; x <= w; x += w / 120) ctx.lineTo(x, Math.min(horizon, line(x)));
    ctx.lineTo(w, horizon);
    ctx.closePath();
    ctx.fill();
  });

  // Lake: the sky flipped and darkened, with the sun's streaks.
  const lake = ctx.createLinearGradient(0, horizon, 0, h);
  lake.addColorStop(0, "#e6866a");
  lake.addColorStop(0.3, "#7a3b66");
  lake.addColorStop(1, "#1b1233");
  ctx.fillStyle = lake;
  ctx.fillRect(0, horizon, w, h - horizon);
  for (let i = 0; i < 40; i++) {
    const t = i / 40;
    const y = horizon + t * (h - horizon);
    const half = w * (0.08 - t * 0.05) * between(r, 0.5, 1.4);
    ctx.fillStyle = `rgb(255 225 160 / ${0.55 * (1 - t)})`;
    ctx.fillRect(sunX - half + between(r, -1, 1) * w * 0.02, y, half * 2, h * 0.004);
  }

  // Reeds along the near shore.
  ctx.strokeStyle = "#140d24";
  ctx.lineWidth = Math.max(1, w * 0.0025);
  for (let i = 0; i < 70; i++) {
    const x = (r() < 0.5 ? r() * 0.25 : 0.75 + r() * 0.25) * w;
    const tall = between(r, 0.06, 0.2) * h;
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.quadraticCurveTo(
      x + between(r, -0.02, 0.02) * w,
      h - tall / 2,
      x + between(r, -0.03, 0.03) * w,
      h - tall,
    );
    ctx.stroke();
  }
}

function paintFields(ctx: Ctx, w: number, h: number, r: () => number) {
  const palette = [
    "#f4d35e",
    "#ee964b",
    "#f95738",
    "#0d3b66",
    "#3fa7d6",
    "#59cd90",
    "#faf0ca",
    "#a23b72",
  ];
  ctx.fillStyle = "#f6efe2";
  ctx.fillRect(0, 0, w, h);
  const pick = () => palette[Math.floor(r() * palette.length)]!;

  // Big soft-edged color blocks.
  for (let i = 0; i < 7; i++) {
    ctx.save();
    ctx.translate(r() * w, r() * h);
    ctx.rotate(between(r, -0.5, 0.5));
    ctx.globalAlpha = between(r, 0.55, 0.85);
    ctx.fillStyle = pick();
    const bw = between(r, 0.2, 0.5) * w;
    const bh = between(r, 0.15, 0.4) * h;
    ctx.fillRect(-bw / 2, -bh / 2, bw, bh);
    ctx.restore();
  }
  // Circles and rings.
  for (let i = 0; i < 14; i++) {
    const x = r() * w;
    const y = r() * h;
    const radius = between(r, 0.02, 0.14) * h;
    ctx.globalAlpha = between(r, 0.7, 1);
    if (r() < 0.5) {
      ctx.fillStyle = pick();
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = pick();
      ctx.lineWidth = radius * 0.3;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // Bold lines and a few dots, Kandinsky-style.
  ctx.globalAlpha = 1;
  ctx.lineCap = "round";
  for (let i = 0; i < 10; i++) {
    ctx.strokeStyle = r() < 0.4 ? "#1d1d2c" : pick();
    ctx.lineWidth = between(r, 0.003, 0.012) * w;
    ctx.beginPath();
    ctx.moveTo(r() * w, r() * h);
    ctx.lineTo(r() * w, r() * h);
    ctx.stroke();
  }
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = r() < 0.5 ? "#1d1d2c" : pick();
    ctx.beginPath();
    ctx.arc(r() * w, r() * h, between(r, 0.003, 0.01) * w, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintMosaic(ctx: Ctx, w: number, h: number, r: () => number) {
  const palette = ["#264653", "#2a9d8f", "#e9c46a", "#f4a261", "#e76f51", "#f1faee", "#8ab17d"];
  const tile = w / 16;
  const cols = Math.ceil(w / tile);
  const rows = Math.ceil(h / tile);
  const cx = w / 2;
  const cy = h / 2;
  // Truchet-style tiles whose colors ripple out from the center, so every area looks different.
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = i * tile;
      const y = j * tile;
      const ring = Math.floor(Math.hypot(x + tile / 2 - cx, y + tile / 2 - cy) / (tile * 1.4));
      const a = palette[(ring + (i % 2)) % palette.length]!;
      const b = palette[(ring + 3 + (j % 3)) % palette.length]!;
      ctx.fillStyle = a;
      ctx.fillRect(x, y, tile + 1, tile + 1);
      ctx.fillStyle = b;
      const turn = Math.floor(r() * 4);
      ctx.beginPath();
      if (r() < 0.55) {
        // Quarter circle in one corner.
        const corners = [
          [x, y],
          [x + tile, y],
          [x + tile, y + tile],
          [x, y + tile],
        ] as const;
        const [qx, qy] = corners[turn]!;
        ctx.moveTo(qx, qy);
        ctx.arc(qx, qy, tile, (turn * Math.PI) / 2, (turn * Math.PI) / 2 + Math.PI / 2);
        ctx.closePath();
        ctx.fill();
      } else {
        // Triangle: half the tile.
        const pts = [
          [x, y],
          [x + tile, y],
          [x + tile, y + tile],
          [x, y + tile],
        ];
        ctx.moveTo(pts[turn]![0]!, pts[turn]![1]!);
        ctx.lineTo(pts[(turn + 1) % 4]![0]!, pts[(turn + 1) % 4]![1]!);
        ctx.lineTo(pts[(turn + 2) % 4]![0]!, pts[(turn + 2) % 4]![1]!);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  // A medallion in the middle.
  for (let k = 6; k > 0; k--) {
    ctx.fillStyle = palette[k % palette.length]!;
    ctx.beginPath();
    const radius = (h * 0.32 * k) / 6;
    for (let p = 0; p < 16; p++) {
      const angle = (p / 16) * Math.PI * 2;
      const rr = radius * (p % 2 ? 0.82 : 1);
      ctx.lineTo(cx + Math.cos(angle) * rr, cy + Math.sin(angle) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }
  // Grout lines.
  ctx.strokeStyle = "rgb(20 30 40 / 0.35)";
  ctx.lineWidth = Math.max(1, w * 0.0015);
  for (let i = 0; i <= cols; i++) {
    ctx.beginPath();
    ctx.moveTo(i * tile, 0);
    ctx.lineTo(i * tile, h);
    ctx.stroke();
  }
  for (let j = 0; j <= rows; j++) {
    ctx.beginPath();
    ctx.moveTo(0, j * tile);
    ctx.lineTo(w, j * tile);
    ctx.stroke();
  }
}

function paintStarry(ctx: Ctx, w: number, h: number, r: () => number) {
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#050a24");
  sky.addColorStop(0.55, "#16306b");
  sky.addColorStop(0.8, "#2f5d8f");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Aurora ribbons.
  for (let band = 0; band < 3; band++) {
    const line = ridge(r, h * (0.25 + band * 0.08), h * 0.06, w);
    const color = band === 1 ? "120 255 190" : "90 200 255";
    for (let x = 0; x < w; x += w / 240) {
      const y = line(x);
      const grad = ctx.createLinearGradient(0, y - h * 0.12, 0, y);
      grad.addColorStop(0, `rgb(${color} / 0)`);
      grad.addColorStop(1, `rgb(${color} / 0.22)`);
      ctx.fillStyle = grad;
      ctx.fillRect(x, y - h * 0.12, w / 240 + 1, h * 0.12);
    }
  }

  // Stars, a few bright ones with a halo.
  for (let i = 0; i < 500; i++) {
    const x = r() * w;
    const y = r() * h * 0.75;
    const size = r() < 0.04 ? between(r, 0.002, 0.004) * w : between(r, 0.0005, 0.0015) * w;
    ctx.fillStyle = `rgb(255 ${between(r, 230, 255)} ${between(r, 200, 255)} / ${between(r, 0.5, 1)})`;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, Math.PI * 2);
    ctx.fill();
  }

  // Moon with craters.
  const mx = w * between(r, 0.65, 0.85);
  const my = h * 0.18;
  const mr = h * 0.08;
  const halo = ctx.createRadialGradient(mx, my, mr, mx, my, mr * 3);
  halo.addColorStop(0, "rgb(255 250 220 / 0.35)");
  halo.addColorStop(1, "rgb(255 250 220 / 0)");
  ctx.fillStyle = halo;
  ctx.fillRect(mx - mr * 3, my - mr * 3, mr * 6, mr * 6);
  ctx.fillStyle = "#f5f0d6";
  ctx.beginPath();
  ctx.arc(mx, my, mr, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = "rgb(200 190 160 / 0.5)";
    ctx.beginPath();
    const a = r() * Math.PI * 2;
    const d = r() * mr * 0.6;
    ctx.arc(mx + Math.cos(a) * d, my + Math.sin(a) * d, mr * between(r, 0.08, 0.2), 0, Math.PI * 2);
    ctx.fill();
  }

  // Rolling hills with a village.
  const far = ridge(r, h * 0.72, h * 0.04, w);
  ctx.fillStyle = "#13264a";
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += w / 120) ctx.lineTo(x, far(x));
  ctx.lineTo(w, h);
  ctx.fill();
  const near = ridge(r, h * 0.84, h * 0.05, w);
  ctx.fillStyle = "#0a1630";
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x <= w; x += w / 120) ctx.lineTo(x, near(x));
  ctx.lineTo(w, h);
  ctx.fill();

  for (let i = 0; i < 14; i++) {
    const x = between(r, 0.05, 0.95) * w;
    const base = far(x) + h * 0.01;
    const bw = between(r, 0.025, 0.05) * w;
    const bh = between(r, 0.03, 0.06) * h;
    ctx.fillStyle = "#1c2f57";
    ctx.fillRect(x - bw / 2, base - bh, bw, bh);
    ctx.beginPath();
    ctx.moveTo(x - bw * 0.6, base - bh);
    ctx.lineTo(x, base - bh - bh * 0.6);
    ctx.lineTo(x + bw * 0.6, base - bh);
    ctx.fill();
    ctx.fillStyle = "#ffd36b";
    ctx.fillRect(x - bw * 0.25, base - bh * 0.7, bw * 0.18, bh * 0.25);
    if (r() < 0.6) ctx.fillRect(x + bw * 0.08, base - bh * 0.7, bw * 0.18, bh * 0.25);
  }

  // Pine trees on the near hill.
  ctx.fillStyle = "#050d1f";
  for (let i = 0; i < 26; i++) {
    const x = r() * w;
    const base = near(x) + h * 0.02;
    const th = between(r, 0.06, 0.13) * h;
    const tw = th * 0.4;
    ctx.beginPath();
    ctx.moveTo(x, base - th);
    ctx.lineTo(x + tw / 2, base);
    ctx.lineTo(x - tw / 2, base);
    ctx.fill();
  }
}
