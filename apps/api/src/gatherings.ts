import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { RING_TIMEOUT_MS, type SessionInfo } from "@vcr/protocol";
import type { Database } from "./db/client";
import { rooms, sessionInvites, sessions, users } from "./db/schema";
import type { LiveHub } from "./live";

/**
 * Live sessions ("gatherings"), their invites and ringing (PLAN.md § 4.4). Ring timers live in
 * memory; on restart, stale rings are marked missed by `expireStaleRings`.
 */
export class Gatherings {
  private ringTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private db: Database,
    private live: LiveHub,
    private ringTimeoutMs = RING_TIMEOUT_MS,
  ) {}

  /** Rings each invitee now; unanswered rings become "missed" after the timeout. */
  ring(
    sessionId: string,
    inviteeIds: readonly string[],
    host: { id: string; displayName: string },
    roomName: string,
  ) {
    for (const inviteeId of inviteeIds) {
      this.live.send(inviteeId, { type: "ring", sessionId, from: host, roomName });
      const key = `${sessionId}:${inviteeId}`;
      clearTimeout(this.ringTimers.get(key));
      this.ringTimers.set(
        key,
        setTimeout(() => {
          this.ringTimers.delete(key);
          void this.respond(sessionId, inviteeId, "missed", ["ringing"]).catch(() => {});
        }, this.ringTimeoutMs),
      );
    }
  }

  /**
   * Moves an invite to `status` if it is currently in one of `from`, stops ringing on every device
   * of the invitee, and tells the host. Returns whether the invite changed.
   */
  async respond(
    sessionId: string,
    inviteeId: string,
    status: "accepted" | "declined" | "missed",
    from: ReadonlyArray<"ringing" | "accepted" | "declined" | "missed">,
  ): Promise<boolean> {
    const [updated] = await this.db
      .update(sessionInvites)
      .set({ status, respondedAt: new Date() })
      .where(
        and(
          eq(sessionInvites.sessionId, sessionId),
          eq(sessionInvites.inviteeId, inviteeId),
          inArray(sessionInvites.status, [...from]),
        ),
      )
      .returning();
    if (!updated) return false;

    const key = `${sessionId}:${inviteeId}`;
    clearTimeout(this.ringTimers.get(key));
    this.ringTimers.delete(key);
    this.live.send(inviteeId, { type: "ring-cancelled", sessionId });

    const [row] = await this.db
      .select({ hostId: sessions.hostId, displayName: users.displayName })
      .from(sessions)
      .innerJoin(users, eq(users.id, inviteeId))
      .where(eq(sessions.id, sessionId));
    if (row) {
      this.live.send(row.hostId, {
        type: "invite-response",
        sessionId,
        userId: inviteeId,
        displayName: row.displayName,
        status,
      });
    }
    return true;
  }

  /** Marks a session ended and tells everyone it involved. Returns whether it was still live. */
  async end(sessionId: string): Promise<boolean> {
    const [ended] = await this.db
      .update(sessions)
      .set({ status: "ended", endedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), eq(sessions.status, "live")))
      .returning();
    if (!ended) return false;

    const invites = await this.db
      .select()
      .from(sessionInvites)
      .where(eq(sessionInvites.sessionId, sessionId));
    for (const invite of invites) {
      const key = `${sessionId}:${invite.inviteeId}`;
      clearTimeout(this.ringTimers.get(key));
      this.ringTimers.delete(key);
      if (invite.status === "ringing") {
        this.live.send(invite.inviteeId, { type: "ring-cancelled", sessionId });
      }
    }
    await this.db
      .update(sessionInvites)
      .set({ status: "missed", respondedAt: new Date() })
      .where(and(eq(sessionInvites.sessionId, sessionId), eq(sessionInvites.status, "ringing")));

    this.live.sendMany([ended.hostId, ...invites.map((i) => i.inviteeId)], {
      type: "session-ended",
      sessionId,
    });
    return true;
  }

  /** On startup: rings whose timers were lost with the previous process count as missed. */
  async expireStaleRings() {
    await this.db
      .update(sessionInvites)
      .set({ status: "missed", respondedAt: new Date() })
      .where(
        and(
          eq(sessionInvites.status, "ringing"),
          lt(sessionInvites.createdAt, new Date(Date.now() - this.ringTimeoutMs)),
        ),
      );
  }

  async info(sessionId: string): Promise<SessionInfo | null> {
    const [row] = await this.db
      .select({ session: sessions, room: rooms, hostName: users.displayName })
      .from(sessions)
      .innerJoin(rooms, eq(rooms.id, sessions.roomId))
      .innerJoin(users, eq(users.id, sessions.hostId))
      .where(eq(sessions.id, sessionId));
    if (!row) return null;
    const invites = await this.db
      .select({
        userId: sessionInvites.inviteeId,
        displayName: users.displayName,
        status: sessionInvites.status,
      })
      .from(sessionInvites)
      .innerJoin(users, eq(users.id, sessionInvites.inviteeId))
      .where(eq(sessionInvites.sessionId, sessionId))
      .orderBy(users.displayName);
    return {
      id: row.session.id,
      status: row.session.status,
      room: { id: row.room.id, name: row.room.name, kind: row.room.kind },
      host: { id: row.session.hostId, displayName: row.hostName },
      invites,
      createdAt: row.session.createdAt.toISOString(),
    };
  }

  /** Live sessions `userId` hosts or was invited to, newest first. */
  async liveFor(userId: string): Promise<SessionInfo[]> {
    const invited = this.db
      .select({ id: sessionInvites.sessionId })
      .from(sessionInvites)
      .where(eq(sessionInvites.inviteeId, userId));
    const rows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.status, "live"),
          or(eq(sessions.hostId, userId), inArray(sessions.id, invited)),
        ),
      )
      .orderBy(desc(sessions.createdAt));
    const infos = await Promise.all(rows.map((r) => this.info(r.id)));
    return infos.filter((i): i is SessionInfo => i !== null);
  }

  dispose() {
    for (const timer of this.ringTimers.values()) clearTimeout(timer);
    this.ringTimers.clear();
  }
}
