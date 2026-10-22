import { type PointerEvent, useRef, useState } from "react";
import { clampLength, type InputSystem } from "@vcr/engine";

const JOYSTICK_RADIUS = 50;

/**
 * Phone and tablet controls: a floating joystick on the left half, drag-to-look on the right
 * half, and a jump button. Everything is written into `input.touch` and becomes Intents there.
 */
export function TouchControls({ input }: { input: InputSystem }) {
  const stick = useRef<{ id: number; x: number; y: number } | null>(null);
  const look = useRef<{ id: number; x: number; y: number } | null>(null);
  const [knob, setKnob] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);

  const onStickDown = (e: PointerEvent) => {
    if (stick.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    stick.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    setKnob({ x: e.clientX, y: e.clientY, dx: 0, dy: 0 });
  };
  const onStickMove = (e: PointerEvent) => {
    const s = stick.current;
    if (!s || s.id !== e.pointerId) return;
    const m = clampLength(
      (e.clientX - s.x) / JOYSTICK_RADIUS,
      -(e.clientY - s.y) / JOYSTICK_RADIUS,
    );
    input.setTouchMove(m.x, m.y);
    setKnob({ x: s.x, y: s.y, dx: m.x * JOYSTICK_RADIUS, dy: -m.y * JOYSTICK_RADIUS });
  };
  const onStickUp = (e: PointerEvent) => {
    if (stick.current?.id !== e.pointerId) return;
    stick.current = null;
    input.setTouchMove(0, 0);
    setKnob(null);
  };

  const onLookDown = (e: PointerEvent) => {
    if (look.current) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    look.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onLookMove = (e: PointerEvent) => {
    const l = look.current;
    if (!l || l.id !== e.pointerId) return;
    input.addTouchLook(e.clientX - l.x, e.clientY - l.y);
    l.x = e.clientX;
    l.y = e.clientY;
  };
  const onLookUp = (e: PointerEvent) => {
    if (look.current?.id === e.pointerId) look.current = null;
  };

  return (
    <div className="touch-controls">
      <div
        className="touch-zone left"
        onPointerDown={onStickDown}
        onPointerMove={onStickMove}
        onPointerUp={onStickUp}
        onPointerCancel={onStickUp}
      />
      <div
        className="touch-zone right"
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
      />
      {knob && (
        <div className="joystick" style={{ left: knob.x, top: knob.y }}>
          <div
            className="joystick-knob"
            style={{ transform: `translate(${knob.dx}px, ${knob.dy}px)` }}
          />
        </div>
      )}
      <button className="jump-button" aria-label="Jump" onPointerDown={() => input.queueJump()}>
        ⤒
      </button>
    </div>
  );
}
