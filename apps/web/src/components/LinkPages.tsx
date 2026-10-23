import { Phone, PhoneOff, Video } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { CallStatus, JoinSessionResponse, LinkInfo } from "@vcr/protocol";
import { MIN_ACCOUNT_AGE } from "@vcr/protocol";
import { api, ApiRequestError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { loadGuestAvatar } from "../lib/avatar";
import { navigate } from "../lib/router";
import { SpatialAudio } from "../media/SpatialAudio";
import { SessionScreen } from "./SessionScreen";
import { Avatar } from "./ui";

/**
 * Pages for links that arrive from another device or person: sign in on your phone (`/link/…`),
 * accept an invite (`/invite/…`), and call someone through their call link (`/call/…`).
 */

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiRequestError ? err.message : fallback;

function useLinkInfo(token: string) {
  const [info, setInfo] = useState<LinkInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api
      .linkInfo(token)
      .then(setInfo)
      .catch((err: unknown) => setError(errorText(err, "Couldn't open this link.")));
  }, [token]);
  return { info, error };
}

function LinkCard(props: { children: React.ReactNode }) {
  return (
    <main className="portal center-page">
      <div className="card link-card">{props.children}</div>
    </main>
  );
}

/** `/link/<token>`: sign this device in as the person who made the link. */
export function DeviceLinkPage({ token }: { token: string }) {
  const { info, error } = useLinkInfo(token);
  const current = useAuth((s) => s.auth);
  const signIn = useAuth((s) => s.signIn);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function claim() {
    setBusy(true);
    try {
      signIn(await api.claimDeviceLink(token));
      navigate("/", { replace: true });
    } catch (err) {
      setFailure(errorText(err, "Couldn't sign in."));
      setBusy(false);
    }
  }

  return (
    <LinkCard>
      {error || (info && info.kind !== "device") ? (
        <>
          <h1>This link has expired</h1>
          <p className="muted">
            Sign-in links work once, for 10 minutes. Make a new one on your computer.
          </p>
        </>
      ) : !info ? (
        <p className="muted">Opening…</p>
      ) : (
        <>
          <Avatar name={info.ownerName} id={info.ownerId} size={72} />
          <h1>Sign in as {info.ownerName}?</h1>
          <p className="muted">
            This device gets your contacts and calls. Only continue if this is your own phone or
            tablet.
          </p>
          {current && current.user.displayName !== info.ownerName && (
            <p className="callout warn">
              You're signed in here as {current.user.displayName}. Continuing switches to{" "}
              {info.ownerName}.
            </p>
          )}
          {failure && <p className="error">{failure}</p>}
          <button className="primary big" onClick={() => void claim()} disabled={busy}>
            {busy ? "Signing in…" : `Continue as ${info.ownerName}`}
          </button>
        </>
      )}
    </LinkCard>
  );
}

const PENDING_INVITE = "vcr.pendingInvite";

/** After signing in with a provider (Clerk), finish an invite that was opened while signed out. */
export async function finishPendingInvite() {
  let token: string | null = null;
  try {
    token = sessionStorage.getItem(PENDING_INVITE);
    sessionStorage.removeItem(PENDING_INVITE);
  } catch {
    return;
  }
  if (token) await api.acceptInvite(token, {}).catch(() => {});
}

/** `/invite/<token>`: become contacts with whoever sent it, making an account if needed. */
export function InvitePage({ token, signInPage }: { token: string; signInPage: React.ReactNode }) {
  const { info, error } = useLinkInfo(token);
  const auth = useAuth((s) => s.auth);
  const signIn = useAuth((s) => s.signIn);
  const [name, setName] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.acceptInvite(
        token,
        auth ? {} : { displayName: name.trim(), birthDate },
      );
      if (result) signIn(result);
      navigate("/", { replace: true });
    } catch (err) {
      setFailure(errorText(err, "Couldn't accept the invite."));
      setBusy(false);
    }
  }

  if (error || (info && info.kind !== "invite")) {
    return (
      <LinkCard>
        <h1>This invite has expired</h1>
        <p className="muted">Invites last a week. Ask for a new one.</p>
      </LinkCard>
    );
  }
  if (!info) return <LinkCard>{<p className="muted">Opening…</p>}</LinkCard>;

  // Real accounts are on: sign in (or up) first, then the invite is accepted.
  if (!auth && !info.canCreateAccount) {
    try {
      sessionStorage.setItem(PENDING_INVITE, token);
    } catch {
      // fine
    }
    return <>{signInPage}</>;
  }

  return (
    <LinkCard>
      <Avatar name={info.ownerName} id={info.ownerId} size={72} />
      <h1>{info.ownerName} invited you</h1>
      <p className="muted">
        Join VirtualChatRooms to video call {info.ownerName} and the rest of the family, from any
        phone or computer.
      </p>
      {auth?.user.id === info.ownerId ? (
        <>
          <p className="callout">
            This is your own invite link. Send it to family and friends: whoever opens it becomes
            your contact.
          </p>
          <button className="primary big" onClick={() => navigate("/")}>
            Back home
          </button>
        </>
      ) : auth ? (
        <>
          {failure && <p className="error">{failure}</p>}
          <button className="primary big" onClick={() => void accept()} disabled={busy}>
            Add {info.ownerName} as {auth.user.displayName}
          </button>
        </>
      ) : (
        <form className="stack" onSubmit={accept}>
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
          {failure && <p className="error">{failure}</p>}
          <button className="primary big" disabled={busy || !name.trim() || !birthDate}>
            {busy ? "Joining…" : "Join and connect"}
          </button>
        </form>
      )}
    </LinkCard>
  );
}

const GUEST_NAME = "vcr.guestName";
const POLL_MS = 1500;

type CallStep =
  | { step: "name" }
  | { step: "calling"; callId: string; secret: string; audio: SpatialAudio }
  | { step: "over"; status: CallStatus }
  | { step: "joined"; first: JoinSessionResponse; guestToken: string; audio: SpatialAudio };

/** `/call/<token>`: ring someone through their call link, then join their call if they answer. */
export function CallMePage({ token }: { token: string }) {
  const { info, error } = useLinkInfo(token);
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(GUEST_NAME) ?? "";
    } catch {
      return "";
    }
  });
  const [state, setState] = useState<CallStep>({ step: "name" });
  const [failure, setFailure] = useState<string | null>(null);
  const firstUsed = useRef(false);

  async function startCall(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    try {
      localStorage.setItem(GUEST_NAME, name.trim());
    } catch {
      // fine
    }
    // Created inside the click so the browser lets it play sound later.
    const audio = new SpatialAudio();
    void audio.resume();
    try {
      const call = await api.startCall(token, name.trim());
      setState({ step: "calling", ...call, audio });
    } catch (err) {
      audio.dispose();
      setFailure(errorText(err, "Couldn't place the call."));
    }
  }

  // While ringing: poll until they answer (then join) or the call ends.
  useEffect(() => {
    if (state.step !== "calling") return;
    let active = true;
    const { callId, secret, audio } = state;
    const poll = async () => {
      try {
        const s = await api.callState(callId, secret);
        if (!active) return;
        if (s.status === "accepted" && s.guestToken) {
          const first = await api.guestJoin(s.guestToken, name.trim(), loadGuestAvatar());
          if (active) setState({ step: "joined", first, guestToken: s.guestToken, audio });
        } else if (s.status !== "ringing") {
          audio.dispose();
          setState({ step: "over", status: s.status });
        }
      } catch {
        // a dropped poll; try again
      }
    };
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [state, name]);

  // Hang up if the page closes while ringing.
  useEffect(() => {
    if (state.step !== "calling") return;
    const { callId, secret } = state;
    const onHide = () => void api.hangUpCall(callId, secret).catch(() => {});
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [state]);

  // The call's audio outlives the ringing screen; close it when this page goes away.
  const audioRef = useRef<SpatialAudio | null>(null);
  useEffect(() => {
    audioRef.current = state.step === "joined" || state.step === "calling" ? state.audio : null;
  }, [state]);
  useEffect(() => () => audioRef.current?.dispose(), []);

  if (state.step === "joined") {
    return (
      <SessionScreen
        sessionId={state.first.sessionId}
        join={() => {
          if (!firstUsed.current) {
            firstUsed.current = true;
            return Promise.resolve(state.first);
          }
          return api.guestJoin(state.guestToken, name.trim(), loadGuestAvatar());
        }}
        title={info ? `Call with ${info.ownerName}` : "Call"}
        displayName={name.trim()}
        isGuest
        entered={{ choice: { mic: true, camera: true }, audio: state.audio }}
        onExit={() => {
          state.audio.dispose();
          firstUsed.current = false;
          setState({ step: "name" });
        }}
      />
    );
  }

  if (error || (info && info.kind !== "call")) {
    return (
      <LinkCard>
        <h1>This call link doesn't work any more</h1>
        <p className="muted">Ask them for their new link.</p>
      </LinkCard>
    );
  }
  if (!info) return <LinkCard>{<p className="muted">Opening…</p>}</LinkCard>;

  if (state.step === "calling") {
    return (
      <Ringing
        name={info.ownerName}
        id={info.ownerId}
        onHangUp={() => {
          void api.hangUpCall(state.callId, state.secret).catch(() => {});
          state.audio.dispose();
          setState({ step: "name" });
        }}
      />
    );
  }

  return (
    <LinkCard>
      <Avatar name={info.ownerName} id={info.ownerId} size={88} />
      <h1>Call {info.ownerName}</h1>
      <p className="muted">
        {info.ownerOnline
          ? `${info.ownerName} is online now.`
          : `${info.ownerName} may be away; their devices will ring.`}{" "}
        No account needed.
      </p>
      {state.step === "over" && (
        <p className="callout">
          {state.status === "declined"
            ? `${info.ownerName} can't talk right now.`
            : state.status === "missed"
              ? `${info.ownerName} didn't answer.`
              : "Call ended."}
        </p>
      )}
      <form className="stack" onSubmit={startCall}>
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
          <span className="hint">So they know who's calling. Nothing else is saved.</span>
        </label>
        {failure && <p className="error">{failure}</p>}
        <button className="primary big call-start" disabled={!name.trim()}>
          <Video size={20} /> {state.step === "over" ? "Call again" : "Call"}
        </button>
      </form>
    </LinkCard>
  );
}

/** Outgoing call: your own camera behind a "Calling…" card, like FaceTime and Duo. */
function Ringing({ name, id, onHangUp }: { name: string; id: string; onHangUp(): void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  return (
    <main className="calling-screen">
      <video ref={video} autoPlay playsInline muted className="mirror self-backdrop" />
      <div className="calling-card">
        <Avatar name={name} id={id} size={96} />
        <h1>{name}</h1>
        <p className="calling-text">
          <Phone size={16} /> Calling…
        </p>
      </div>
      <button className="hangup round" onClick={onHangUp} aria-label="Hang up">
        <PhoneOff size={28} />
      </button>
    </main>
  );
}
