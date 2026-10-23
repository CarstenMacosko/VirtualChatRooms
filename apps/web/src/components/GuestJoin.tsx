import { type FormEvent, useEffect, useRef, useState } from "react";
import { recipeForSeed } from "@vcr/avatar";
import type { AvatarRecipe, GuestLinkInfo, JoinSessionResponse } from "@vcr/protocol";
import { api, ApiRequestError } from "../lib/api";
import { loadGuestAvatar, saveGuestAvatar } from "../lib/avatar";
import { navigate } from "../lib/router";
import { AvatarCreator } from "./AvatarCreator";
import { SessionScreen } from "./SessionScreen";
import { Avatar } from "./ui";

const GUEST_NAME = "vcr.guestName";

/**
 * `/join/<token>`: joining without an account (e.g. a child on a parent's device). Only a display
 * name is asked for, and nothing about the guest is stored. An avatar is optional.
 */
export function GuestJoin({ token }: { token: string }) {
  const [info, setInfo] = useState<GuestLinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(GUEST_NAME) ?? "";
    } catch {
      return "";
    }
  });
  const [step, setStep] = useState<"name" | "avatar" | "call">("name");
  const [avatar, setAvatar] = useState<AvatarRecipe | null>(loadGuestAvatar);
  const [first, setFirst] = useState<JoinSessionResponse | null>(null);
  const firstUsed = useRef(false);
  const firstAt = useRef(0);
  const [busy, setBusy] = useState(false);

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
      localStorage.setItem(GUEST_NAME, name.trim());
    } catch {
      // fine
    }
    setBusy(true);
    setError(null);
    try {
      setFirst(await api.guestJoin(token, name.trim(), avatar));
      firstAt.current = Date.now();
      firstUsed.current = false;
      setStep("call");
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't join.");
    } finally {
      setBusy(false);
    }
  }

  if (step === "call" && first) {
    return (
      <SessionScreen
        sessionId={first.sessionId}
        // Reuse the ticket we just got for the first join; reconnects ask for a fresh one.
        join={() => {
          // Tickets last 10 minutes; the pre-join check may have taken a while.
          if (!firstUsed.current && Date.now() - firstAt.current < 5 * 60_000) {
            firstUsed.current = true;
            return Promise.resolve(first);
          }
          return api.guestJoin(token, name.trim(), avatar);
        }}
        title={info ? `${info.hostName}'s call` : "Call"}
        subtitle={info?.roomName}
        displayName={name.trim()}
        isGuest
        onExit={() => {
          setFirst(null);
          setStep("name");
          navigate("/", { replace: true });
        }}
      />
    );
  }

  if (step === "avatar") {
    return (
      <AvatarCreator
        initial={avatar ?? recipeForSeed(`${name}:${token}`)}
        title="Your avatar"
        intro="How you appear in the 3D room. It's saved on this device only."
        saveLabel="Done"
        secondaryLabel="Back"
        onSecondary={() => setStep("name")}
        onSave={async (recipe) => {
          saveGuestAvatar(recipe);
          setAvatar(recipe);
          setStep("name");
        }}
      />
    );
  }

  return (
    <main className="portal center-page">
      <form className="card link-card" onSubmit={submit}>
        {info && <Avatar name={info.hostName} id={info.hostName} size={72} />}
        <h1>{info ? `Join ${info.hostName}'s call` : "Join a call"}</h1>
        {info && !info.live && <p className="callout warn">This call has ended.</p>}
        {info?.live && <p className="muted">You'll join as a guest. No account needed.</p>}
        {error && <p className="error">{error}</p>}
        <label>
          Your name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            required
            autoFocus
            autoComplete="name"
          />
          <span className="hint">Only shown to people in this call. Nothing is saved.</span>
        </label>
        <button
          type="submit"
          className="primary big"
          disabled={!info?.live || !name.trim() || busy}
        >
          {busy ? "Joining…" : "Continue"}
        </button>
        <button
          type="button"
          className="ghost"
          onClick={() => setStep("avatar")}
          disabled={!name.trim()}
        >
          {avatar ? "Change my avatar" : "Make an avatar (optional)"}
        </button>
      </form>
    </main>
  );
}
