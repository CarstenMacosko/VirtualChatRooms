/**
 * Where a room's splat comes from (PLAN.md § 4.1, ADR 0010). Imports of existing scans need no
 * reconstruction; recorded videos go to a capture provider (KIRI Engine) that returns a splat
 * and a mesh. Both feed the same post-processing.
 */
export interface CaptureJobInput {
  sourceKey: string;
  kind: "video" | "splat_upload";
}

export type ProviderStatus =
  { state: "running"; progress?: number } | { state: "done" } | { state: "failed"; error: string };

export interface CaptureProvider {
  readonly name: "byo" | "kiri";
  /** Whether this provider can take jobs on this server, and if not, why (for the UI). */
  availability(): { available: boolean; reason: string | null };
  submit(job: CaptureJobInput): Promise<{ providerTaskId: string }>;
  status(providerTaskId: string): Promise<ProviderStatus>;
  /** The reconstructed splat (PLY) and, when the provider makes one, a GLB mesh. */
  fetchResult(providerTaskId: string): Promise<{ splatPly: Buffer; mesh?: Buffer }>;
}

export class ProviderUnavailableError extends Error {
  override name = "ProviderUnavailableError";
}

/**
 * "Bring your own splat": the upload already is the result, so there's nothing to submit. The
 * pipeline reads the uploaded file straight from storage.
 */
export class ByoSplatProvider implements CaptureProvider {
  readonly name = "byo";
  availability() {
    return { available: true, reason: null };
  }
  async submit(job: CaptureJobInput) {
    return { providerTaskId: job.sourceKey };
  }
  async status(): Promise<ProviderStatus> {
    return { state: "done" };
  }
  async fetchResult(): Promise<never> {
    throw new Error("uploaded splats are read from storage directly");
  }
}

export const KIRI_NEEDS_KEY =
  "Turning a video into a room needs a KIRI Engine API key (KIRI_API_KEY) on the server. You can still import a scan from Scaniverse, Polycam or the KIRI app.";

/**
 * KIRI Engine's 3DGS-from-video API. Only a stub in this slice: without `KIRI_API_KEY` it says
 * so and never calls out. With a key it still declines until the provider bake-off (Phase 4,
 * week 7) confirms KIRI and its request format is verified against the real API.
 */
export class KiriProvider implements CaptureProvider {
  readonly name = "kiri";
  constructor(private readonly apiKey: string) {}

  availability() {
    if (!this.apiKey) return { available: false, reason: KIRI_NEEDS_KEY };
    return {
      available: false,
      reason: "Video capture with KIRI Engine isn't switched on yet. Import a scan instead.",
    };
  }

  private unavailable(): never {
    throw new ProviderUnavailableError(this.availability().reason ?? KIRI_NEEDS_KEY);
  }

  async submit(): Promise<{ providerTaskId: string }> {
    this.unavailable();
  }
  async status(): Promise<ProviderStatus> {
    this.unavailable();
  }
  async fetchResult(): Promise<{ splatPly: Buffer; mesh?: Buffer }> {
    this.unavailable();
  }
}
