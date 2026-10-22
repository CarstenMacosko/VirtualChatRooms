import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import { useLive } from "../lib/live";
import { navigate } from "../lib/router";

/** A soft two-note chime every two seconds while a call is ringing. */
function useChime(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch {
      return;
    }
    const play = () => {
      const t = context.currentTime;
      for (const [i, freq] of [660, 880].entries()) {
        const osc = context.createOscillator();
        const gain = context.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, t + i * 0.18);
        gain.gain.linearRampToValueAtTime(0.12, t + i * 0.18 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.18 + 0.5);
        osc.connect(gain).connect(context.destination);
        osc.start(t + i * 0.18);
        osc.stop(t + i * 0.18 + 0.5);
      }
    };
    play();
    const timer = setInterval(play, 2000);
    return () => {
      clearInterval(timer);
      void context.close();
    };
  }, [active]);
}

const RESPONSE_COPY = {
  accepted: "joined",
  declined: "can't make it",
  missed: "missed your call",
  ringing: "is being rung",
} as const;

/** Incoming calls and answers to your calls, on every screen while signed in. */
export function RingOverlay() {
  const rings = useLive((s) => s.rings);
  const responses = useLive((s) => s.responses);
  const dismissRing = useLive((s) => s.dismissRing);
  const dismissResponse = useLive((s) => s.dismissResponse);
  const ring = rings.at(-1);
  const notified = useRef(new Set<string>());
  useChime(ring !== undefined);

  // A system notification when the tab is in the background (if the user allowed it).
  useEffect(() => {
    if (!ring || notified.current.has(ring.sessionId) || !document.hidden) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    notified.current.add(ring.sessionId);
    const n = new Notification(`${ring.from.displayName} is calling`, {
      body: `Join them in ${ring.roomName}`,
      tag: ring.sessionId,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }, [ring]);

  // Answer toasts fade after a few seconds.
  useEffect(() => {
    if (!responses.length) return;
    const timer = setTimeout(() => dismissResponse(responses[0]!.at), 5000);
    return () => clearTimeout(timer);
  }, [responses, dismissResponse]);

  return (
    <>
      {ring && (
        <div className="ring" role="alertdialog" aria-label="Incoming call">
          <div className="ring-avatar" aria-hidden>
            {ring.from.displayName.slice(0, 1).toUpperCase()}
          </div>
          <div>
            <b>{ring.from.displayName}</b> is calling
            <div className="muted">Join them in {ring.roomName}</div>
          </div>
          <div className="row">
            <button
              className="danger"
              onClick={() => {
                dismissRing(ring.sessionId);
                void api.declineSession(ring.sessionId).catch(() => {});
              }}
            >
              Decline
            </button>
            <button
              className="accept"
              onClick={() => {
                dismissRing(ring.sessionId);
                navigate(`/s/${ring.sessionId}`);
              }}
            >
              Answer
            </button>
          </div>
        </div>
      )}
      <div className="toasts" aria-live="polite">
        {responses.map((r) => (
          <p key={r.at} className="toast-item">
            {r.displayName} {RESPONSE_COPY[r.status]}
          </p>
        ))}
      </div>
    </>
  );
}
