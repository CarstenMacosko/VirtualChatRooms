import { Phone, PhoneOff, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiRequestError } from "../lib/api";
import { useLive } from "../lib/live";
import { navigate } from "../lib/router";
import { Avatar } from "./ui";

/** A soft two-note ringtone every two seconds while a call is ringing. */
function useRingtone(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch {
      return;
    }
    const play = () => {
      if (context.state === "suspended") void context.resume().catch(() => {});
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
  declined: "can't make it right now",
  missed: "missed your call",
  ringing: "is being rung",
} as const;

interface Incoming {
  key: string;
  name: string;
  detail: string;
  answer(): Promise<void>;
  decline(): void;
}

/** Incoming calls (contacts ringing you, people using your call link), on every screen. */
export function RingOverlay() {
  const rings = useLive((s) => s.rings);
  const calls = useLive((s) => s.calls);
  const responses = useLive((s) => s.responses);
  const dismissRing = useLive((s) => s.dismissRing);
  const dismissCall = useLive((s) => s.dismissCall);
  const dismissResponse = useLive((s) => s.dismissResponse);
  const notified = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);

  const ring = rings.at(-1);
  const call = calls.at(-1);
  const incoming: Incoming | null = call
    ? {
        key: call.callId,
        name: call.from.displayName,
        detail: "Calling you through your call link",
        answer: async () => {
          const { sessionId } = await api.answerCall(call.callId);
          dismissCall(call.callId);
          navigate(`/s/${sessionId}`);
        },
        decline: () => {
          dismissCall(call.callId);
          void api.declineCall(call.callId).catch(() => {});
        },
      }
    : ring
      ? {
          key: ring.sessionId,
          name: ring.from.displayName,
          detail: `Video call · ${ring.roomName}`,
          answer: async () => {
            dismissRing(ring.sessionId);
            navigate(`/s/${ring.sessionId}`);
          },
          decline: () => {
            dismissRing(ring.sessionId);
            void api.declineSession(ring.sessionId).catch(() => {});
          },
        }
      : null;
  useRingtone(incoming !== null);

  // A system notification when the tab is in the background (if the user allowed it).
  const key = incoming?.key;
  const name = incoming?.name;
  const detail = incoming?.detail;
  useEffect(() => {
    if (!key || notified.current.has(key) || !document.hidden) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    notified.current.add(key);
    const n = new Notification(`${name} is calling`, { body: detail, tag: key });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }, [key, name, detail]);

  // Answer toasts fade after a few seconds.
  useEffect(() => {
    if (!responses.length) return;
    const timer = setTimeout(() => dismissResponse(responses[0]!.at), 5000);
    return () => clearTimeout(timer);
  }, [responses, dismissResponse]);

  return (
    <>
      {incoming && (
        <div className="incoming" role="alertdialog" aria-label={`${incoming.name} is calling`}>
          <div className="incoming-card">
            <div className="incoming-avatar">
              <Avatar name={incoming.name} id={incoming.name} size={88} />
            </div>
            <h2>{incoming.name}</h2>
            <p className="incoming-detail">
              <Video size={16} /> {incoming.detail}
            </p>
            {error && <p className="error">{error}</p>}
            <div className="incoming-actions">
              <span>
                <button
                  className="round hangup big"
                  onClick={() => {
                    setError(null);
                    incoming.decline();
                  }}
                  aria-label="Decline"
                >
                  <PhoneOff size={28} />
                </button>
                Decline
              </span>
              <span>
                <button
                  className="round accept big"
                  onClick={() => {
                    setError(null);
                    incoming.answer().catch((err: unknown) => {
                      setError(
                        err instanceof ApiRequestError ? err.message : "Couldn't answer the call.",
                      );
                    });
                  }}
                  aria-label="Answer"
                >
                  <Phone size={28} />
                </button>
                Answer
              </span>
            </div>
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
