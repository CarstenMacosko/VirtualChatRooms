import { Client, type Room } from "@colyseus/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PoseHub } from "@vcr/engine";
import {
  type EmoteBroadcast,
  type EmoteId,
  type JoinSessionResponse,
  type MediaGrant,
  type Notice,
  type ParticipantView,
  REALM_ROOM_NAME,
  RealmCloseCode,
  RealmJoinError,
  type RealmJoinOptions,
  RealmMessage,
} from "@vcr/protocol";
import { ApiRequestError } from "./api";

const REALM_URL = import.meta.env.VITE_REALM_URL ?? "ws://localhost:2567";

export type RealmStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  /** Terminal states: retrying won't help. */
  | "ended"
  | "removed"
  | "locked"
  | "error";

const MAX_RETRY_DELAY_MS = 10_000;

interface SyncedState {
  participants: Record<string, Omit<ParticipantView, "id">>;
  locked: boolean;
}

export interface ActiveEmote {
  emote: EmoteId;
  at: number;
}

export interface RealmNotice extends Notice {
  at: number;
}

/** Maps a failed join (API or realm) to a terminal status, or null if retrying may help. */
function terminalStatus(err: unknown): RealmStatus | null {
  if (err instanceof ApiRequestError) {
    if (err.status === 410) return "ended";
    if (err.status === 404 || err.status === 403 || err.status === 401) return "error";
    return null;
  }
  switch ((err as { code?: number }).code) {
    case RealmJoinError.ended:
      return "ended";
    case RealmJoinError.removed:
      return "removed";
    case RealmJoinError.locked:
      return "locked";
    case RealmJoinError.invalid:
    case RealmJoinError.badTicket:
      return "error";
    default:
      return null;
  }
}

/**
 * Joins one session's realm room and mirrors its roster into React state. `join` fetches a fresh
 * realm ticket (from the API, or a guest link) before every attempt, since tickets are
 * short-lived. Mount it under a `key` of the session so a change starts from fresh state.
 */
export function useRealmSession(join: () => Promise<JoinSessionResponse>, sessionId: string) {
  const [status, setStatus] = useState<RealmStatus>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<ParticipantView[]>([]);
  const [locked, setLocked] = useState(false);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [joinInfo, setJoinInfo] = useState<JoinSessionResponse | null>(null);
  const [mediaGrant, setMediaGrant] = useState<MediaGrant | null>(null);
  const [emotes, setEmotes] = useState<Record<string, ActiveEmote>>({});
  const [notices, setNotices] = useState<RealmNotice[]>([]);
  const roomRef = useRef<Room | null>(null);
  const [poseHub] = useState(() => new PoseHub());
  // Bumping `attempt` re-runs the effect, which rejoins after a drop or failed join.
  const [attempt, setAttempt] = useState(0);
  const failures = useRef(0);
  const joinRef = useRef(join);
  useEffect(() => {
    joinRef.current = join;
  }, [join]);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const client = new Client(REALM_URL);

    const scheduleRetry = () => {
      const delay = Math.min(1000 * 2 ** failures.current, MAX_RETRY_DELAY_MS);
      failures.current += 1;
      setStatus("reconnecting");
      retryTimer = setTimeout(() => setAttempt((a) => a + 1), delay);
    };

    const connect = async () => {
      const info = await joinRef.current();
      if (cancelled) return;
      setJoinInfo(info);
      const options: RealmJoinOptions = { ticket: info.realmTicket, sessionId };
      const room = await client.joinOrCreate(REALM_ROOM_NAME, options);
      if (cancelled) {
        void room.leave();
        return;
      }
      failures.current = 0;
      roomRef.current = room;
      setSelfId(room.sessionId);
      setStatus("connected");
      setError(null);
      room.onStateChange((state) => {
        const json = (state as { toJSON(): SyncedState }).toJSON();
        setParticipants(Object.entries(json.participants ?? {}).map(([id, p]) => ({ id, ...p })));
        setLocked(json.locked);
      });
      room.onMessage(RealmMessage.pose, (bytes: Uint8Array) => {
        poseHub.ingest(bytes, performance.now());
      });
      room.onMessage(RealmMessage.emote, (msg: EmoteBroadcast) => {
        setEmotes((prev) => ({ ...prev, [msg.from]: { emote: msg.emote, at: Date.now() } }));
      });
      room.onMessage(RealmMessage.media, (grant: MediaGrant) => setMediaGrant(grant));
      room.onMessage(RealmMessage.notice, (notice: Notice) => {
        setNotices((prev) => [...prev.slice(-3), { ...notice, at: Date.now() }]);
      });
      room.onLeave((code) => {
        if (cancelled) return; // we left on purpose
        roomRef.current = null;
        poseHub.clear();
        setParticipants([]);
        setMediaGrant(null);
        if (code === RealmCloseCode.removed) setStatus("removed");
        else if (code === RealmCloseCode.sessionEnded) setStatus("ended");
        else scheduleRetry();
      });
    };

    connect().catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
      const terminal = terminalStatus(err);
      if (terminal) setStatus(terminal);
      else scheduleRetry();
    });

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      void roomRef.current?.leave();
      roomRef.current = null;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `attempt` triggers the rejoin
  }, [sessionId, attempt, poseHub]);

  const send = useCallback(<T>(type: string, message: T) => {
    roomRef.current?.send(type, message);
  }, []);

  const actions = useMemo(
    () => ({
      sendEmote: (emote: EmoteId) => send(RealmMessage.emote, { emote }),
      sendMediaState: (state: { micOn: boolean; cameraOn: boolean; connected: boolean }) =>
        send(RealmMessage.mediaState, state),
      /** Realm relay for poses, used when LiveKit's data channel can't reach everyone. */
      sendPose: (bytes: Uint8Array) => roomRef.current?.sendBytes(RealmMessage.pose, bytes),
      hostMute: (target: string) => send(RealmMessage.hostMute, { target }),
      hostCameraOff: (target: string) => send(RealmMessage.hostCameraOff, { target }),
      hostRemove: (target: string) => send(RealmMessage.hostRemove, { target }),
      setLocked: (value: boolean) => send(RealmMessage.setLocked, { locked: value }),
      setCoHost: (target: string, cohost: boolean) =>
        send(RealmMessage.setCoHost, { target, cohost }),
      endSession: () => send(RealmMessage.endSession, {}),
      /** Try again after a "locked" refusal. */
      retry: () => {
        setStatus("connecting");
        setAttempt((a) => a + 1);
      },
    }),
    [send],
  );

  return {
    status,
    error,
    participants,
    locked,
    selfId,
    joinInfo,
    mediaGrant,
    emotes,
    notices,
    poseHub,
    ...actions,
  };
}

export type RealmSession = ReturnType<typeof useRealmSession>;
