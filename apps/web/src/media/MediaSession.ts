import {
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
  };
  private listeners = new Set<() => void>();
  private interestTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  /** Called with each pose packet another participant publishes. */
  onPose: ((from: string, bytes: Uint8Array) => void) | null = null;

  constructor(private audio: SpatialAudio) {
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
      // Voices go through our own graph (SpatialAudio), not LiveKit's mixer.
      webAudioMix: false,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      videoCaptureDefaults: { resolution: VideoPresets.h360.resolution },
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

  // --- Publishing ---

  async setMic(on: boolean) {
    try {
      await this.room.localParticipant.setMicrophoneEnabled(on);
    } catch (err) {
      this.update({ error: `Microphone: ${String(err)}` });
    }
    this.syncLocal();
  }

  async setCamera(on: boolean) {
    try {
      await this.room.localParticipant.setCameraEnabled(on);
    } catch (err) {
      this.update({ error: `Camera: ${String(err)}` });
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
      if (pub.source === Track.Source.Camera) pub.setSubscribed(true);
      else if (pub.source === Track.Source.Microphone) this.refreshInterest(p.identity);
    });
    r.on(RoomEvent.TrackSubscribed, (track, pub, p) => this.attach(track, pub, p));
    r.on(RoomEvent.TrackUnsubscribed, (track, pub, p) => this.detach(track, pub, p));
    r.on(RoomEvent.ParticipantDisconnected, (p) => {
      this.audio.removeTrack(p.identity);
      this.dropVideo(p.identity);
    });
    r.on(RoomEvent.LocalTrackPublished, () => this.syncLocal());
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
    r.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (topic === POSE_TOPIC && participant) this.onPose?.(participant.identity, payload);
    });
  }

  private subscribeCameras(p: RemoteParticipant) {
    for (const pub of p.trackPublications.values()) {
      if (pub.source === Track.Source.Camera) pub.setSubscribed(true);
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
    const audible = selectAudible({ x: lx, z: lz }, others);
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
    }
  }

  private detach(_track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) {
    if (pub.source === Track.Source.Microphone) this.audio.removeTrack(p.identity);
    else if (pub.source === Track.Source.Camera) this.dropVideo(p.identity);
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
    this.update({ micOn: lp.isMicrophoneEnabled, cameraOn: lp.isCameraEnabled, videos });
  }
}
