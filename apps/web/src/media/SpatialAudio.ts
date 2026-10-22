import type { Vec3 } from "@vcr/engine";

/**
 * The spatial audio graph (PLAN.md § 4.5):
 *
 *   per person: MediaStreamSource → volume (gain) → HRTF panner ─┬→ conversation bus ─────────┐
 *                                                                └→ background bus → lowpass ─┴→ master → compressor → speakers
 *
 * Everyone routes to the conversation bus today. Side conversations will route people outside
 * your group to the background bus, whose level is the "how much of the room you hear" slider.
 *
 * The listener follows the camera and each panner follows that person's avatar head, both
 * updated every frame by the 3D world.
 */

/** Avatar head height above the feet, where voices come from. */
const VOICE_HEIGHT = 1.55;

export type AudioBus = "conversation" | "background";

/** Crossfade time when someone moves between buses. */
const BUS_FADE_S = 0.3;

/** Key `levelOf` uses for your own microphone. */
export const LOCAL_VOICE = "__local";

interface Source {
  element: HTMLAudioElement;
  node: MediaStreamAudioSourceNode;
  /** Taps the voice before volume and distance, so mouths move however loud you hear them. */
  meter: AnalyserNode;
  volume: GainNode;
  panner: PannerNode;
  /** One send per bus; routing crossfades between them. */
  sends: Record<AudioBus, GainNode>;
}

export class SpatialAudio {
  readonly context: AudioContext;
  private master: GainNode;
  private buses: Record<AudioBus, GainNode>;
  private routes = new Map<string, AudioBus>();
  private sources = new Map<string, Source>();
  /** Last known feet position per person, also used to pick who's audible. */
  readonly positions = new Map<string, Vec3>();
  readonly listener: { position: Vec3 } = { position: [0, 0, 0] };
  private volumes = new Map<string, number>();
  private localMic: {
    node: MediaStreamAudioSourceNode;
    meter: AnalyserNode;
    track: MediaStreamTrack;
  } | null = null;
  private samples = new Float32Array(256);

  constructor() {
    this.context = new AudioContext({ latencyHint: "interactive" });
    const compressor = this.context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.ratio.value = 3;
    this.master = this.context.createGain();
    this.master.connect(compressor).connect(this.context.destination);
    const muffle = new BiquadFilterNode(this.context, { type: "lowpass", frequency: 1800 });
    muffle.connect(this.master);
    this.buses = {
      conversation: this.context.createGain(),
      background: new GainNode(this.context, { gain: 0.35 }),
    };
    this.buses.conversation.connect(this.master);
    this.buses.background.connect(muffle);
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
    const meter = new AnalyserNode(this.context, { fftSize: 256 });
    node.connect(meter);
    const volume = this.context.createGain();
    volume.gain.value = this.volumes.get(id) ?? 1;
    const panner = new PannerNode(this.context, {
      panningModel: "HRTF",
      distanceModel: "inverse",
      refDistance: 1,
      rolloffFactor: 1.5,
      maxDistance: 25,
    });
    const bus = this.routes.get(id) ?? "conversation";
    const sends = {
      conversation: new GainNode(this.context, { gain: bus === "conversation" ? 1 : 0 }),
      background: new GainNode(this.context, { gain: bus === "background" ? 1 : 0 }),
    };
    node.connect(volume).connect(panner);
    for (const name of ["conversation", "background"] as const) {
      panner.connect(sends[name]).connect(this.buses[name]);
    }
    this.sources.set(id, { element, node, meter, volume, panner, sends });
    const at = this.positions.get(id);
    if (at) this.placeSource(this.sources.get(id)!, at);
  }

  removeTrack(id: string) {
    const source = this.sources.get(id);
    if (!source) return;
    source.node.disconnect();
    source.meter.disconnect();
    source.volume.disconnect();
    source.panner.disconnect();
    source.sends.conversation.disconnect();
    source.sends.background.disconnect();
    source.element.srcObject = null;
    this.sources.delete(id);
  }

  /** Your own microphone, measured (never played back) so your avatar's mouth moves too. */
  setLocalMic(track: MediaStreamTrack | null) {
    if (this.localMic?.track === track) return;
    this.localMic?.node.disconnect();
    this.localMic = null;
    if (!track) return;
    const node = this.context.createMediaStreamSource(new MediaStream([track]));
    const meter = new AnalyserNode(this.context, { fftSize: 256 });
    node.connect(meter);
    this.localMic = { node, meter, track };
  }

  /** How loud someone is right now (RMS, roughly 0–0.5 for speech); 0 if not heard. */
  levelOf(id: string): number {
    const meter = id === LOCAL_VOICE ? this.localMic?.meter : this.sources.get(id)?.meter;
    if (!meter) return 0;
    meter.getFloatTimeDomainData(this.samples);
    let sum = 0;
    for (const v of this.samples) sum += v * v;
    return Math.sqrt(sum / this.samples.length);
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

  /** Moves someone between the conversation and background buses (side conversations). */
  route(id: string, bus: AudioBus) {
    this.routes.set(id, bus);
    const source = this.sources.get(id);
    if (!source) return;
    const t = this.context.currentTime;
    for (const name of ["conversation", "background"] as const) {
      source.sends[name].gain.setTargetAtTime(name === bus ? 1 : 0, t, BUS_FADE_S / 3);
    }
  }

  /** The "background voices" slider, 0–1: how much of the rest of the room you hear. */
  setBackgroundLevel(value: number) {
    this.buses.background.gain.setTargetAtTime(value, this.context.currentTime, 0.05);
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
    this.routes.delete(id);
  }

  dispose() {
    for (const id of [...this.sources.keys()]) this.removeTrack(id);
    this.setLocalMic(null);
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
