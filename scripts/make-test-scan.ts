/**
 * Writes a synthetic room scan for trying the import flow without a phone: the procedural sample
 * living room (8 × 6 m, 2.7 m ceiling) as a 3DGS `.ply` or `.spz`, optionally stored the way
 * other tools do (upside down like 3DGS trainers, in other units, turned).
 *
 *   pnpm make-test-scan [out.ply|out.spz] [--flip] [--scale 0.4] [--turn 25] [--no-ceiling]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { qmul } from "../apps/api/src/capture/analyze";
import { writePly, writeSpz } from "../apps/api/src/capture/splatFile";
import { quatAxisAngle, syntheticRoomSplats } from "../apps/api/test/syntheticRoom";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : undefined;
};
const out = resolve(
  args.find((a) => /\.(ply|spz)$/i.test(a)) ?? "apps/api/.data/test-scans/sample-room.ply",
);
const turn = quatAxisAngle([0, 1, 0], ((option("turn") ?? 0) * Math.PI) / 180);
const splats = syntheticRoomSplats({
  spacing: option("spacing") ?? 0.03,
  ceiling: !flag("no-ceiling"),
  floaters: 3000,
  frame: {
    rotation: flag("flip") ? qmul(turn, [1, 0, 0, 0]) : turn,
    scale: option("scale") ?? 1,
  },
});
mkdirSync(dirname(out), { recursive: true });
const bytes = out.toLowerCase().endsWith(".spz") ? writeSpz(splats) : writePly(splats);
writeFileSync(out, bytes);
console.log(
  `${out}: ${splats.length.toLocaleString("en-US")} splats, ${(bytes.length / 1e6).toFixed(1)} MB`,
);
