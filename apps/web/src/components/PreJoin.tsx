import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DeviceChoice } from "../media/MediaSession";
import { SpatialAudio } from "../media/SpatialAudio";
import { Avatar } from "./ui";

export interface JoinChoice {
  mic: boolean;
  camera: boolean;
  devices?: DeviceChoice;
  /** Speaker (audio output) device, where the browser lets you choose. */
  speaker?: string;
}

const DEVICE_KEY = "vcr.devices";

export function rememberedDevices(): DeviceChoice & { speaker?: string } {
  try {
    return JSON.parse(localStorage.getItem(DEVICE_KEY) ?? "{}") as DeviceChoice;
  } catch {
    return {};
  }
}

function remember(choice: DeviceChoice & { speaker?: string }) {
  try {
    localStorage.setItem(DEVICE_KEY, JSON.stringify(choice));
  } catch {
    // fine
  }
}

/** Cameras, microphones and speakers the browser will name (after permission is granted). */
export function useDevices(ready: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const load = () =>
      void navigator.mediaDevices
        .enumerateDevices()
        .then((list) => setDevices(list.filter((d) => d.deviceId)))
        .catch(() => {});
    load();
    navigator.mediaDevices.addEventListener("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener("devicechange", load);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- devices get names once `ready` (permission granted)
  }, [ready]);
  return {
    mics: devices.filter((d) => d.kind === "audioinput"),
    cameras: devices.filter((d) => d.kind === "videoinput"),
    speakers: devices.filter((d) => d.kind === "audiooutput"),
  };
}

export function DeviceSelect(props: {
  label: string;
  devices: MediaDeviceInfo[];
  value: string | undefined;
  onChange(id: string): void;
}) {
  if (props.devices.length < 2) return null;
  return (
    <label className="device-select">
      {props.label}
      <select
        value={props.value ?? props.devices[0]?.deviceId}
        onChange={(e) => props.onChange(e.target.value)}
      >
        {props.devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${props.label} ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * "Ready to join?": see yourself, check your mic, pick devices. The Join click is also the
 * user gesture browsers require before audio can play.
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
  const [chosen, setChosen] = useState(rememberedDevices);
  const [error, setError] = useState<string | null>(null);
  const [granted, setGranted] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const meter = useRef<HTMLDivElement>(null);
  const { mics, cameras, speakers } = useDevices(granted);
  // Browsers only allow cameras on https pages (and localhost).
  const unsupported = !navigator.mediaDevices?.getUserMedia;

  useEffect(() => {
    if ((!mic && !camera) || unsupported) return;
    const meterEl = meter.current;
    let stream: MediaStream | null = null;
    let raf = 0;
    let context: AudioContext | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({
        audio: mic && (chosen.mic ? { deviceId: { ideal: chosen.mic } } : true),
        video:
          camera &&
          (chosen.camera
            ? { deviceId: { ideal: chosen.camera }, width: 1280, height: 720 }
            : { facingMode: "user", width: 1280, height: 720 }),
      })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        setError(null);
        setGranted(true);
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
            if (meterEl) meterEl.style.transform = `scaleX(${Math.min(1, peak / 48)})`;
            raf = requestAnimationFrame(tick);
          };
          tick();
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof DOMException && err.name === "NotAllowedError"
            ? "Your browser blocked the camera or microphone. Allow them in the address bar (or your phone's settings), or join without them."
            : err instanceof DOMException && err.name === "NotFoundError"
              ? "No camera or microphone found. You can still join and listen."
              : "Couldn't open your camera or microphone. Another app may be using it.",
        );
      });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      void context?.close();
      stream?.getTracks().forEach((t) => t.stop());
      if (meterEl) meterEl.style.transform = "scaleX(0)";
    };
  }, [mic, camera, chosen.mic, chosen.camera, unsupported]);

  const pick = (patch: Partial<typeof chosen>) => {
    const next = { ...chosen, ...patch };
    setChosen(next);
    remember(next);
  };

  return (
    <main className="prejoin">
      <div className="prejoin-preview">
        <div className="preview">
          {camera ? (
            <video ref={video} autoPlay playsInline muted className="mirror" />
          ) : (
            <div className="preview-off">
              <Avatar name={props.name} id={props.name} size={96} />
              <span>Camera is off</span>
            </div>
          )}
          <span className="preview-name">{props.name}</span>
          <div className="preview-controls">
            <button
              className={`round${mic ? "" : " off"}`}
              onClick={() => setMic(!mic)}
              aria-label={mic ? "Turn off microphone" : "Turn on microphone"}
              aria-pressed={!mic}
            >
              {mic ? <Mic size={22} /> : <MicOff size={22} />}
            </button>
            <button
              className={`round${camera ? "" : " off"}`}
              onClick={() => setCamera(!camera)}
              aria-label={camera ? "Turn off camera" : "Turn on camera"}
              aria-pressed={!camera}
            >
              {camera ? <Video size={22} /> : <VideoOff size={22} />}
            </button>
          </div>
          {mic && (
            <div className="mic-meter" aria-label="Microphone level">
              <div ref={meter} />
            </div>
          )}
        </div>
        <div className="devices">
          <DeviceSelect
            label="Microphone"
            devices={mics}
            value={chosen.mic}
            onChange={(id) => pick({ mic: id })}
          />
          <DeviceSelect
            label="Camera"
            devices={cameras}
            value={chosen.camera}
            onChange={(id) => pick({ camera: id })}
          />
          {SpatialAudio.canChooseOutput && (
            <DeviceSelect
              label="Speaker"
              devices={speakers}
              value={chosen.speaker}
              onChange={(id) => pick({ speaker: id })}
            />
          )}
        </div>
      </div>
      <div className="prejoin-side">
        <h1>Ready to join?</h1>
        <p className="muted">
          {props.title}
          {props.subtitle ? ` · ${props.subtitle}` : ""}
        </p>
        {unsupported && (
          <p className="callout warn">
            This browser can't use a camera or microphone here. Open the page over https (a shared
            link) or on this computer.
          </p>
        )}
        {error && <p className="callout warn">{error}</p>}
        <button
          className="primary big"
          onClick={() =>
            props.onJoin({
              mic,
              camera,
              devices: { mic: chosen.mic, camera: chosen.camera },
              ...(chosen.speaker && { speaker: chosen.speaker }),
            })
          }
        >
          Join now
        </button>
        <button className="ghost" onClick={props.onCancel}>
          Cancel
        </button>
        <p className="hint">
          Headphones avoid echo, and in the room view voices sound like they're around you.
        </p>
      </div>
    </main>
  );
}
