import { type FormEvent, useState } from "react";
import { MIN_ACCOUNT_AGE } from "@vcr/protocol";
import { api, ApiRequestError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { viewingShared } from "../lib/share";
import { Landing } from "./Landing";

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

  // Production servers have no name-only sign-in: people arrive with a link instead.
  if (import.meta.env.PROD) {
    return (
      <Landing>
        <div className="card">
          <h2>Welcome</h2>
          <p className="muted">
            Open the link you were sent: an invite, a call link, or a sign-in link from your own
            computer. It signs you in or puts you straight into the call.
          </p>
        </div>
      </Landing>
    );
  }

  return (
    <Landing>
      <form className="card" onSubmit={onSubmit}>
        <h2>Sign in</h2>
        {viewingShared() && (
          <p className="callout">
            This is a preview someone is sharing from their computer. To join their call, open the
            link they sent you. Signing in here only works on their computer.
          </p>
        )}
        <p className="muted">
          New here? Enter your name and birthday to create your account. Use the same name later to
          sign back in.
        </p>

        <label>
          Your name
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={40}
            required
            autoFocus
            autoComplete="name"
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
        <button type="submit" className="primary big" disabled={busy}>
          {busy ? "One moment…" : "Continue"}
        </button>
        <p className="hint">
          Development sign-in, with no password. Real accounts (email or Google) take over once
          Clerk keys are set.
        </p>
      </form>
    </Landing>
  );
}
