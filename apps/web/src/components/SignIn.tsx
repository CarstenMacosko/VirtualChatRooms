import { type FormEvent, useState } from "react";
import { MIN_ACCOUNT_AGE } from "@vcr/protocol";
import { api, ApiRequestError } from "../lib/api";
import { useAuth } from "../lib/auth";

export function SignIn() {
  const signIn = useAuth((s) => s.signIn);
  const [displayName, setDisplayName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      signIn(await api.devLogin({ displayName, birthDate }));
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err.message : "Couldn't reach the API. Is it running?",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <form className="card" onSubmit={onSubmit}>
        <h1>VirtualChatRooms</h1>
        <p className="muted">Hang out with friends and family as 3D avatars.</p>
        <p>
          <b>New here?</b> Enter your name and birthday to create your account. Use the same name
          later to sign back in.
        </p>

        <label>
          Your name
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={40}
            required
            autoFocus
          />
        </label>
        <label>
          Date of birth
          <input
            type="date"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
            required
          />
          <span className="hint">
            Accounts are for ages {MIN_ACCOUNT_AGE}+. We only keep the confirmation, not the date.
          </span>
        </label>

        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "One moment…" : "Create account or sign in"}
        </button>
        <p className="hint">
          Development sign-in: no password yet. Real accounts (email or Google sign-in) replace this
          before launch.
        </p>
      </form>
    </main>
  );
}
