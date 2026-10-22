import { useEffect, useRef, useState } from "react";
import { colorsFromPhoto, faceFromLandmarks, type SelfieColors } from "@vcr/avatar";
import type { AvatarRecipe } from "@vcr/protocol";
import { loadFaceLandmarker } from "../media/FaceTracker";

/**
 * Takes a selfie and reads face proportions and colors from it, all on this device: the photo is
 * never uploaded or stored (PLAN.md § 4.2).
 */
export function SelfieAssist(props: {
  onResult(face: AvatarRecipe["face"], colors: SelfieColors): void;
  onClose(): void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"starting" | "ready" | "reading" | "error">("starting");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    // Start loading the face model while the camera warms up.
    void loadFaceLandmarker("IMAGE").catch(() => {});
    navigator.mediaDevices
      .getUserMedia({ video: { width: 960, height: 720, facingMode: "user" } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) video.current.srcObject = s;
        setState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setState("error");
        setMessage("Your camera is blocked. Allow it in your browser, or set things up by hand.");
      });
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function capture() {
    const v = video.current;
    if (!v || v.videoWidth === 0) return;
    setState("reading");
    setMessage(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(v, 0, 0);
      const landmarker = await loadFaceLandmarker("IMAGE");
      const landmarks = landmarker.detect(canvas).faceLandmarks[0];
      if (!landmarks) {
        setState("ready");
        setMessage("Couldn't find a face. Face the camera in good light and try again.");
        return;
      }
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      props.onResult(
        faceFromLandmarks(landmarks, canvas.width / canvas.height),
        colorsFromPhoto(landmarks, pixels),
      );
    } catch {
      setState("ready");
      setMessage("Something went wrong reading the photo. Try again?");
    }
  }

  return (
    <div className="selfie">
      <div className="selfie-frame">
        <video ref={video} autoPlay playsInline muted />
        <div className="selfie-oval" aria-hidden />
        {state === "starting" && <p className="selfie-status">Starting camera…</p>}
        {state === "reading" && <p className="selfie-status">Reading your face…</p>}
      </div>
      <p className="hint">
        Line your face up with the oval, in even light. The photo stays on this device and isn't
        saved.
      </p>
      {message && <p className="error">{message}</p>}
      <div className="row end">
        <button className="link" onClick={props.onClose}>
          Cancel
        </button>
        <button onClick={() => void capture()} disabled={state !== "ready"}>
          Take photo
        </button>
      </div>
    </div>
  );
}
