import { Client, type Room } from "@colyseus/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { PoseHub } from "@vcr/engine";
import {
  type EmoteBroadcast,
  type EmoteId,
  type ParticipantView,
  REALM_ROOM_NAME,
  RealmMessage,
  type RealmJoinOptions,
} from "@vcr/protocol";

const REALM_URL = import.meta.env.VITE_REALM_URL ?? "ws://localhost:2567";

export type RealmStatus = "connecting" | "connected" | "reconnecting" | "error";

const MAX_RETRY_DELAY_MS = 10_000;

interface SyncedState {
  participants: Record<string, Omit<ParticipantView, "id">>;
}

export interface ActiveEmote {
  emote: EmoteId;
  at: number;
}

/**
 * Joins the realm session and mirrors its participant roster into React state.
 * Mount it under a `key` of token + session so a change starts from fresh state.
 */
export function useRealmSession(token: string, sessionId: string) {
  const [status, setStatus] = useState<RealmStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<ParticipantView[]>([]);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [emotes, setEmotes] = useState<Record<string, ActiveEmote>>({});
  const roomRef = useRef<Room | null>(null);
  const [poseHub] = useState(() => new PoseHub());
  // Bumping `attempt` re-runs the effect, which rejoins after a drop or failed join.
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const client = new Client(REALM_URL);
    const options: RealmJoinOptions = { token, sessionId };

    const scheduleRetry = () => {
      const delay = Math.min(1000 * 2 ** failures.current, MAX_RETRY_DELAY_MS);
      failures.current += 1;
      setStatus("reconnecting");
      retryTimer = setTimeout(() => setAttempt((a) => a + 1), delay);
    };

    client
      .joinOrCreate(REALM_ROOM_NAME, options)
      .then((room) => {
        if (cancelled) {
          void room.leave();
          return;
        }
        failures.current = 0;
        roomRef.current = room;
        poseHub.setSender((bytes) => room.sendBytes(RealmMessage.pose, bytes));
        setSelfId(room.sessionId);
        setStatus("connected");
        setError(null);
        room.onStateChange((state) => {
          const json = (state as { toJSON(): SyncedState }).toJSON();
          setParticipants(Object.entries(json.participants ?? {}).map(([id, p]) => ({ id, ...p })));
        });
        room.onMessage(RealmMessage.pose, (bytes: Uint8Array) => {
          poseHub.ingest(bytes, performance.now());
        });
        room.onMessage(RealmMessage.emote, (msg: EmoteBroadcast) => {
          setEmotes((prev) => ({ ...prev, [msg.from]: { emote: msg.emote, at: Date.now() } }));
        });
        room.onLeave(() => {
          if (cancelled) return; // we left on purpose
          roomRef.current = null;
          poseHub.setSender(null);
          poseHub.clear();
          setParticipants([]);
          scheduleRetry();
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        // A rejected session token won't fix itself by retrying; the user has to sign in again.
        if ((err as { code?: number }).code === 401) setStatus("error");
        else scheduleRetry();
      });

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      poseHub.setSender(null);
      void roomRef.current?.leave();
      roomRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `attempt` triggers the rejoin
  }, [token, sessionId, attempt, poseHub]);

  const sendEmote = useCallback((emote: EmoteId) => {
    roomRef.current?.send(RealmMessage.emote, { emote });
  }, []);

  return { status, error, participants, selfId, emotes, sendEmote, poseHub };
}
