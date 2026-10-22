import type { ServerResponse } from "node:http";
import type { LiveEvent } from "@vcr/protocol";

/**
 * In-process fan-out of live events to signed-in users' open `GET /events` streams. Being
 * connected is what "online" means for contacts.
 *
 * Single API instance only. Running several needs a shared bus (Redis pub/sub) in front of this;
 * the interface stays the same.
 */
export class LiveHub {
  private streams = new Map<string, Set<ServerResponse>>();
  private presenceListeners = new Set<(userId: string, online: boolean) => void>();

  isOnline(userId: string) {
    return (this.streams.get(userId)?.size ?? 0) > 0;
  }

  onPresenceChange(listener: (userId: string, online: boolean) => void) {
    this.presenceListeners.add(listener);
  }

  /** Registers a stream and returns the function that unregisters it. */
  attach(userId: string, stream: ServerResponse): () => void {
    let set = this.streams.get(userId);
    if (!set) {
      set = new Set();
      this.streams.set(userId, set);
    }
    set.add(stream);
    if (set.size === 1) this.emitPresence(userId, true);
    return () => {
      const current = this.streams.get(userId);
      if (!current?.delete(stream)) return;
      if (current.size === 0) {
        this.streams.delete(userId);
        this.emitPresence(userId, false);
      }
    };
  }

  send(userId: string, event: LiveEvent) {
    const set = this.streams.get(userId);
    if (!set) return;
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of set) stream.write(frame);
  }

  sendMany(userIds: Iterable<string>, event: LiveEvent) {
    for (const id of userIds) this.send(id, event);
  }

  /** Ends every open stream, e.g. on shutdown, so `app.close()` doesn't wait on them. */
  closeAll() {
    for (const set of this.streams.values()) for (const stream of set) stream.end();
    this.streams.clear();
  }

  private emitPresence(userId: string, online: boolean) {
    for (const listener of this.presenceListeners) listener(userId, online);
  }
}
