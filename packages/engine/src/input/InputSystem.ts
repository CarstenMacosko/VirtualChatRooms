import { applyDeadzone, clampLength, emptyIntents, type Intents, moveFromKeys } from "./intents";

/** Values the on-screen touch controls write; InputSystem folds them into Intents. */
export interface TouchState {
  move: { x: number; y: number };
  /** Accumulated look drag in CSS pixels since the last sample. */
  lookPx: { x: number; y: number };
  jumpQueued: boolean;
  interactQueued: boolean;
}

export interface InputOptions {
  /** Radians per CSS pixel of mouse/touch drag. */
  lookSensitivity?: number;
  /** Radians per second for Q/E and gamepad right stick. */
  turnSpeed?: number;
}

const KEY_BINDINGS = {
  forward: ["KeyW", "ArrowUp"],
  back: ["KeyS", "ArrowDown"],
  left: ["KeyA", "ArrowLeft"],
  right: ["KeyD", "ArrowRight"],
  turnLeft: ["KeyQ"],
  turnRight: ["KeyE"],
  run: ["ShiftLeft", "ShiftRight"],
  jump: ["Space"],
  toggleCamera: ["KeyV"],
  /** E as well while there's something to interact with (see `interactAvailable`). */
  interact: ["KeyF"],
} as const;
type Action = keyof typeof KEY_BINDINGS;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Browser input → Intents. Keyboard, mouse drag (on `target`), wheel and the first gamepad are
 * read directly; touch comes from on-screen controls via `touch`.
 */
export class InputSystem {
  readonly touch: TouchState = {
    move: { x: 0, y: 0 },
    lookPx: { x: 0, y: 0 },
    jumpQueued: false,
    interactQueued: false,
  };
  /**
   * Set while something can be interacted with (a seat in front of you, or you're sitting): E
   * then interacts instead of turning right, so "E Sit" works without stealing Q/E turning.
   */
  interactAvailable = false;

  private held = new Set<string>();
  private pressed = new Set<string>();
  private dragPx = { x: 0, y: 0 };
  private dragging: number | null = null;
  private wheel = 0;
  private gamepadButtons: boolean[] = [];
  private readonly lookSensitivity: number;
  private readonly turnSpeed: number;
  private abort: AbortController | null = null;

  constructor(options: InputOptions = {}) {
    this.lookSensitivity = options.lookSensitivity ?? 0.005;
    this.turnSpeed = options.turnSpeed ?? 2.5;
  }

  /** Starts listening: keyboard on the window, mouse drag and wheel on `target`. */
  attach(target: HTMLElement) {
    this.detach();
    this.abort = new AbortController();
    const signal = this.abort.signal;

    window.addEventListener(
      "keydown",
      (e) => {
        if (isTyping(e.target)) return;
        if (!this.held.has(e.code)) this.pressed.add(e.code);
        this.held.add(e.code);
        if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
      },
      { signal },
    );
    window.addEventListener("keyup", (e) => this.held.delete(e.code), { signal });
    // Releasing keys while the window is unfocused would otherwise leave them "stuck".
    window.addEventListener("blur", () => this.held.clear(), { signal });

    target.addEventListener(
      "pointerdown",
      (e) => {
        if (e.pointerType === "touch" || this.dragging !== null) return;
        this.dragging = e.pointerId;
        target.setPointerCapture(e.pointerId);
      },
      { signal },
    );
    target.addEventListener(
      "pointermove",
      (e) => {
        if (e.pointerId !== this.dragging) return;
        this.dragPx.x += e.movementX;
        this.dragPx.y += e.movementY;
      },
      { signal },
    );
    const endDrag = (e: PointerEvent) => {
      if (e.pointerId === this.dragging) this.dragging = null;
    };
    target.addEventListener("pointerup", endDrag, { signal });
    target.addEventListener("pointercancel", endDrag, { signal });
    target.addEventListener(
      "wheel",
      (e) => {
        this.wheel += e.deltaY;
        e.preventDefault();
      },
      { signal, passive: false },
    );
    target.addEventListener("contextmenu", (e) => e.preventDefault(), { signal });
  }

  /** On-screen joystick position, each axis in [-1, 1] (y = forward). */
  setTouchMove(x: number, y: number) {
    this.touch.move = clampLength(x, y);
  }

  /** On-screen look drag, in CSS pixels. */
  addTouchLook(dx: number, dy: number) {
    this.touch.lookPx.x += dx;
    this.touch.lookPx.y += dy;
  }

  queueJump() {
    this.touch.jumpQueued = true;
  }

  /** The on-screen "Sit" / "Stand up" button. */
  queueInteract() {
    this.touch.interactQueued = true;
  }

  detach() {
    this.abort?.abort();
    this.abort = null;
    this.held.clear();
    this.dragging = null;
  }

  private isHeld(action: Action) {
    return KEY_BINDINGS[action].some((code) => this.held.has(code));
  }

  private wasPressed(action: Action) {
    return KEY_BINDINGS[action].some((code) => this.pressed.has(code));
  }

  /** Reads and clears everything accumulated since the previous call. */
  sample(dt: number): Intents {
    const intents = emptyIntents();
    const keyMove = moveFromKeys({
      forward: this.isHeld("forward"),
      back: this.isHeld("back"),
      left: this.isHeld("left"),
      right: this.isHeld("right"),
    });

    const pad = this.readGamepad();
    intents.move = clampLength(
      keyMove.x + this.touch.move.x + pad.move.x,
      keyMove.y + this.touch.move.y + pad.move.y,
    );

    const eInteracts = this.interactAvailable;
    const turnRight = this.isHeld("turnRight") && !eInteracts;
    const keyTurn = (this.isHeld("turnLeft") ? 1 : 0) - (turnRight ? 1 : 0);
    const dragX = this.dragPx.x + this.touch.lookPx.x;
    const dragY = this.dragPx.y + this.touch.lookPx.y;
    intents.look.yaw = -dragX * this.lookSensitivity + (keyTurn - pad.look.x) * this.turnSpeed * dt;
    intents.look.pitch = dragY * this.lookSensitivity + pad.look.y * this.turnSpeed * dt;

    intents.zoom = this.wheel * 0.002;
    intents.run = this.isHeld("run") || pad.run;
    intents.jump = this.wasPressed("jump") || this.touch.jumpQueued || pad.jump;
    intents.toggleCamera = this.wasPressed("toggleCamera") || pad.toggleCamera;
    intents.interact =
      this.wasPressed("interact") ||
      (eInteracts && this.pressed.has("KeyE")) ||
      this.touch.interactQueued ||
      pad.interact;

    this.pressed.clear();
    this.dragPx = { x: 0, y: 0 };
    this.touch.lookPx = { x: 0, y: 0 };
    this.touch.jumpQueued = false;
    this.touch.interactQueued = false;
    this.wheel = 0;
    return intents;
  }

  private readGamepad() {
    const none = {
      move: { x: 0, y: 0 },
      look: { x: 0, y: 0 },
      run: false,
      jump: false,
      toggleCamera: false,
      interact: false,
    };
    const pad = navigator.getGamepads?.().find((p) => p?.connected);
    if (!pad) return none;
    const buttons = pad.buttons.map((b) => b.pressed);
    const edge = (i: number) => !!buttons[i] && !this.gamepadButtons[i];
    this.gamepadButtons = buttons;
    const move = applyDeadzone(pad.axes[0] ?? 0, -(pad.axes[1] ?? 0));
    const look = applyDeadzone(pad.axes[2] ?? 0, pad.axes[3] ?? 0);
    return {
      move,
      look,
      run: !!buttons[10] || !!buttons[6], // left stick click or left trigger
      jump: edge(0), // A / cross
      toggleCamera: edge(3), // Y / triangle
      interact: edge(2), // X / square
    };
  }
}
