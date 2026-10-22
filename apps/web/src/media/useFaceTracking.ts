import { useEffect, useRef, useState } from "react";
import { FaceTracker, loadFaceLandmarker, type TrackedFace } from "./FaceTracker";

export type FaceTrackingStatus = "off" | "starting" | "on" | "error";

/**
 * Mirrors your face onto your avatar while `enabled`. Uses your published camera track when there
 * is one (one camera feeds both the sidebar and the avatar, PLAN.md § 4.6); otherwise opens the
 * webcam just for tracking, without publishing any video.
 */
export function useFaceTracking(enabled: boolean, cameraTrack: MediaStreamTrack | null) {
  const faceRef = useRef<TrackedFace | null>(null);
  const [status, setStatus] = useState<FaceTrackingStatus>("off");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let tracker: FaceTracker | null = null;
    let ownStream: MediaStream | null = null;
    const copy = setInterval(() => {
      faceRef.current = tracker?.latest ?? null;
    }, 33);

    (async () => {
      const landmarker = await loadFaceLandmarker("VIDEO");
      let track = cameraTrack;
      if (!track) {
        ownStream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480 },
        });
        track = ownStream.getVideoTracks()[0]!;
      }
      if (cancelled) return;
      tracker = new FaceTracker(landmarker);
      tracker.start(track);
      setStatus("on");
      setError(null);
    })().catch((err: unknown) => {
      if (cancelled) return;
      setStatus("error");
      setError(
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Face tracking needs your camera. Allow it in your browser to use it."
          : "Couldn't start face tracking.",
      );
    });

    return () => {
      cancelled = true;
      clearInterval(copy);
      tracker?.stop();
      ownStream?.getTracks().forEach((t) => t.stop());
      faceRef.current = null;
      setStatus("off");
    };
  }, [enabled, cameraTrack]);

  // Until the async start settles, an enabled tracker is "starting".
  return { faceRef, status: enabled && status === "off" ? "starting" : status, error };
}
