import { Mic, MicOff, Video, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DeviceChoice } from "../media/MediaSession";
import {
  type Access,
  type Device,
  detectPlatform,
  openDevices,
  permissionState,
  watchPermission,
} from "../media/access";
import { SpatialAudio } from "../media/SpatialAudio";
import { AccessHelp, DeviceTrouble } from "./DeviceAccess";
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

const inApp = detectPlatform().inApp !== null;

/** Devices we can still try: unknown or prompt ask again once in the call. */
const usable = (access: Access) =>
  access === "granted" || access === "prompt" || access === "unknown";

/**
 * "Ready to join?": see yourself, check your mic, pick devices. Unless the browser already allows
 * both, it first says what's coming and asks on a tap; a device that fails gets a "Fix it" row
 * with steps for this phone or browser. The Join click is also the user gesture browsers require
 * before audio can play.
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
  const [access, setAccess] = useState<Record<Device, Access>>({
    mic: "unknown",
    camera: "unknown",
  });
  const accessRef = useRef(access);
  useEffect(() => {
    accessRef.current = access;
  });
  // Null while checking what the browser already allows.
  const [asked, setAsked] = useState<boolean | null>(null);
  // Which device request has answered; until the current one does, the browser may be asking.
  const [settled, setSettled] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [help, setHelp] = useState<Device | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const meter = useRef<HTMLDivElement>(null);
  const { mics, cameras, speakers } = useDevices(
    access.mic === "granted" || access.camera === "granted",
  );
  // Browsers only allow cameras on https pages (and localhost), and some apps' built-in
  // browsers don't offer them at all.
  const unsupported = !navigator.mediaDevices?.getUserMedia;

  // What the browser already allows: ask right away unless it would show a prompt, and open the
  // devices again when someone allows them in the address bar.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([permissionState("mic"), permissionState("camera")]).then(([m, c]) => {
      if (cancelled) return;
      setAccess({ mic: m, camera: c });
      setAsked(m !== "prompt" && m !== "unknown" && c !== "prompt" && c !== "unknown");
    });
    const stops = (["mic", "camera"] as const).map((device) =>
      watchPermission(device, (next) => {
        const before = accessRef.current[device];
        setAccess((a) => ({ ...a, [device]: next === "prompt" ? a[device] : next }));
        if (next === "granted" && before !== "granted") setAttempt((n) => n + 1);
      }),
    );
    return () => {
      cancelled = true;
      for (const stop of stops) stop();
    };
  }, []);

  const request = `${mic}|${camera}|${chosen.mic}|${chosen.camera}|${attempt}`;
  const waiting = settled !== request;
  useEffect(() => {
    if (!asked || (!mic && !camera) || unsupported) return;
    const meterEl = meter.current;
    let stream: MediaStream | null = null;
    let raf = 0;
    let context: AudioContext | null = null;
    let cancelled = false;
    void openDevices({
      mic: mic && (chosen.mic ? { deviceId: { ideal: chosen.mic } } : true),
      camera:
        camera &&
        (chosen.camera
          ? { deviceId: { ideal: chosen.camera }, width: 1280, height: 720 }
          : { facingMode: "user", width: 1280, height: 720 }),
    }).then((opened) => {
      if (cancelled) return opened.stream?.getTracks().forEach((t) => t.stop());
      setSettled(request);
      setAccess((a) => ({
        mic: mic ? opened.mic : a.mic,
        camera: camera ? opened.camera : a.camera,
      }));
      stream = opened.stream;
      if (!stream) return;
      if (video.current) video.current.srcObject = stream.getVideoTracks().length ? stream : null;
      if (stream.getAudioTracks().length) {
        context = new AudioContext();
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
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
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      void context?.close();
      stream?.getTracks().forEach((t) => t.stop());
      if (meterEl) meterEl.style.transform = "scaleX(0)";
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `request` changes with each retry
  }, [asked, mic, camera, chosen.mic, chosen.camera, unsupported, request]);

  const pick = (patch: Partial<typeof chosen>) => {
    const next = { ...chosen, ...patch };
    setChosen(next);
    remember(next);
  };

  const trouble = {
    ...(mic && !usable(access.mic) && { mic: access.mic }),
    ...(camera && !usable(access.camera) && { camera: access.camera }),
  };
  const showVideo = camera && access.camera === "granted";
  const asking = asked === false && !unsupported;
  const toggle = (device: Device) => {
    const on = device === "mic" ? mic : camera;
    // A device that's on but not working: help, not a silent toggle.
    if (on && trouble[device]) return setHelp(device);
    (device === "mic" ? setMic : setCamera)(!on);
  };

  return (
    <main className="prejoin">
      <div className="prejoin-preview">
        <div className={`preview${asking ? " asking" : ""}`}>
          {asking ? (
            <div className="preview-ask">
              <div className="ask-icons" aria-hidden>
                <Mic size={28} />
                <Video size={28} />
              </div>
              <h2>Use your camera and microphone?</h2>
              <p>
                So everyone can see and hear you. Your browser will ask next: tap <b>Allow</b>.
              </p>
              <button className="primary big" onClick={() => setAsked(true)}>
                Allow camera and microphone
              </button>
            </div>
          ) : (
            <>
              <video
                ref={video}
                autoPlay
                playsInline
                muted
                className="mirror"
                hidden={!showVideo}
              />
              {!showVideo && (
                <div className="preview-off">
                  <Avatar name={props.name} id={props.name} size={96} />
                  <span>
                    {waiting && camera
                      ? "Tap Allow if your browser asks…"
                      : camera
                        ? "Camera isn't on"
                        : "Camera is off"}
                  </span>
                </div>
              )}
              <span className="preview-name">{props.name}</span>
              <div className="preview-controls">
                <button
                  className={`round${mic ? "" : " off"}${trouble.mic ? " trouble" : ""}`}
                  onClick={() => toggle("mic")}
                  aria-label={
                    trouble.mic
                      ? "Fix microphone"
                      : mic
                        ? "Turn off microphone"
                        : "Turn on microphone"
                  }
                  aria-pressed={!mic}
                >
                  {mic && !trouble.mic ? <Mic size={22} /> : <MicOff size={22} />}
                  {trouble.mic && <span className="trouble-dot">!</span>}
                </button>
                <button
                  className={`round${camera ? "" : " off"}${trouble.camera ? " trouble" : ""}`}
                  onClick={() => toggle("camera")}
                  aria-label={
                    trouble.camera ? "Fix camera" : camera ? "Turn off camera" : "Turn on camera"
                  }
                  aria-pressed={!camera}
                >
                  {camera && !trouble.camera ? <Video size={22} /> : <VideoOff size={22} />}
                  {trouble.camera && <span className="trouble-dot">!</span>}
                </button>
              </div>
              {mic && access.mic === "granted" && (
                <div className="mic-meter" aria-label="Microphone level">
                  <div ref={meter} />
                </div>
              )}
            </>
          )}
        </div>
        <DeviceTrouble trouble={trouble} onFix={setHelp} />
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
        {unsupported && inApp && (
          <DeviceTrouble trouble={{ mic: "blocked", camera: "blocked" }} onFix={setHelp} />
        )}
        {unsupported && !inApp && (
          <p className="callout warn">
            This browser can't use a camera or microphone here. Open the link in Chrome or Safari.
          </p>
        )}
        <button
          className="primary big"
          onClick={() =>
            props.onJoin({
              mic: mic && usable(access.mic) && !unsupported,
              camera: camera && usable(access.camera) && !unsupported,
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
      {help && (
        <AccessHelp
          device={help}
          access={unsupported ? "blocked" : access[help]}
          onClose={() => setHelp(null)}
          onRetry={() => {
            setHelp(null);
            setAttempt((n) => n + 1);
          }}
          onSkip={() => {
            setHelp(null);
            (help === "mic" ? setMic : setCamera)(false);
          }}
        />
      )}
    </main>
  );
}
