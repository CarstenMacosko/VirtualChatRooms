import { useEffect, useRef, useState } from "react";

export interface JoinChoice {
  mic: boolean;
  camera: boolean;
}

/**
 * Check your camera and mic before you appear in the room. The Join click is also the user
 * gesture browsers require before audio can play.
 */
export function PreJoin(props: {
  title: string;
  subtitle?: string;
  name: string;
  onJoin(choice: JoinChoice): void;
  onCancel(): void;
}) {
  const [mic, setMic] = useState(true);
  const [camera, setCamera] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const meter = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mic && !camera) return;
    const meterEl = meter.current;
    let stream: MediaStream | null = null;
    let raf = 0;
    let context: AudioContext | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ audio: mic, video: camera && { width: 640, height: 360 } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        setError(null);
        if (video.current) video.current.srcObject = camera ? s : null;
        if (mic) {
          context = new AudioContext();
          const analyser = context.createAnalyser();
          analyser.fftSize = 512;
          context.createMediaStreamSource(s).connect(analyser);
          const data = new Uint8Array(analyser.fftSize);
          const tick = () => {
            analyser.getByteTimeDomainData(data);
            let peak = 0;
            for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
            if (meterEl) meterEl.style.width = `${Math.min(100, (peak / 64) * 100)}%`;
            raf = requestAnimationFrame(tick);
          };
          tick();
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Your browser blocked the camera or microphone. You can still join and turn them on later."
            : "Couldn't open your camera or microphone.",
        );
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      void context?.close();
      stream?.getTracks().forEach((t) => t.stop());
      if (meterEl) meterEl.style.width = "0%";
    };
  }, [mic, camera]);

  return (
    <main className="prejoin">
      <div className="card wide">
        <div>
          <h1>{props.title}</h1>
          {props.subtitle && <p className="muted">{props.subtitle}</p>}
        </div>
        <div className="preview">
          {camera ? (
            <video ref={video} autoPlay playsInline muted />
          ) : (
            <div className="preview-off">Camera off</div>
          )}
          <span className="preview-name">{props.name}</span>
        </div>
        <div className="mic-meter" aria-label="Microphone level">
          <div ref={meter} />
        </div>
        <div className="row">
          <button className={mic ? "toggle on" : "toggle"} onClick={() => setMic(!mic)}>
            {mic ? "🎙️ Mic on" : "🔇 Mic off"}
          </button>
          <button className={camera ? "toggle on" : "toggle"} onClick={() => setCamera(!camera)}>
            {camera ? "📷 Camera on" : "🚫 Camera off"}
          </button>
        </div>
        <p className="hint">
          🎧 Headphones make voices sound like they're around you and avoid echo.
        </p>
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button className="link" onClick={props.onCancel}>
            Cancel
          </button>
          <button onClick={() => props.onJoin({ mic, camera })}>Join</button>
        </div>
      </div>
    </main>
  );
}
