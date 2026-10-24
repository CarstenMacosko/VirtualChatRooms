import { Client, type Room } from "@colyseus/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PoseHub } from "@vcr/engine";
import {
  type ChatBroadcast,
  type EmoteBroadcast,
  type EmoteId,
  type GameDragBroadcast,
  type GameTableView,
  type JoinSessionResponse,
  type MediaGrant,
  type Notice,
  type ParticipantView,
  REALM_ROOM_NAME,
  RealmCloseCode,
  RealmJoinError,
  type RealmJoinOptions,
  RealmMessage,
  type SitResult,
} from "@vcr/protocol";
import { ApiRequestError } from "./api";
import { TableGamesSync } from "./tableGames";

/** The realm server: same origin as the page (proxied at /realm) unless configured otherwise. */
const REALM_URL = import.meta.env.VITE_REALM_URL || `${window.location.origin}/realm`;

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
/** How long to wait for the realm to answer a seat claim. */
const SIT_TIMEOUT_MS = 3000;

interface SyncedState {
  participants: Record<string, Omit<ParticipantView, "id">>;
  locked: boolean;
  /** Seat id → realm session id of whoever sits there. */
  seats?: Record<string, string>;
  games?: Record<string, GameTableView>;
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
  const [seats, setSeats] = useState<Record<string, string>>({});
  /** Seat claims waiting for the realm's answer, by seat id. */
  const sitting = useRef(new Map<number, (ok: boolean | null) => void>());
  const [selfId, setSelfId] = useState<string | null>(null);
  const [joinInfo, setJoinInfo] = useState<JoinSessionResponse | null>(null);
  const [mediaGrant, setMediaGrant] = useState<MediaGrant | null>(null);
  const [emotes, setEmotes] = useState<Record<string, ActiveEmote>>({});
  const [notices, setNotices] = useState<RealmNotice[]>([]);
  const [chat, setChat] = useState<ChatBroadcast[]>([]);
  const roomRef = useRef<Room | null>(null);
  const [poseHub] = useState(() => new PoseHub());
  const [games] = useState(() => new TableGamesSync());
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
      games.connect((type, message) => room.send(type, message));
      // Table games patch state often (every piece moved); only re-render people when they change.
      let peopleJson = "";
      let seatsJson = "";
      room.onStateChange((state) => {
        const json = (state as { toJSON(): SyncedState }).toJSON();
        const people = JSON.stringify(json.participants ?? {});
        if (people !== peopleJson) {
          peopleJson = people;
          setParticipants(Object.entries(json.participants ?? {}).map(([id, p]) => ({ id, ...p })));
        }
        setLocked(json.locked);
        const seatClaims = JSON.stringify(json.seats ?? {});
        if (seatClaims !== seatsJson) {
          seatsJson = seatClaims;
          setSeats(json.seats ?? {});
        }
        games.ingest(json.games);
      });
      room.onMessage(RealmMessage.gameDrag, (message: GameDragBroadcast) => {
        games.ingestDrag(message);
      });
      room.onMessage(RealmMessage.pose, (bytes: Uint8Array) => {
        poseHub.ingest(bytes, performance.now());
      });
      room.onMessage(RealmMessage.emote, (msg: EmoteBroadcast) => {
        setEmotes((prev) => ({ ...prev, [msg.from]: { emote: msg.emote, at: Date.now() } }));
      });
      room.onMessage(RealmMessage.media, (grant: MediaGrant) => setMediaGrant(grant));
      // The host moved the gathering: fetch the new room's assets (same realm connection).
      room.onMessage(RealmMessage.roomChanged, () => {
        void joinRef.current().then(
          (next) => !cancelled && setJoinInfo(next),
          () => {},
        );
      });
      room.onMessage(RealmMessage.sit, (result: SitResult) => {
        sitting.current.get(result.seatId)?.(result.ok);
        sitting.current.delete(result.seatId);
      });
      room.onMessage(RealmMessage.chat, (message: ChatBroadcast) => {
        setChat((prev) => [...prev.slice(-199), message]);
      });
      room.onMessage(RealmMessage.notice, (notice: Notice) => {
        setNotices((prev) => [...prev.slice(-3), { ...notice, at: Date.now() }]);
      });
      room.onLeave((code) => {
        if (cancelled) return; // we left on purpose
        roomRef.current = null;
        poseHub.clear();
        games.disconnect();
        setParticipants([]);
        setSeats({});
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
  }, [sessionId, attempt, poseHub, games]);

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
      transferHost: (target: string) => send(RealmMessage.transferHost, { target }),
      endSession: () => send(RealmMessage.endSession, {}),
      sendChat: (text: string) => send(RealmMessage.chat, { text }),
      raiseHand: (raised: boolean) => send(RealmMessage.raiseHand, { raised }),
      /**
       * Claims a seat of the room's layout: true once it's yours, false if someone's sitting
       * there, null if the realm didn't answer (not connected).
       */
      sit: (seatId: number) =>
        new Promise<boolean | null>((resolve) => {
          const room = roomRef.current;
          if (!room) return resolve(null);
          sitting.current.get(seatId)?.(null);
          const timer = setTimeout(() => {
            sitting.current.delete(seatId);
            resolve(null);
          }, SIT_TIMEOUT_MS);
          sitting.current.set(seatId, (ok) => {
            clearTimeout(timer);
            resolve(ok);
          });
          room.send(RealmMessage.sit, { seatId });
        }),
      /** Gets up: frees your seat. */
      stand: () => send(RealmMessage.stand, {}),
      /** Host, after the API moved the session: everyone (you included) loads the new room. */
      announceRoomChange: () => send(RealmMessage.roomChanged, {}),
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
    seats,
    selfId,
    joinInfo,
    mediaGrant,
    emotes,
    notices,
    chat,
    poseHub,
    games,
    ...actions,
  };
}

export type RealmSession = ReturnType<typeof useRealmSession>;
