/**
 * Every input device (keyboard + mouse, touch, gamepad, and VR controllers later) produces the
 * same Intents, so locomotion and cameras never care where input came from (ADR 0008).
 */
export interface Intents {
  /** Desired movement relative to the camera: x = right, y = forward. Length ≤ 1. */
  move: { x: number; y: number };
  /** Camera rotation this frame, radians. Positive yaw turns left; positive pitch looks down. */
  look: { yaw: number; pitch: number };
  /** Camera zoom this frame: positive moves the camera further away. */
  zoom: number;
  run: boolean;
  /** Edge-triggered: true only on the frame it was pressed. */
  jump: boolean;
  /** Edge-triggered: switch between third- and first-person. */
  toggleCamera: boolean;
  // Later phases add: sit, interact, emote, teleport (VR).
}

export function emptyIntents(): Intents {
  return {
    move: { x: 0, y: 0 },
    look: { yaw: 0, pitch: 0 },
    zoom: 0,
    run: false,
    jump: false,
    toggleCamera: false,
  };
}

/** Scales a 2D vector down to length 1 if it's longer (diagonals aren't faster). */
export function clampLength(x: number, y: number): { x: number; y: number } {
  const len = Math.hypot(x, y);
  return len > 1 ? { x: x / len, y: y / len } : { x, y };
}

export function moveFromKeys(keys: {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
}): { x: number; y: number } {
  const x = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const y = (keys.forward ? 1 : 0) - (keys.back ? 1 : 0);
  return clampLength(x, y);
}

/** Radial deadzone that rescales the remaining range so small stick movements stay smooth. */
export function applyDeadzone(x: number, y: number, deadzone = 0.15): { x: number; y: number } {
  const len = Math.hypot(x, y);
  if (len <= deadzone) return { x: 0, y: 0 };
  const scaled = Math.min(1, (len - deadzone) / (1 - deadzone));
  return { x: (x / len) * scaled, y: (y / len) * scaled };
}
