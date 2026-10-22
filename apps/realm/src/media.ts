import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import type { MediaGrant } from "@vcr/protocol";

const TOKEN_TTL_SECONDS = 6 * 60 * 60;

/**
 * The realm's side of LiveKit: it mints each participant's media token (so only people the realm
 * admitted can join the media room) and enforces host controls server-side (PLAN.md § 4.4).
 * The LiveKit room is named after the session id; a participant's identity is their realm
 * connection id, so poses, tracks and realm state all share one key.
 */
export class MediaControl {
  private rooms: RoomServiceClient | null;

  constructor(
    private url: string,
    private apiKey: string,
    private apiSecret: string,
  ) {
    // RoomServiceClient speaks HTTP to the same host LiveKit's WebSocket listens on.
    this.rooms = url ? new RoomServiceClient(url.replace(/^ws/, "http"), apiKey, apiSecret) : null;
  }

  async grant(room: string, identity: string, name: string): Promise<MediaGrant> {
    if (!this.url) return { url: null, token: null };
    const at = new AccessToken(this.apiKey, this.apiSecret, {
      identity,
      name,
      ttl: TOKEN_TTL_SECONDS,
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canUpdateOwnMetadata: false,
    });
    return { url: this.url, token: await at.toJwt() };
  }

  muteMicrophone(room: string, identity: string) {
    return this.muteSource(room, identity, TrackSource.MICROPHONE);
  }

  muteCamera(room: string, identity: string) {
    return this.muteSource(room, identity, TrackSource.CAMERA);
  }

  async remove(room: string, identity: string) {
    await this.rooms?.removeParticipant(room, identity);
  }

  private async muteSource(room: string, identity: string, source: TrackSource) {
    if (!this.rooms) return;
    const participant = await this.rooms.getParticipant(room, identity);
    for (const track of participant.tracks) {
      if (track.source === source && !track.muted) {
        await this.rooms.mutePublishedTrack(room, identity, track.sid, true);
      }
    }
  }
}
