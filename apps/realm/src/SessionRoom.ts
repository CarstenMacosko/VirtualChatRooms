import { type AuthContext, type Client, Room, ServerError, validate } from "@colyseus/core";
import {
  ClientMessages,
  type EmoteBroadcast,
  type ParticipantRole,
  RealmJoinOptions,
  RealmMessage,
  type SessionClaims,
} from "@vcr/protocol";
import { verifySessionToken } from "./auth";
import { env } from "./env";
import { Participant, SessionState } from "./state";

/** MVP target: 25 people per session (PLAN.md § 10). */
export const MAX_PARTICIPANTS = 25;

/** One instance per live session, matched by `sessionId`. */
export class SessionRoom extends Room<{ state: SessionState }> {
  override maxClients = MAX_PARTICIPANTS;
  override state = new SessionState();

  override messages = {
    [RealmMessage.emote]: validate(ClientMessages.emote, (client, message) => {
      const broadcast: EmoteBroadcast = { from: client.sessionId, emote: message.emote };
      this.broadcast(RealmMessage.emote, broadcast);
    }),
  };

  override async onAuth(_client: Client, options: unknown, _context: AuthContext) {
    const parsed = RealmJoinOptions.safeParse(options);
    if (!parsed.success) throw new ServerError(400, "invalid join options");
    try {
      return await verifySessionToken(parsed.data.token, env.SESSION_TOKEN_SECRET);
    } catch {
      throw new ServerError(401, "invalid or expired session token");
    }
  }

  override onJoin(client: Client) {
    const claims = client.auth as SessionClaims;
    // Phase 0: the first person in becomes owner. From Phase 2 the API decides roles, because only
    // a room's owner may start a session in it (PLAN.md § 4.4).
    const role: ParticipantRole =
      this.state.participants.size === 0 ? "owner" : claims.kind === "guest" ? "guest" : "member";
    this.state.participants.set(
      client.sessionId,
      new Participant({ userId: claims.sub, name: claims.name, role }),
    );
  }

  override onLeave(client: Client) {
    this.state.participants.delete(client.sessionId);
    // Phase 2: when the owner and all co-hosts are gone, start the 2-minute "host left" grace period.
  }
}
