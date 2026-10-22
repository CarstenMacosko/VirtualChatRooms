import type { Vec3 } from "@vcr/engine";

/**
 * The spatial audio graph (PLAN.md § 4.5):
 *
 *   per person: MediaStreamSource → volume (gain) → HRTF panner ─┐
 *                                                                ├→ conversation bus → master → compressor → speakers
 *   (Phase 5: side conversations get a second, quieter "background" bus with a lowpass, whose
 *    level is the tunable "how much of the room you hear" slider.)
 *
 * The listener follows the camera and each panner follows that person's avatar head, both
 * updated every frame by the 3D world.
 */

/** Avatar head height above the feet, where voices come from. */
const VOICE_HEIGHT = 1.55;

interface Source {
  element: HTMLAudioElement;
  node: MediaStreamAudioSourceNode;
  volume: GainNode;
  panner: PannerNode;
}

export class SpatialAudio {
  readonly context: AudioContext;
  private master: GainNode;
  private bus: GainNode;
  private sources = new Map<string, Source>();
  /** Last known feet position per person, also used to pick who's audible. */
  readonly positions = new Map<string, Vec3>();
  readonly listener: { position: Vec3 } = { position: [0, 0, 0] };
  private volumes = new Map<string, number>();

  constructor() {
    this.context = new AudioContext({ latencyHint: "interactive" });
    const compressor = this.context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 3;
    this.master = this.context.createGain();
    this.bus = this.context.createGain();
    this.bus.connect(this.master).connect(compressor).connect(this.context.destination);
  }

  /** Must be called from a user gesture (the Join button) for audio to start in most browsers. */
  resume() {
    return this.context.resume();
  }

  /** Starts playing someone's voice through the graph. Replaces any previous track for them. */
  addTrack(id: string, track: MediaStreamTrack) {
    this.removeTrack(id);
    const stream = new MediaStream([track]);
    // Chrome only delivers remote WebRTC audio to Web Audio while the stream is also attached to
    // a media element; keep that element muted so the voice is only heard through the panner.
    const element = new Audio();
    element.muted = true;
    element.srcObject = stream;
    void element.play().catch(() => {});

    const node = this.context.createMediaStreamSource(stream);
    const volume = this.context.createGain();
    volume.gain.value = this.volumes.get(id) ?? 1;
    const panner = new PannerNode(this.context, {
      panningModel: "HRTF",
      distanceModel: "inverse",
      refDistance: 1,
      rolloffFactor: 1.5,
      maxDistance: 25,
    });
    node.connect(volume).connect(panner).connect(this.bus);
    this.sources.set(id, { element, node, volume, panner });
    const at = this.positions.get(id);
    if (at) this.placeSource(this.sources.get(id)!, at);
  }

  removeTrack(id: string) {
    const source = this.sources.get(id);
    if (!source) return;
    source.node.disconnect();
    source.volume.disconnect();
    source.panner.disconnect();
    source.element.srcObject = null;
    this.sources.delete(id);
  }

  /** Per-person volume, 0–2 (1 = normal). Survives them muting and unmuting. */
  setVolume(id: string, value: number) {
    this.volumes.set(id, value);
    const source = this.sources.get(id);
    if (source) source.volume.gain.setTargetAtTime(value, this.context.currentTime, 0.05);
  }

  volumeOf(id: string) {
    return this.volumes.get(id) ?? 1;
  }

  setMasterVolume(value: number) {
    this.master.gain.setTargetAtTime(value, this.context.currentTime, 0.05);
  }

  /** Camera position and facing, once per frame. */
  setListener(position: Vec3, forward: Vec3) {
    const l = this.context.listener;
    this.listener.position = position;
    if (l.positionX) {
      const t = this.context.currentTime;
      l.positionX.setValueAtTime(position[0], t);
      l.positionY.setValueAtTime(position[1], t);
      l.positionZ.setValueAtTime(position[2], t);
      l.forwardX.setValueAtTime(forward[0], t);
      l.forwardY.setValueAtTime(forward[1], t);
      l.forwardZ.setValueAtTime(forward[2], t);
      l.upX.setValueAtTime(0, t);
      l.upY.setValueAtTime(1, t);
      l.upZ.setValueAtTime(0, t);
    } else {
      // Firefox and older Safari only have the deprecated setters.
      l.setPosition(...position);
      l.setOrientation(...forward, 0, 1, 0);
    }
  }

  /** Someone's avatar feet position, once per frame. */
  setPosition(id: string, feet: Vec3) {
    this.positions.set(id, feet);
    const source = this.sources.get(id);
    if (source) this.placeSource(source, feet);
  }

  forget(id: string) {
    this.removeTrack(id);
    this.positions.delete(id);
  }

  dispose() {
    for (const id of [...this.sources.keys()]) this.removeTrack(id);
    void this.context.close();
  }

  private placeSource(source: Source, feet: Vec3) {
    const p = source.panner;
    const t = this.context.currentTime;
    p.positionX.setValueAtTime(feet[0], t);
    p.positionY.setValueAtTime(feet[1] + VOICE_HEIGHT, t);
    p.positionZ.setValueAtTime(feet[2], t);
  }
}
