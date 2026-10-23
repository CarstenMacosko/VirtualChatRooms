import {
  ConnectionQuality,
  facingModeFromLocalTrack,
  type LocalVideoTrack,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
} from "livekit-client";
import { selectAudible } from "@vcr/engine";
import type { MediaGrant } from "@vcr/protocol";
import { type Access, accessFromError, type Device } from "./access";
import type { SpatialAudio } from "./SpatialAudio";

export type MediaStatus = "off" | "connecting" | "connected" | "reconnecting" | "failed";

export interface MediaSnapshot {
  status: MediaStatus;
  error: string | null;
  micOn: boolean;
  cameraOn: boolean;
  /** Identities (realm session ids) speaking right now, including you. */
  speaking: ReadonlySet<string>;
  /** When each identity last spoke (performance.now() ms). */
  lastSpokeAt: ReadonlyMap<string, number>;
  /** Camera tracks by identity; yours is under your own id. */
  videos: ReadonlyMap<string, RemoteVideoTrack | LocalVideoTrack>;
  /** Shared screens by identity; yours is under your own id. */
  screens: ReadonlyMap<string, RemoteVideoTrack | LocalVideoTrack>;
  screenSharing: boolean;
  /** Identities whose connection is struggling right now (you included). */
  poorConnection: ReadonlyMap<string, "poor" | "lost">;
  /** Your camera's background is blurred (kept across camera off/on). */
  blur: boolean;
  /** Why your microphone or camera couldn't turn on (cleared once it does). */
  trouble: Partial<Record<Device, Access>>;
}

const BLUR_KEY = "vcr.blur";
const BLUR_RADIUS = 14;

function rememberedBlur() {
  try {
    return localStorage.getItem(BLUR_KEY) === "1";
  } catch {
    return false;
  }
}

/** Chosen input devices (deviceId), or undefined for the browser's default. */
export interface DeviceChoice {
  mic?: string | undefined;
  camera?: string | undefined;
}

const POSE_TOPIC = "pose";
/** How often the set of people you hear is re-evaluated. */
const INTEREST_INTERVAL_MS = 1000;

/**
 * One LiveKit connection for the session: publishes your mic, camera and avatar pose, and routes
 * other people's voices into the spatial audio graph. Audio is subscribed only for the nearest
 * people (selectAudible); cameras are subscribed for everyone, and adaptive stream pauses the
 * ones whose tiles aren't visible.
 */
export class MediaSession {
  private room: Room;
  private snapshot: MediaSnapshot = {
    status: "off",
    error: null,
    micOn: false,
    cameraOn: false,
    speaking: new Set(),
    lastSpokeAt: new Map(),
    videos: new Map(),
    screens: new Map(),
    screenSharing: false,
    poorConnection: new Map(),
    blur: rememberedBlur(),
    trouble: {},
  };
  private listeners = new Set<() => void>();
  private interestTimer: ReturnType<typeof setInterval> | undefined;
  /** Always subscribed, however far: the group you're listening in on. */
  private focus = new Set<string>();
  private disposed = false;

  /** Called with each pose packet another participant publishes. */
  onPose: ((from: string, bytes: Uint8Array) => void) | null = null;

  constructor(
    private audio: SpatialAudio,
    devices: DeviceChoice = {},
  ) {
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Voices go through our own graph (SpatialAudio), not LiveKit's mixer.
      webAudioMix: false,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(devices.mic && { deviceId: devices.mic }),
      },
      // Capture at 720p for big tiles; small tiles take the 180p/360p layers.
      videoCaptureDefaults: {
        resolution: VideoPresets.h720.resolution,
        ...(devices.camera && { deviceId: devices.camera }),
      },
      publishDefaults: {
        simulcast: true,
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360],
        dtx: true,
      },
    });
    this.wire();
  }

  // --- React binding (useSyncExternalStore) ---

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private update(patch: Partial<MediaSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  get identity() {
    return this.room.localParticipant.identity;
  }

  get connected() {
    return this.snapshot.status === "connected";
  }

  // --- Lifecycle ---

  async connect(grant: MediaGrant, want: { mic: boolean; camera: boolean }) {
    if (!grant.url || !grant.token) {
      this.update({ status: "failed", error: "Voice and video aren't set up on this server." });
      return;
    }
    this.update({ status: "connecting", error: null });
    try {
      await this.room.connect(grant.url, grant.token, { autoSubscribe: false });
    } catch (err) {
      if (!this.disposed) {
        this.update({
          status: "failed",
          error: `Couldn't connect voice and video: ${String(err)}`,
        });
      }
      return;
    }
    if (this.disposed) return void this.room.disconnect();
    this.update({ status: "connected" });
    for (const p of this.room.remoteParticipants.values()) this.subscribeCameras(p);
    this.refreshInterest();
    this.interestTimer = setInterval(() => this.refreshInterest(), INTEREST_INTERVAL_MS);
    await Promise.all([this.setMic(want.mic), this.setCamera(want.camera)]);
  }

  async dispose() {
    this.disposed = true;
    clearInterval(this.interestTimer);
    this.listeners.clear();
    await this.room.disconnect();
  }

  /** Keeps these people's voices subscribed wherever they stand (listening in on their group). */
  setFocus(ids: ReadonlySet<string>) {
    if (ids.size === this.focus.size && [...ids].every((id) => this.focus.has(id))) return;
    this.focus = new Set(ids);
    this.refreshInterest();
  }

  // --- Publishing ---

  async setMic(on: boolean) {
    await this.setDevice("mic", on);
  }

  async setCamera(on: boolean) {
    await this.setDevice("camera", on);
  }

  private async setDevice(device: Device, on: boolean) {
    const rest = { ...this.snapshot.trouble };
    delete rest[device];
    try {
      const lp = this.room.localParticipant;
      await (device === "mic" ? lp.setMicrophoneEnabled(on) : lp.setCameraEnabled(on));
      this.update({ trouble: rest });
    } catch (err) {
      this.update({ trouble: on ? { ...rest, [device]: accessFromError(err) } : rest });
    }
    this.syncLocal();
  }

  async setScreenShare(on: boolean) {
    try {
      await this.room.localParticipant.setScreenShareEnabled(on, { audio: false });
    } catch (err) {
      // Cancelling the browser's picker isn't an error worth showing.
      if (!(err instanceof DOMException && err.name === "NotAllowedError")) {
        this.update({ error: `Screen sharing: ${String(err)}` });
      }
    }
    this.syncLocal();
  }

  /**
   * Blurs the background behind you (on-device segmentation, like Meet). The library loads only
   * when someone turns it on; the choice is remembered on this device.
   */
  async setBlur(on: boolean) {
    this.update({ blur: on });
    try {
      localStorage.setItem(BLUR_KEY, on ? "1" : "0");
    } catch {
      // fine: not remembered
    }
    await this.applyBlur();
  }

  private async applyBlur() {
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.videoTrack as LocalVideoTrack | undefined;
    if (!track) return;
    try {
      if (this.snapshot.blur) {
        if (track.getProcessor()) return;
        const { BackgroundBlur, supportsBackgroundProcessors } =
          await import("@livekit/track-processors");
        if (!supportsBackgroundProcessors()) {
          this.update({ blur: false, error: "This browser can't blur your background." });
          return;
        }
        await track.setProcessor(BackgroundBlur(BLUR_RADIUS));
      } else if (track.getProcessor()) {
        await track.stopProcessor();
      }
    } catch (err) {
      this.update({ blur: false, error: `Background blur: ${String(err)}` });
    }
    this.syncLocal();
  }

  /** Switches to another microphone or camera mid-call. */
  async switchDevice(kind: "audioinput" | "videoinput", deviceId: string) {
    try {
      await this.room.switchActiveDevice(kind, deviceId);
    } catch (err) {
      this.update({ error: `Couldn't switch device: ${String(err)}` });
    }
    this.syncLocal();
  }

  /** Front ↔ back camera on phones. */
  async flipCamera() {
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.Camera);
    const track = pub?.videoTrack as LocalVideoTrack | undefined;
    if (!track) return;
    const facing = facingModeFromLocalTrack(track).facingMode;
    try {
      await track.restartTrack({ facingMode: facing === "environment" ? "user" : "environment" });
    } catch (err) {
      this.update({ error: `Couldn't flip the camera: ${String(err)}` });
    }
    this.syncLocal();
  }

  /** Avatar pose over the lossy data channel: a dropped packet is replaced 66 ms later. */
  publishPose(bytes: Uint8Array) {
    if (!this.connected) return;
    void this.room.localParticipant
      .publishData(bytes as Uint8Array<ArrayBuffer>, { reliable: false, topic: POSE_TOPIC })
      .catch(() => {});
  }

  // --- Internals ---

  private wire() {
    const r = this.room;
    r.on(RoomEvent.Reconnecting, () => this.update({ status: "reconnecting" }));
    r.on(RoomEvent.Reconnected, () => this.update({ status: "connected" }));
    r.on(RoomEvent.Disconnected, () => {
      if (!this.disposed) this.update({ status: "failed", error: "Voice and video disconnected." });
    });
    r.on(RoomEvent.ParticipantConnected, (p) => this.subscribeCameras(p));
    r.on(RoomEvent.TrackPublished, (pub, p) => {
      if (pub.source === Track.Source.Camera || pub.source === Track.Source.ScreenShare) {
        pub.setSubscribed(true);
      } else if (pub.source === Track.Source.Microphone) this.refreshInterest(p.identity);
    });
    r.on(RoomEvent.TrackSubscribed, (track, pub, p) => this.attach(track, pub, p));
    r.on(RoomEvent.TrackUnsubscribed, (track, pub, p) => this.detach(track, pub, p));
    r.on(RoomEvent.ParticipantDisconnected, (p) => {
      this.audio.removeTrack(p.identity);
      this.dropVideo(p.identity);
      this.dropScreen(p.identity);
    });
    r.on(RoomEvent.LocalTrackPublished, (pub) => {
      this.syncLocal();
      // A camera turned back on gets the blur again.
      if (pub.source === Track.Source.Camera && this.snapshot.blur) void this.applyBlur();
    });
    r.on(RoomEvent.LocalTrackUnpublished, () => this.syncLocal());
    // A host muting you arrives as a server-side mute of your track.
    r.on(RoomEvent.TrackMuted, (_pub, p) => p.isLocal && this.syncLocal());
    r.on(RoomEvent.TrackUnmuted, (_pub, p) => p.isLocal && this.syncLocal());
    r.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
      const now = performance.now();
      const lastSpokeAt = new Map(this.snapshot.lastSpokeAt);
      for (const s of speakers) lastSpokeAt.set(s.identity, now);
      this.update({ speaking: new Set(speakers.map((s) => s.identity)), lastSpokeAt });
    });
    // Only bad connections are worth showing (like Meet's "unstable connection").
    r.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
      const poorConnection = new Map(this.snapshot.poorConnection);
      if (quality === ConnectionQuality.Poor) poorConnection.set(participant.identity, "poor");
      else if (quality === ConnectionQuality.Lost) poorConnection.set(participant.identity, "lost");
      else if (!poorConnection.delete(participant.identity)) return;
      this.update({ poorConnection });
    });
    r.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic === POSE_TOPIC && participant) this.onPose?.(participant.identity, payload);
    });
  }

  private subscribeCameras(p: RemoteParticipant) {
    for (const pub of p.trackPublications.values()) {
      if (pub.source === Track.Source.Camera || pub.source === Track.Source.ScreenShare) {
        pub.setSubscribed(true);
      }
    }
  }

  /** Subscribes audio for the nearest people and drops it for everyone else. */
  private refreshInterest(onlyIdentity?: string) {
    if (!this.connected) return;
    const others = [...this.room.remoteParticipants.values()].map((p) => {
      const at = this.audio.positions.get(p.identity);
      // Someone whose avatar hasn't arrived yet counts as next to you, so you hear them.
      return {
        id: p.identity,
        x: at?.[0] ?? this.audio.listener.position[0],
        z: at?.[2] ?? this.audio.listener.position[2],
      };
    });
    const [lx, , lz] = this.audio.listener.position;
    // In the video grid there's no "near": everyone is in the conversation.
    const audible = this.audio.spatial
      ? selectAudible({ x: lx, z: lz }, others)
      : new Set(others.map((o) => o.id));
    for (const id of this.focus) audible.add(id);
    for (const p of this.room.remoteParticipants.values()) {
      if (onlyIdentity && p.identity !== onlyIdentity) continue;
      const pub = p.getTrackPublication(Track.Source.Microphone) as
        RemoteTrackPublication | undefined;
      if (!pub) continue;
      const want = audible.has(p.identity);
      if (pub.isSubscribed !== want) pub.setSubscribed(want);
    }
  }

  private attach(track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) {
    if (pub.source === Track.Source.Microphone) {
      this.audio.addTrack(p.identity, track.mediaStreamTrack);
    } else if (pub.source === Track.Source.Camera) {
      const videos = new Map(this.snapshot.videos);
      videos.set(p.identity, track as RemoteVideoTrack);
      this.update({ videos });
    } else if (pub.source === Track.Source.ScreenShare) {
      const screens = new Map(this.snapshot.screens);
      screens.set(p.identity, track as RemoteVideoTrack);
      this.update({ screens });
    }
  }

  private detach(_track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) {
    if (pub.source === Track.Source.Microphone) this.audio.removeTrack(p.identity);
    else if (pub.source === Track.Source.Camera) this.dropVideo(p.identity);
    else if (pub.source === Track.Source.ScreenShare) this.dropScreen(p.identity);
  }

  private dropScreen(identity: string) {
    if (!this.snapshot.screens.has(identity)) return;
    const screens = new Map(this.snapshot.screens);
    screens.delete(identity);
    this.update({ screens });
  }

  private dropVideo(identity: string) {
    if (!this.snapshot.videos.has(identity)) return;
    const videos = new Map(this.snapshot.videos);
    videos.delete(identity);
    this.update({ videos });
  }

  /** Mirrors your own mic/camera state (including host mutes) into the snapshot. */
  private syncLocal() {
    const lp = this.room.localParticipant;
    const cam = lp.getTrackPublication(Track.Source.Camera);
    const videos = new Map(this.snapshot.videos);
    const camTrack =
      cam && !cam.isMuted ? (cam.videoTrack as LocalVideoTrack | undefined) : undefined;
    if (camTrack) videos.set(lp.identity, camTrack);
    else videos.delete(lp.identity);
    const mic = lp.getTrackPublication(Track.Source.Microphone);
    this.audio.setLocalMic(mic && !mic.isMuted ? (mic.track?.mediaStreamTrack ?? null) : null);
    const screen = lp.getTrackPublication(Track.Source.ScreenShare);
    const screens = new Map(this.snapshot.screens);
    const screenTrack = screen?.videoTrack as LocalVideoTrack | undefined;
    if (screenTrack) screens.set(lp.identity, screenTrack);
    else screens.delete(lp.identity);
    this.update({
      micOn: lp.isMicrophoneEnabled,
      cameraOn: lp.isCameraEnabled,
      screenSharing: lp.isScreenShareEnabled,
      videos,
      screens,
    });
  }
}
