import { type FormEvent, useEffect, useRef, useState } from "react";
import type { GuestLinkInfo, JoinSessionResponse } from "@vcr/protocol";
import { api, ApiRequestError } from "../lib/api";
import { navigate } from "../lib/router";
import { SessionScreen } from "./SessionScreen";

/**
 * `/join/<token>`: joining without an account (e.g. a child on a parent's device). Only a display
 * name is asked for, and nothing about the guest is stored.
 */
export function GuestJoin({ token }: { token: string }) {
  const [info, setInfo] = useState<GuestLinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [first, setFirst] = useState<JoinSessionResponse | null>(null);
  const firstUsed = useRef(false);

  useEffect(() => {
    api
      .guestLink(token)
      .then(setInfo)
      .catch((err: unknown) =>
        setError(err instanceof ApiRequestError ? err.message : "Couldn't open this link."),
      );
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      setFirst(await api.guestJoin(token, name));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't join.");
    }
  }

  if (first) {
    return (
      <SessionScreen
        sessionId={first.sessionId}
        // Reuse the ticket we just got for the first join; reconnects ask for a fresh one.
        join={() => {
          if (!firstUsed.current) {
            firstUsed.current = true;
            return Promise.resolve(first);
          }
          return api.guestJoin(token, name);
        }}
        title={info ? `${info.hostName}'s gathering` : "Gathering"}
        subtitle={info?.roomName}
        displayName={name}
        isGuest
        onExit={() => {
          setFirst(null);
          firstUsed.current = false;
          navigate("/", { replace: true });
        }}
      />
    );
  }

  return (
    <main className="signin">
      <form className="card" onSubmit={submit}>
        <h1>{info ? `Join ${info.hostName}'s gathering` : "Join a gathering"}</h1>
        {info && !info.live && <p className="error">This gathering has ended.</p>}
        {info?.live && <p className="muted">In {info.roomName}. You'll join as a guest.</p>}
        {error && <p className="error">{error}</p>}
        <label>
          Your name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            required
            autoFocus
          />
          <span className="hint">Only shown to people in this gathering. Nothing is saved.</span>
        </label>
        <button type="submit" disabled={!info?.live || !name.trim()}>
          Continue
        </button>
      </form>
    </main>
  );
}
