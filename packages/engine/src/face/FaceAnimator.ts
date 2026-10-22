import { damp } from "../math";
import {
  arkitToVrm,
  type ExpressionWeights,
  neutralExpressions,
  VRM_EXPRESSIONS,
} from "./expressions";

export interface FaceInput {
  /** Live blendshapes from the person's webcam (ARKit order), if they're tracking. */
  tracked?: Uint8Array | null;
  /** How loud they are right now, 0–1, for mouth movement without face tracking. */
  voice?: number;
  /** Expressions an emote asks for, layered on top. */
  mood?: Partial<ExpressionWeights>;
}

/**
 * Keeps an avatar's face alive (PLAN.md § 4.2): mirrors the webcam when face tracking is on;
 * otherwise blinks on its own and moves the mouth with the voice. Everything is smoothed so
 * 15 Hz network updates don't look steppy.
 */
export class FaceAnimator {
  private current = neutralExpressions();
  private nextBlink: number;
  private blinkT = -1;
  private time = 0;
  private talkPhase = 0;
  private voice = 0;

  constructor(private readonly random: () => number = Math.random) {
    this.nextBlink = 1 + random() * 3;
  }

  update(dt: number, input: FaceInput): ExpressionWeights {
    this.time += dt;
    const target = input.tracked
      ? arkitToVrm(input.tracked)
      : this.procedural(dt, input.voice ?? 0);
    for (const [name, value] of Object.entries(input.mood ?? {}) as [
      keyof ExpressionWeights,
      number,
    ][]) {
      target[name] = Math.max(target[name], value);
    }
    // Blinks snap; everything else eases.
    for (const name of VRM_EXPRESSIONS) {
      const fast = name === "blinkLeft" || name === "blinkRight";
      this.current[name] = fast ? target[name] : damp(this.current[name], target[name], 18, dt);
    }
    return { ...this.current };
  }

  private procedural(dt: number, voice: number): ExpressionWeights {
    const w = neutralExpressions();
    // Blink every 2–6 s: ~0.1 s to close, ~0.12 s to open.
    if (this.blinkT < 0 && this.time >= this.nextBlink) this.blinkT = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const b = this.blinkT < 0.1 ? this.blinkT / 0.1 : 1 - (this.blinkT - 0.1) / 0.12;
      w.blinkLeft = w.blinkRight = Math.max(0, Math.min(1, b));
      if (this.blinkT > 0.22) {
        this.blinkT = -1;
        this.nextBlink = this.time + 2 + this.random() * 4;
      }
    }
    // Mouth follows loudness; a slow wobble between shapes reads as speech, not a flapping jaw.
    this.voice = damp(this.voice, Math.min(1, voice * 2.2), 25, dt);
    if (this.voice > 0.04) this.talkPhase += dt * 9;
    const v = this.voice;
    w.aa = v * (0.55 + 0.35 * Math.abs(Math.sin(this.talkPhase)));
    w.oh = v * 0.35 * Math.max(0, Math.sin(this.talkPhase * 0.7));
    w.ee = v * 0.3 * Math.max(0, -Math.sin(this.talkPhase * 0.53));
    return w;
  }
}
