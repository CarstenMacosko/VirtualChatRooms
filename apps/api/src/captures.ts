import { and, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import {
  BuiltInRoomId,
  type RoomInfo,
  type RoomSummary,
  ScanDetails,
  type ScanFormat,
  type UpAxis,
} from "@vcr/protocol";
import { processScan, ScanRejectedError } from "./capture/pipeline";
import { ByoSplatProvider, type CaptureProvider, KiriProvider } from "./capture/providers";
import type { Database } from "./db/client";
import { captureJobs, rooms } from "./db/schema";
import type { LiveHub } from "./live";
import type { ObjectStorage } from "./storage";

export interface JobOptions {
  format: ScanFormat;
  up?: UpAxis;
  heightMeters?: number;
}

type RoomRow = typeof rooms.$inferSelect;

/** What people joining a gathering need to know about its room. */
export function roomSummary(row: RoomRow): RoomSummary {
  const builtIn = BuiltInRoomId.safeParse(row.builtIn);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    // A sample room from before there were several built-in rooms is the first one.
    builtIn: builtIn.success ? builtIn.data : row.kind === "sample" ? "oval-office" : null,
  };
}

export function roomInfo(row: RoomRow): RoomInfo {
  const scan = ScanDetails.safeParse(row.scan);
  return {
    ...roomSummary(row),
    status: row.status,
    progress: row.progress,
    error: row.error,
    scan: scan.success ? scan.data : null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * The capture pipeline's job queue (PLAN.md § 4.1). In-process and one job at a time for now:
 * post-processing is CPU-bound, and a separate worker (`services/capture`) can take over the
 * same jobs table later. Jobs interrupted by a restart run again on startup.
 */
export class Captures {
  readonly byo = new ByoSplatProvider();
  readonly kiri: CaptureProvider;
  private queue: string[] = [];
  private running: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly db: Database,
    private readonly storage: ObjectStorage,
    private readonly live: LiveHub,
    private readonly log: FastifyBaseLogger,
    kiriApiKey: string,
  ) {
    this.kiri = new KiriProvider(kiriApiKey);
  }

  /** Re-queues jobs a restart interrupted. */
  async resume() {
    const pending = await this.db
      .select({ id: captureJobs.id })
      .from(captureJobs)
      .where(inArray(captureJobs.status, ["queued", "postprocessing"]));
    for (const job of pending) this.enqueue(job.id);
  }

  enqueue(jobId: string) {
    if (this.disposed) return;
    this.queue.push(jobId);
    this.running ??= this.drain().finally(() => {
      this.running = null;
    });
  }

  /** Resolves once every queued job has finished (for tests and shutdown). */
  async idle() {
    while (this.running) await this.running;
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
  }

  private async drain() {
    for (let id = this.queue.shift(); id; id = this.queue.shift()) {
      if (this.disposed) return;
      await this.run(id).catch((err: unknown) =>
        this.log.error({ err, jobId: id }, "capture job crashed"),
      );
    }
  }

  private async notifyOwner(roomId: string) {
    const [room] = await this.db
      .select({ ownerId: rooms.ownerId })
      .from(rooms)
      .where(eq(rooms.id, roomId));
    if (room) this.live.send(room.ownerId, { type: "rooms-changed" });
  }

  private async run(jobId: string) {
    const [job] = await this.db.select().from(captureJobs).where(eq(captureJobs.id, jobId));
    if (!job || (job.status !== "queued" && job.status !== "postprocessing")) return;
    const options = (job.options ?? {}) as JobOptions;
    await this.db
      .update(captureJobs)
      .set({ status: "postprocessing", progress: 0, startedAt: new Date() })
      .where(eq(captureJobs.id, jobId));
    await this.db
      .update(rooms)
      .set({ status: "processing", progress: 0, error: null })
      .where(eq(rooms.id, job.roomId));
    await this.notifyOwner(job.roomId);

    // Progress goes to the database a few times per job, not on every tick.
    let reported = 0;
    const onProgress = (p: number) => {
      if (p - reported < 0.2 && p < 1) return;
      reported = p;
      void this.db
        .update(rooms)
        .set({ progress: p })
        .where(eq(rooms.id, job.roomId))
        .then(
          () => this.notifyOwner(job.roomId),
          () => {},
        );
    };

    try {
      const result = await processScan(this.storage, job.roomId, options.format, {
        ...(options.up && { up: options.up }),
        ...(options.heightMeters && { heightMeters: options.heightMeters }),
        onProgress,
      });
      // The room may have been deleted while this ran; then there's nothing to update.
      const [updated] = await this.db
        .update(rooms)
        .set({
          status: "ready",
          progress: null,
          error: null,
          manifestKey: result.manifestKey,
          scan: result.details,
        })
        .where(eq(rooms.id, job.roomId))
        .returning({ id: rooms.id });
      if (!updated) {
        await this.storage.deletePrefix(`rooms/${job.roomId}/`);
        return;
      }
      await this.finish(jobId, "ready", null);
    } catch (err) {
      const message =
        err instanceof ScanRejectedError
          ? err.message
          : "Something went wrong while processing this scan. Try uploading it again.";
      if (!(err instanceof ScanRejectedError)) this.log.error({ err, jobId }, "capture job failed");
      await this.db
        .update(rooms)
        .set({ status: "failed", progress: null, error: message })
        .where(and(eq(rooms.id, job.roomId)));
      await this.finish(jobId, "failed", message);
    }
    await this.notifyOwner(job.roomId);
  }

  private async finish(jobId: string, status: "ready" | "failed", error: string | null) {
    await this.db
      .update(captureJobs)
      .set({ status, error, progress: status === "ready" ? 1 : null, finishedAt: new Date() })
      .where(eq(captureJobs.id, jobId));
  }
}
