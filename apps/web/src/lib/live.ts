import { useEffect } from "react";
import { create } from "zustand";
import { LiveEvent } from "@vcr/protocol";
import { API_BASE } from "./api";
import { refreshSession, useAuth } from "./auth";

type Ring = Extract<LiveEvent, { type: "ring" }>;
type InviteResponse = Extract<LiveEvent, { type: "invite-response" }>;
type IncomingCall = Extract<LiveEvent, { type: "call" }>;

interface LiveStore {
  connected: boolean;
  /** Calls ringing right now, newest last. */
  rings: Ring[];
  /** People calling through your call link right now, newest last. */
  calls: IncomingCall[];
  /** Recent answers to calls you made, for toasts. */
  responses: (InviteResponse & { at: number })[];
  /** Bumped when contacts (or their presence) change, so screens refetch. */
  contactsVersion: number;
  /** Bumped when any session you're part of changes. */
  sessionsVersion: number;
  /** Bumped when one of your rooms changes (a scan finished processing, say). */
  roomsVersion: number;
  dismissRing(sessionId: string): void;
  dismissCall(callId: string): void;
  dismissResponse(at: number): void;
}

export const useLive = create<LiveStore>((set) => ({
  connected: false,
  rings: [],
  calls: [],
  responses: [],
  contactsVersion: 0,
  sessionsVersion: 0,
  roomsVersion: 0,
  dismissRing: (sessionId) =>
    set((s) => ({ rings: s.rings.filter((r) => r.sessionId !== sessionId) })),
  dismissCall: (callId) => set((s) => ({ calls: s.calls.filter((c) => c.callId !== callId) })),
  dismissResponse: (at) => set((s) => ({ responses: s.responses.filter((r) => r.at !== at) })),
}));

function apply(event: LiveEvent) {
  useLive.setState((s) => {
    switch (event.type) {
      case "ring":
        return {
          rings: [...s.rings.filter((r) => r.sessionId !== event.sessionId), event],
          sessionsVersion: s.sessionsVersion + 1,
        };
      case "ring-cancelled":
      case "session-ended":
        return {
          rings: s.rings.filter((r) => r.sessionId !== event.sessionId),
          sessionsVersion: s.sessionsVersion + 1,
        };
      case "invite-response":
        return {
          responses: [...s.responses.slice(-4), { ...event, at: Date.now() }],
          sessionsVersion: s.sessionsVersion + 1,
        };
      case "contacts-changed":
        return { contactsVersion: s.contactsVersion + 1 };
      case "call":
        return { calls: [...s.calls.filter((c) => c.callId !== event.callId), event] };
      case "call-ended":
        // Recents show how it ended.
        return {
          calls: s.calls.filter((c) => c.callId !== event.callId),
          sessionsVersion: s.sessionsVersion + 1,
        };
      case "rooms-changed":
        return { roomsVersion: s.roomsVersion + 1 };
    }
  });
}

/** Parses `data:` lines out of a server-sent event stream, calling `onData` per event. */
async function readEvents(body: ReadableStream<Uint8Array>, onData: (data: string) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop()!;
    for (const frame of frames) {
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data) onData(data);
    }
  }
}

/**
 * Keeps `GET /events` open while signed in (being connected is what makes you "online" to your
 * contacts), reconnecting with backoff. Uses fetch rather than EventSource so it can send the
 * Authorization header.
 */
export function useLiveEvents(token: string) {
  useEffect(() => {
    const controller = new AbortController();
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      try {
        const res = await fetch(`${API_BASE}/events`, {
          headers: { authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (res.status === 401) {
          // A renewed session gets a new token, which restarts this effect.
          if (!(await refreshSession())) useAuth.getState().signOut();
          return;
        }
        if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
        failures = 0;
        useLive.setState((s) => ({
          connected: true,
          // Catch up on anything missed while disconnected.
          contactsVersion: s.contactsVersion + 1,
          sessionsVersion: s.sessionsVersion + 1,
          roomsVersion: s.roomsVersion + 1,
        }));
        await readEvents(res.body, (data) => {
          const event = LiveEvent.safeParse(JSON.parse(data));
          if (event.success) apply(event.data);
        });
      } catch {
        // network error or aborted; fall through to reconnect
      }
      useLive.setState({ connected: false });
      if (controller.signal.aborted) return;
      retry = setTimeout(connect, Math.min(1000 * 2 ** failures++, 15_000));
    };
    void connect();

    return () => {
      controller.abort();
      clearTimeout(retry);
      useLive.setState({ connected: false, rings: [], calls: [] });
    };
  }, [token]);
}
