import type { Vec3 } from "@vcr/engine";

/**
 * The spatial audio graph (PLAN.md § 4.5):
 *
 *   per person: MediaStreamSource → volume (gain) → HRTF panner ─┬→ conversation bus ─────────┐
 *                                                                └→ background bus → lowpass ─┴→ master → compressor → speakers
 *
 * People in your group (and in a group you're listening in on) route to the conversation bus;
 * everyone else to the background bus, whose level is the "other groups" slider (useGroups.ts).
 *
 * The listener follows the camera and each panner follows that person's avatar head, both
 * updated every frame by the 3D world. In the video grid there's no room to place voices in, so
 * the graph goes flat: everyone straight ahead at a normal distance.
 */

/** Avatar head height above the feet, where voices come from. */
const VOICE_HEIGHT = 1.55;

export type AudioBus = "conversation" | "background";

/** How far away people you're listening in on sound, however far their avatars stand. */
const NEAR_DISTANCE = 1.5;

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
  private flat = false;
  /** Heard as if nearby: the group you're listening in on. */
  private near = new Set<string>();
  private stateListeners = new Set<() => void>();

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
    // iOS suspends ("interrupts") audio when the microphone starts or a call comes in; the UI
    // offers a tap to resume (see `needsUnlock`).
    this.context.addEventListener("statechange", () => {
      for (const listener of this.stateListeners) listener();
    });
  }

  /** Whether sound is blocked until the next tap (autoplay rules, iOS interruptions). */
  get needsUnlock() {
    return this.context.state !== "running" && this.context.state !== "closed";
  }

  onStateChange(listener: () => void) {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** Plays voices through a chosen output device, where the browser allows it (Chrome). */
  async setOutputDevice(deviceId: string) {
    const ctx = this.context as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (ctx.setSinkId) await ctx.setSinkId(deviceId === "default" ? "" : deviceId);
  }

  static get canChooseOutput() {
    return "setSinkId" in AudioContext.prototype;
  }

  get spatial() {
    return !this.flat;
  }

  /** Flat (video grid) or spatial (3D room) voices. */
  setSpatial(spatial: boolean) {
    if (this.flat === !spatial) return;
    this.flat = !spatial;
    for (const [id, source] of this.sources) {
      source.panner.panningModel = this.flat ? "equalpower" : "HRTF";
      const at = this.positions.get(id);
      this.placeSource(id, source, at ?? [0, 0, 0]);
    }
    if (this.flat) this.applyListener([0, 0, 0], [0, 0, -1]);
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
      panningModel: this.flat ? "equalpower" : "HRTF",
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
    this.placeSource(id, this.sources.get(id)!, this.positions.get(id) ?? [0, 0, 0]);
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
    if (this.routes.get(id) === bus) return;
    this.routes.set(id, bus);
    const source = this.sources.get(id);
    if (!source) return;
    const t = this.context.currentTime;
    for (const name of ["conversation", "background"] as const) {
      source.sends[name].gain.setTargetAtTime(name === bus ? 1 : 0, t, BUS_FADE_S / 3);
    }
  }

  /** People heard as if nearby wherever they stand: the group you're listening in on. */
  setNear(ids: ReadonlySet<string>) {
    if (ids.size === this.near.size && [...ids].every((id) => this.near.has(id))) return;
    this.near = new Set(ids);
    for (const [id, source] of this.sources) {
      this.placeSource(id, source, this.positions.get(id) ?? [0, 0, 0]);
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
    this.listener.position = position;
    if (!this.flat) this.applyListener(position, forward);
  }

  private applyListener(position: Vec3, forward: Vec3) {
    const l = this.context.listener;
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
    if (source) this.placeSource(id, source, feet);
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

  private placeSource(id: string, source: Source, feet: Vec3) {
    const p = source.panner;
    const t = this.context.currentTime;
    if (this.flat) {
      // One meter straight ahead of a listener at the origin: full volume, centered.
      p.positionX.setValueAtTime(0, t);
      p.positionY.setValueAtTime(0, t);
      p.positionZ.setValueAtTime(-1, t);
      return;
    }
    let [x, y, z] = [feet[0], feet[1] + VOICE_HEIGHT, feet[2]];
    if (this.near.has(id)) {
      // Same direction, pulled in close.
      const [lx, ly, lz] = this.listener.position;
      const d = Math.hypot(x - lx, y - ly, z - lz);
      if (d > NEAR_DISTANCE) {
        const k = NEAR_DISTANCE / d;
        [x, y, z] = [lx + (x - lx) * k, ly + (y - ly) * k, lz + (z - lz) * k];
      }
    }
    p.positionX.setValueAtTime(x, t);
    p.positionY.setValueAtTime(y, t);
    p.positionZ.setValueAtTime(z, t);
  }
}
