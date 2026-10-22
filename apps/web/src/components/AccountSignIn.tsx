import { SignIn, useAuth as useClerkAuth } from "@clerk/react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { type DevLoginResponse, MIN_ACCOUNT_AGE } from "@vcr/protocol";
import { api, ApiRequestError } from "../lib/api";
import { setAuthProvider, useAuth } from "../lib/auth";

export const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

/**
 * Connects Clerk to our session: renews our session token from Clerk's when it expires, and
 * signs out of Clerk when someone signs out here. Mounted once inside ClerkProvider.
 */
export function ClerkBridge() {
  const { getToken, signOut } = useClerkAuth();
  useEffect(() => {
    setAuthProvider({
      async refresh(): Promise<DevLoginResponse | null> {
        const providerToken = await getToken();
        if (!providerToken) return null;
        const res = await api.exchange({ providerToken });
        return res.status === "signed-in" ? { token: res.token, user: res.user } : null;
      },
      signOut: () => signOut(),
    });
    return () => setAuthProvider(null);
  }, [getToken, signOut]);
  return null;
}

type Phase =
  | { name: "provider" }
  | { name: "exchanging" }
  | { name: "profile"; suggestedName: string }
  | { name: "refused"; message: string };

/**
 * Real accounts (Clerk: email or Google). After Clerk signs someone in, we exchange its session
 * for ours; brand-new people first tell us their name and birth date for the 13+ age gate.
 */
export function AccountSignIn() {
  const { isLoaded, isSignedIn, getToken, signOut } = useClerkAuth();
  const signIn = useAuth((s) => s.signIn);
  const [phase, setPhase] = useState<Phase>({ name: "provider" });
  const [error, setError] = useState<string | null>(null);

  const exchange = useCallback(
    async (profile?: { displayName: string; birthDate: string }) => {
      setError(null);
      try {
        const providerToken = await getToken();
        if (!providerToken) throw new Error("no Clerk session");
        const res = await api.exchange({ providerToken, ...(profile && { profile }) });
        if (res.status === "signed-in") signIn({ token: res.token, user: res.user });
        else setPhase({ name: "profile", suggestedName: res.suggestedName });
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === "age_requirement") {
          // The API already deleted the account; end the Clerk session too.
          setPhase({ name: "refused", message: err.message });
          void signOut();
          return;
        }
        setError(err instanceof ApiRequestError ? err.message : "Couldn't sign you in. Try again?");
        if (!profile) setPhase({ name: "provider" });
      }
    },
    [getToken, signIn, signOut],
  );

  // Once Clerk has a session, trade it for ours.
  useEffect(() => {
    if (isLoaded && isSignedIn && phase.name === "provider") {
      void Promise.resolve().then(() => {
        setPhase({ name: "exchanging" });
        return exchange();
      });
    }
  }, [isLoaded, isSignedIn, phase.name, exchange]);

  if (phase.name === "refused") {
    return (
      <main className="signin">
        <div className="card">
          <h1>Sorry!</h1>
          <p>{phase.message}</p>
          <p className="hint">We didn't keep anything from this sign-up.</p>
          <button onClick={() => setPhase({ name: "provider" })}>OK</button>
        </div>
      </main>
    );
  }

  if (phase.name === "profile") {
    return <ProfileStep suggestedName={phase.suggestedName} error={error} onSubmit={exchange} />;
  }

  if (!isLoaded || phase.name === "exchanging" || isSignedIn) {
    return <div className="world-loading">Signing you in…</div>;
  }

  return (
    <main className="signin">
      <div className="signin-stack">
        <div className="brand">
          <h1>VirtualChatRooms</h1>
          <p className="muted">Hang out with friends and family as 3D avatars.</p>
        </div>
        <SignIn routing="hash" withSignUp />
        {error && <p className="error">{error}</p>}
        <p className="hint">
          Accounts are for ages {MIN_ACCOUNT_AGE}+. Younger family members can join with a guest
          link from a parent.
        </p>
      </div>
    </main>
  );
}

function ProfileStep(props: {
  suggestedName: string;
  error: string | null;
  onSubmit(profile: { displayName: string; birthDate: string }): Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(props.suggestedName);
  const [birthDate, setBirthDate] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await props.onSubmit({ displayName: displayName.trim(), birthDate });
    setBusy(false);
  }

  return (
    <main className="signin">
      <form className="card" onSubmit={submit}>
        <h1>One more step</h1>
        <p className="muted">Tell us what to call you, and your birthday.</p>
        <label>
          Your name
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={40}
            required
            autoFocus
          />
          <span className="hint">This is what friends and family see.</span>
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
        {props.error && (
          <p className="error" role="alert">
            {props.error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? "One moment…" : "Create my account"}
        </button>
      </form>
    </main>
  );
}
