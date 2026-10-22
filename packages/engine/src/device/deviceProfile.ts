export type DeviceTier = "high" | "low";

export interface DeviceProfile {
  tier: DeviceTier;
  /** Cap on renderer pixel ratio. */
  maxDpr: number;
  /** Meters between generated splats in procedural rooms (lower = denser). */
  splatSpacing: number;
  /** Which splat LOD to load for scanned rooms. */
  useMobileLod: boolean;
  /** Avatars beyond this many get simplified animation (PLAN.md § 7 budgets). */
  maxAnimatedAvatars: number;
  /** Show on-screen joystick and look pad. */
  touch: boolean;
}

export interface DeviceSignals {
  userAgent: string;
  coarsePointer: boolean;
  hardwareConcurrency: number;
  devicePixelRatio: number;
  /** UNMASKED_RENDERER_WEBGL when available. */
  gpuRenderer?: string | undefined;
  /** `?quality=high|low` override. */
  override?: DeviceTier | undefined;
}

const MOBILE_UA = /Android|iPhone|iPad|iPod|Mobile|Quest/i;
const WEAK_GPU =
  /Mali|Adreno \(TM\) [1-5]\d\d|PowerVR|Intel\(R\) (HD|UHD) Graphics [2-6]\d\d|SwiftShader|llvmpipe/i;

/** Picks quality settings from cheap startup signals (PLAN.md § 3.5). */
export function detectDeviceProfile(s: DeviceSignals): DeviceProfile {
  const mobile = MOBILE_UA.test(s.userAgent);
  const weak =
    mobile ||
    s.hardwareConcurrency <= 4 ||
    (s.gpuRenderer !== undefined && WEAK_GPU.test(s.gpuRenderer));
  const tier: DeviceTier = s.override ?? (weak ? "low" : "high");
  const touch = s.coarsePointer || mobile;

  return tier === "high"
    ? {
        tier,
        maxDpr: Math.min(s.devicePixelRatio, 2),
        splatSpacing: 0.035,
        useMobileLod: false,
        maxAnimatedAvatars: 25,
        touch,
      }
    : {
        tier,
        maxDpr: Math.min(s.devicePixelRatio, 1.5),
        splatSpacing: 0.06,
        useMobileLod: true,
        maxAnimatedAvatars: 12,
        touch,
      };
}
