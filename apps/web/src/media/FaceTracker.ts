import type { FaceLandmarker, FaceLandmarkerResult } from "@mediapipe/tasks-vision";
import { Matrix4, Quaternion } from "three";
import { ARKIT_BLENDSHAPES, ARKIT_INDEX, type ArkitBlendshape, type Quat } from "@vcr/protocol";

/**
 * On-device face tracking with MediaPipe Face Landmarker (PLAN.md § 4.2). Video frames never
 * leave the browser; only 52 blendshape weights and a head rotation go out in the pose stream.
 *
 * The WASM runtime and the model are downloaded from Google's CDNs on first use (about 4 MB,
 * cached by the browser). Nothing is uploaded.
 */

const MEDIAPIPE_VERSION = "1.1.0"; // keep in step with package.json
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

export interface TrackedFace {
  /** ARKit order, 0–255 (the `AvatarPose.face` wire format). */
  blendshapes: Uint8Array;
  /** Head rotation relative to looking straight at the camera. */
  head: Quat;
}

const landmarkers = new Map<"IMAGE" | "VIDEO", Promise<FaceLandmarker>>();

/** Loads (once per mode) the MediaPipe runtime and face model. */
export function loadFaceLandmarker(mode: "IMAGE" | "VIDEO"): Promise<FaceLandmarker> {
  let loading = landmarkers.get(mode);
  if (!loading) {
    loading = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const fileset = await FilesetResolver.forVisionTasks(WASM_URL);
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: mode,
        numFaces: 1,
        outputFaceBlendshapes: mode === "VIDEO",
        outputFacialTransformationMatrixes: mode === "VIDEO",
      });
    })();
    loading.catch(() => landmarkers.delete(mode)); // let a later attempt retry
    landmarkers.set(mode, loading);
  }
  return loading;
}

const matrix = new Matrix4();
const rotation = new Quaternion();

/** Converts one Face Landmarker result into our wire format, or null if no face was found. */
export function toTrackedFace(result: FaceLandmarkerResult): TrackedFace | null {
  const categories = result.faceBlendshapes[0]?.categories;
  const transform = result.facialTransformationMatrixes[0];
  if (!categories || !transform) return null;
  const blendshapes = new Uint8Array(ARKIT_BLENDSHAPES.length);
  for (const c of categories) {
    const index = ARKIT_INDEX[c.categoryName as ArkitBlendshape];
    if (index !== undefined) blendshapes[index] = Math.round(Math.min(1, c.score) * 255);
  }
  matrix.fromArray(transform.data);
  rotation.setFromRotationMatrix(matrix);
  return { blendshapes, head: [rotation.x, rotation.y, rotation.z, rotation.w] };
}

/**
 * Runs face tracking on a camera track about 20 times a second and keeps the latest result.
 * `latest` goes back to null if the face is lost for half a second.
 */
export class FaceTracker {
  latest: TrackedFace | null = null;
  private video = document.createElement("video");
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastSeen = 0;
  private stopped = false;

  constructor(private landmarker: FaceLandmarker) {
    this.video.muted = true;
    this.video.playsInline = true;
  }

  start(track: MediaStreamTrack) {
    this.video.srcObject = new MediaStream([track]);
    void this.video.play().catch(() => {});
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 50);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.video.srcObject = null;
    this.latest = null;
  }

  private tick() {
    if (this.stopped || this.video.readyState < 2) return;
    const now = performance.now();
    try {
      const face = toTrackedFace(this.landmarker.detectForVideo(this.video, now));
      if (face) {
        this.latest = face;
        this.lastSeen = now;
      } else if (now - this.lastSeen > 500) {
        this.latest = null;
      }
    } catch {
      // A frame MediaPipe couldn't read (e.g. while the camera restarts); try the next one.
    }
  }
}
