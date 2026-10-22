import { type DeviceProfile, detectDeviceProfile, type DeviceTier } from "@vcr/engine";

function gpuRenderer(): string | undefined {
  try {
    const gl = document.createElement("canvas").getContext("webgl2");
    const info = gl?.getExtension("WEBGL_debug_renderer_info");
    const name = info ? gl?.getParameter(info.UNMASKED_RENDERER_WEBGL) : undefined;
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}

/** Reads device signals once at startup. `?quality=low|high` overrides the guess. */
export function readDeviceProfile(): DeviceProfile {
  const q = new URLSearchParams(window.location.search).get("quality");
  return detectDeviceProfile({
    userAgent: navigator.userAgent,
    coarsePointer: window.matchMedia("(pointer: coarse)").matches,
    hardwareConcurrency: navigator.hardwareConcurrency ?? 4,
    devicePixelRatio: window.devicePixelRatio,
    gpuRenderer: gpuRenderer(),
    override: q === "low" || q === "high" ? (q as DeviceTier) : undefined,
  });
}
