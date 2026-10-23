import {
  type AuthContext,
  type Client,
  type Delayed,
  Room,
  ServerError,
  validate,
} from "@colyseus/core";
import {
  canModerate,
  ClientMessages,
  decodePose,
  encodeRelayedPose,
  type ChatBroadcast,
  type RoomChangedBroadcast,
  type EmoteBroadcast,
  HOST_ARRIVAL_MS,
  HOST_GRACE_MS,
  MAX_POSE_BYTES,
  type Notice,
  type ParticipantRole,
  RealmCloseCode,
  RealmJoinError,
  RealmJoinOptions,
  RealmMessage,
  type RealmTicketClaims,
  type SitResult,
} from "@vcr/protocol";
import { issueInternalToken, verifyRealmTicket } from "./auth";
import { env } from "./env";
import { GAME_TICK_MS, TableGamesHost } from "./games";
import { MediaControl } from "./media";
import { claimSeat, releaseSeats } from "./seats";
import { Participant, SessionState } from "./state";

/** MVP target: 25 people per session (PLAN.md § 10). */
export const MAX_PARTICIPANTS = 25;

/**
 * Poses and table-game drags each arrive at up to 15 Hz, plus occasional emotes and moves;
 * clients far above this get disconnected.
 */
const MAX_MESSAGES_PER_SECOND = 40;

const media = new MediaControl(env.LIVEKIT_URL, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET);

const isHost = (role: string) => role === "owner" || role === "cohost";

/**
 * One instance per live session, matched by `sessionId`. The API decides who may enter (realm
 * tickets); this room enforces the rest: lock, removals, host controls, and ending the session
 * when no host has been present for a while (PLAN.md § 4.4).
 */
export class SessionRoom extends Room<{ state: SessionState }> {
  override maxClients = MAX_PARTICIPANTS;
  override state = new SessionState();
  override maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;
  // The room outlives brief moments with nobody in it; endSession() disposes it.
  override autoDispose = false;

  /** The API's session id; also the LiveKit room name. */
  private sessionKey = "";
  /** Account ids a host removed; they can't come back into this session. */
  private removed = new Set<string>();
  /** Account ids promoted to co-host, so they keep the role if they reconnect. */
  private cohosts = new Set<string>();
  /**
   * Who hosts right now. Starts as the room owner from their ticket; "transfer host" moves it, and
   * the original owner then counts as a co-host, including after reconnecting.
   */
  private hostUserId: string | null = null;
  private hostAbsence: Delayed | null = null;
  private ended = false;
  /** Jigsaws and other table games; they last as long as the session. */
  private games = new TableGamesHost(this.state);

  override messages = {
    [RealmMessage.emote]: validate(ClientMessages.emote, (client, message) => {
      const broadcast: EmoteBroadcast = { from: client.sessionId, emote: message.emote };
      this.broadcast(RealmMessage.emote, broadcast);
    }),

    [RealmMessage.chat]: validate(ClientMessages.chat, (client, { text }) => {
      const p = this.state.participants.get(client.sessionId);
      if (!p) return;
      const broadcast: ChatBroadcast = {
        from: client.sessionId,
        name: p.name,
        text,
        at: Date.now(),
      };
      this.broadcast(RealmMessage.chat, broadcast);
    }),

    [RealmMessage.roomChanged]: validate(ClientMessages.roomChanged, (client) => {
      const p = this.state.participants.get(client.sessionId);
      if (!p || !isHost(p.role)) return;
      const broadcast: RoomChangedBroadcast = { by: client.sessionId };
      this.broadcast(RealmMessage.roomChanged, broadcast);
      // Seat ids belong to the old room's layout.
      this.state.seats.clear();
    }),

    [RealmMessage.sit]: validate(ClientMessages.sit, (client, { seatId }) => {
      if (!this.state.participants.has(client.sessionId)) return;
      const result: SitResult = {
        seatId,
        ok: claimSeat(this.state.seats, seatId, client.sessionId),
      };
      client.send(RealmMessage.sit, result);
    }),

    [RealmMessage.stand]: validate(ClientMessages.stand, (client) => {
      releaseSeats(this.state.seats, client.sessionId);
    }),

    [RealmMessage.raiseHand]: validate(ClientMessages.raiseHand, (client, { raised }) => {
      const p = this.state.participants.get(client.sessionId);
      if (p) p.handRaised = raised;
    }),

    [RealmMessage.mediaState]: validate(ClientMessages.mediaState, (client, message) => {
      const p = this.state.participants.get(client.sessionId);
      if (!p) return;
      p.muted = !message.micOn;
      p.cameraOn = message.cameraOn;
      p.onMedia = message.connected;
    }),

    [RealmMessage.setAvatar]: validate(ClientMessages.setAvatar, (client, { recipe }) => {
      const p = this.state.participants.get(client.sessionId);
      if (p) p.avatar = JSON.stringify(recipe);
    }),

    [RealmMessage.hostMute]: validate(ClientMessages.hostMute, (client, { target }) => {
      const p = this.moderate(client, target);
      if (!p) return;
      p.muted = true;
      this.notify(target, { kind: "mutedByHost", by: client.sessionId });
      this.media(() => media.muteMicrophone(this.sessionKey, target));
    }),

    [RealmMessage.hostCameraOff]: validate(ClientMessages.hostCameraOff, (client, { target }) => {
      const p = this.moderate(client, target);
      if (!p) return;
      p.cameraOn = false;
      this.notify(target, { kind: "cameraOffByHost", by: client.sessionId });
      this.media(() => media.muteCamera(this.sessionKey, target));
    }),

    [RealmMessage.hostRemove]: validate(ClientMessages.hostRemove, (client, { target }) => {
      const p = this.moderate(client, target);
      if (!p) return;
      this.removed.add(p.userId);
      this.cohosts.delete(p.userId);
      this.clients.getById(target)?.leave(RealmCloseCode.removed);
      this.media(() => media.remove(this.sessionKey, target));
    }),

    [RealmMessage.setLocked]: validate(ClientMessages.setLocked, (client, { locked }) => {
      const actor = this.state.participants.get(client.sessionId);
      if (actor && isHost(actor.role)) this.state.locked = locked;
    }),

    [RealmMessage.setCoHost]: validate(ClientMessages.setCoHost, (client, { target, cohost }) => {
      const actor = this.state.participants.get(client.sessionId);
      const p = this.state.participants.get(target);
      if (actor?.role !== "owner" || !p) return;
      if (cohost && p.role === "member") {
        p.role = "cohost";
        this.cohosts.add(p.userId);
        this.notify(target, { kind: "promoted", by: client.sessionId });
      } else if (!cohost && p.role === "cohost") {
        p.role = "member";
        this.cohosts.delete(p.userId);
        this.notify(target, { kind: "demoted", by: client.sessionId });
      }
    }),

    [RealmMessage.transferHost]: validate(ClientMessages.transferHost, (client, { target }) => {
      const actor = this.state.participants.get(client.sessionId);
      const p = this.state.participants.get(target);
      if (actor?.role !== "owner" || !p || p === actor || p.role === "guest") return;
      this.hostUserId = p.userId;
      this.cohosts.delete(p.userId);
      this.cohosts.add(actor.userId);
      // Every connection of each person (someone may have two tabs open) gets the new role.
      for (const other of this.state.participants.values()) {
        if (other.userId === p.userId) other.role = "owner";
        else if (other.userId === actor.userId) other.role = "cohost";
      }
      this.notify(target, { kind: "nowHost", by: client.sessionId });
    }),

    [RealmMessage.endSession]: validate(ClientMessages.endSession, (client) => {
      if (this.state.participants.get(client.sessionId)?.role === "owner") void this.endSession();
    }),

    // Table games (ADR 0021): anyone in the session can play, start or clear a table.
    [RealmMessage.gameStart]: validate(ClientMessages.gameStart, (_client, message) => {
      this.games.start(message);
    }),

    [RealmMessage.gameAction]: validate(ClientMessages.gameAction, (client, message) => {
      this.games.act(client.sessionId, message, Date.now());
    }),

    [RealmMessage.gameEnd]: validate(ClientMessages.gameEnd, (_client, message) => {
      this.games.end(message);
    }),

    [RealmMessage.gameDrag]: validate(ClientMessages.gameDrag, (client, message) => {
      const relay = this.games.drag(client.sessionId, message, Date.now());
      if (relay) this.broadcast(RealmMessage.gameDrag, relay, { except: client });
    }),
  };

  override onCreate(options: unknown) {
    this.sessionKey = RealmJoinOptions.shape.sessionId.parse(
      (options as { sessionId?: unknown }).sessionId,
    );
    // If the owner never shows up, don't keep the room open forever.
    this.hostAbsence = this.clock.setTimeout(() => void this.endSession(), HOST_ARRIVAL_MS);
    this.clock.setInterval(() => this.games.tick(Date.now()), GAME_TICK_MS);

    // Fallback pose relay, used while a client has no LiveKit data channel (ADR 0006): validate,
    // stamp with the sender, forward to everyone else.
    this.onMessageBytes(RealmMessage.pose, (client, bytes: Uint8Array) => {
      if (bytes.byteLength > MAX_POSE_BYTES) return;
      try {
        decodePose(bytes);
      } catch {
        return; // malformed or from an incompatible client version
      }
      this.broadcastBytes(RealmMessage.pose, encodeRelayedPose(client.sessionId, bytes), {
        except: client,
      });
    });
  }

  override async onAuth(_client: Client, options: unknown, _context: AuthContext) {
    const parsed = RealmJoinOptions.safeParse(options);
    if (!parsed.success) throw new ServerError(RealmJoinError.invalid, "invalid join options");
    let claims: RealmTicketClaims;
    try {
      claims = await verifyRealmTicket(parsed.data.ticket, env.SESSION_TOKEN_SECRET);
    } catch {
      throw new ServerError(RealmJoinError.badTicket, "invalid or expired ticket");
    }
    if (claims.sessionId !== this.sessionKey) {
      throw new ServerError(RealmJoinError.invalid, "ticket is for another session");
    }
    if (this.ended) throw new ServerError(RealmJoinError.ended, "this gathering has ended");
    if (this.removed.has(claims.sub)) {
      throw new ServerError(RealmJoinError.removed, "a host removed you from this gathering");
    }
    if (this.state.locked && !isHost(this.roleFor(claims))) {
      throw new ServerError(RealmJoinError.locked, "the host locked this gathering");
    }
    return claims;
  }

  override async onJoin(client: Client) {
    const claims = client.auth as RealmTicketClaims;
    const role = this.roleFor(claims);
    this.state.participants.set(
      client.sessionId,
      new Participant({
        userId: claims.sub,
        name: claims.name,
        role,
        avatar: claims.avatar ? JSON.stringify(claims.avatar) : "",
      }),
    );
    if (isHost(role)) this.cancelHostAbsence();

    try {
      client.send(
        RealmMessage.media,
        await media.grant(this.sessionKey, client.sessionId, claims.name),
      );
    } catch (err) {
      console.warn("[realm] could not mint a media token", err);
      client.send(RealmMessage.media, { url: null, token: null });
    }
  }

  override onLeave(client: Client) {
    this.state.participants.delete(client.sessionId);
    releaseSeats(this.state.seats, client.sessionId);
    this.games.leave(client.sessionId);
    if (this.ended || this.hostAbsence) return;
    const hostPresent = [...this.state.participants.values()].some((p) => isHost(p.role));
    if (!hostPresent) {
      this.hostAbsence = this.clock.setTimeout(() => void this.endSession(), HOST_GRACE_MS);
    }
  }

  /** The role someone has in this room: their ticket's, unless the owner promoted them. */
  private roleFor(claims: RealmTicketClaims): ParticipantRole {
    if (claims.role === "guest") return "guest";
    if (claims.role === "owner" && this.hostUserId === null) this.hostUserId = claims.sub;
    if (claims.sub === this.hostUserId) return "owner";
    if (claims.role === "owner" || this.cohosts.has(claims.sub)) return "cohost";
    return "member";
  }

  /** The target participant, if `client` may moderate them. */
  private moderate(client: Client, target: string) {
    const actor = this.state.participants.get(client.sessionId);
    const p = this.state.participants.get(target);
    if (!actor || !p || target === client.sessionId) return null;
    if (!canModerate(actor.role as ParticipantRole, p.role as ParticipantRole)) return null;
    return p;
  }

  private notify(target: string, notice: Notice) {
    this.clients.getById(target)?.send(RealmMessage.notice, notice);
  }

  /** Runs a LiveKit server call without letting a media outage break room logic. */
  private media(call: () => Promise<unknown>) {
    call().catch((err: unknown) => console.warn("[realm] LiveKit call failed", err));
  }

  private cancelHostAbsence() {
    this.hostAbsence?.clear();
    this.hostAbsence = null;
  }

  /** Ends the session for everyone and tells the API, which tells anyone still being rung. */
  private async endSession() {
    if (this.ended) return;
    this.ended = true;
    this.cancelHostAbsence();
    for (const client of this.clients) client.leave(RealmCloseCode.sessionEnded);
    await this.reportEnded();
    await this.disconnect(RealmCloseCode.sessionEnded);
  }

  private async reportEnded() {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${env.API_URL}/internal/sessions/${this.sessionKey}/ended`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${await issueInternalToken(env.SESSION_TOKEN_SECRET)}`,
          },
        });
        if (res.ok) return;
      } catch {
        // API unreachable; retry below
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
    console.warn(`[realm] could not report session ${this.sessionKey} ended`);
  }
}
