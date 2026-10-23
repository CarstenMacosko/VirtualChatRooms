import { type FormEvent, useEffect, useState } from "react";
import type {
  CaptureOptions,
  ContactsResponse,
  DevLoginResponse,
  MeResponse,
  RoomInfo,
  SessionInfo,
} from "@vcr/protocol";
import { api, ApiRequestError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useMyAvatar } from "../lib/avatar";
import { useLive } from "../lib/live";
import { enablePush, pushSupported } from "../lib/push";
import { navigate } from "../lib/router";
import { useShareUrl } from "../lib/share";
import { YourRooms } from "./YourRooms";

const errorText = (err: unknown) =>
  err instanceof ApiRequestError ? err.message : "Something went wrong. Try again.";

/** Signed-in home: who's live, start a gathering, contacts and groups. */
export function Home({ auth }: { auth: DevLoginResponse }) {
  const signOut = useAuth((s) => s.signOut);
  const contactsVersion = useLive((s) => s.contactsVersion);
  const sessionsVersion = useLive((s) => s.sessionsVersion);
  const roomsVersion = useLive((s) => s.roomsVersion);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [contacts, setContacts] = useState<ContactsResponse | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [capture, setCapture] = useState<CaptureOptions | null>(null);
  const [roomsFetch, setRoomsFetch] = useState(0);
  const myAvatar = useMyAvatar();
  const shareUrl = useShareUrl();

  useEffect(() => {
    void api.me().then(setMe);
  }, []);
  useEffect(() => {
    void api.rooms().then((r) => {
      setRooms(r.rooms);
      setCapture(r.capture);
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the versions trigger the refetch
  }, [roomsVersion, roomsFetch]);
  // Live events report processing progress; poll as a fallback while a scan is being processed.
  const processing = rooms.some((r) => r.status === "processing");
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => setRoomsFetch((n) => n + 1), 3000);
    return () => clearInterval(timer);
  }, [processing]);
  // Live events bump these versions; refetch when they do.
  useEffect(() => {
    void api.contacts().then(setContacts);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- contactsVersion triggers the refetch
  }, [contactsVersion]);
  useEffect(() => {
    void api.sessions().then((r) => setSessions(r.sessions));
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- sessionsVersion triggers the refetch
  }, [sessionsVersion]);

  return (
    <div className="home">
      <header className="topbar">
        <strong>VirtualChatRooms</strong>
        <span className="spacer" />
        <button className="pill code" onClick={() => navigate("/avatar")}>
          {myAvatar.recipe ? "Edit avatar" : "Make your avatar"}
        </button>
        {me && <FriendCode code={me.friendCode} />}
        <span className="muted">Signed in as {auth.user.displayName}</span>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>

      {shareUrl && shareUrl !== window.location.origin && (
        <p className="share-banner">
          🌍 Sharing live at <a href={shareUrl}>{shareUrl}</a>. Guest links you copy point there,
          and visitors see your latest changes as you make them.
          <button
            className="link"
            onClick={() => void navigator.clipboard?.writeText(shareUrl).catch(() => {})}
          >
            Copy
          </button>
        </p>
      )}
      <main className="home-grid">
        <section className="panel">
          {myAvatar.status === "ready" && !myAvatar.recipe && (
            <div className="callout">
              <p>
                <b>Make your avatar.</b> Until you do, you'll show up as a randomly dressed
                stand-in.
              </p>
              <button onClick={() => navigate("/avatar")}>Make my avatar</button>
            </div>
          )}
          <LiveNow sessions={sessions} myId={auth.user.id} />
          <StartGathering rooms={rooms.filter((r) => r.status === "ready")} contacts={contacts} />
          <YourRooms
            rooms={rooms}
            capture={capture}
            onChanged={() => setRoomsFetch((n) => n + 1)}
          />
        </section>
        <section className="panel">
          <Contacts contacts={contacts} onChange={setContacts} />
        </section>
        <section className="panel">
          <Groups contacts={contacts} onChange={setContacts} />
          <CallAlerts />
        </section>
      </main>
    </div>
  );
}

/** Your friend code; click to copy it (or select it, if the clipboard is blocked). */
function FriendCode({ code }: { code: string }) {
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <button
      className="pill code"
      title="Share this so people can add you"
      onClick={() => {
        navigator.clipboard
          .writeText(code)
          .then(() => setState("copied"))
          .catch(() => setState("manual"));
      }}
    >
      {state === "copied" ? (
        <>Copied {code} ✓</>
      ) : state === "manual" ? (
        <>
          Your code: <b className="selectable">{code}</b>
        </>
      ) : (
        <>
          Friend code <b>{code}</b> · Copy
        </>
      )}
    </button>
  );
}

function LiveNow({ sessions, myId }: { sessions: SessionInfo[]; myId: string }) {
  if (!sessions.length) return null;
  return (
    <div className="live-now">
      <h2>Live now</h2>
      <ul className="list">
        {sessions.map((s) => {
          const mine = s.host.id === myId;
          const joined = s.invites.filter((i) => i.status === "accepted").length;
          return (
            <li key={s.id}>
              <span>
                <b>{mine ? "Your gathering" : `${s.host.displayName}'s gathering`}</b>
                <span className="muted">
                  {" "}
                  · {s.room.name} · {joined} joined
                </span>
              </span>
              <span className="row">
                {mine && (
                  <button className="link" onClick={() => void api.endSession(s.id)}>
                    End
                  </button>
                )}
                <button onClick={() => navigate(`/s/${s.id}`)}>Join</button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StartGathering(props: { rooms: RoomInfo[]; contacts: ContactsResponse | null }) {
  const [roomId, setRoomId] = useState("");
  const [everyone, setEveryone] = useState(true);
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set());
  const [userIds, setUserIds] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The sample room is first (the default) unless you picked another; a deleted pick falls back.
  const room = props.rooms.some((r) => r.id === roomId) ? roomId : props.rooms[0]?.id;
  const people = props.contacts?.contacts ?? [];
  const groups = props.contacts?.groups ?? [];

  const toggle = (set: Set<string>, id: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(id);
    else next.delete(id);
    return next;
  };

  async function start() {
    if (!room) return;
    setBusy(true);
    setError(null);
    try {
      const session = await api.startSession({
        roomId: room,
        inviteAll: everyone,
        inviteGroupIds: everyone ? [] : [...groupIds],
        inviteUserIds: everyone ? [] : [...userIds],
      });
      navigate(`/s/${session.id}`);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Start a gathering</h2>
      {props.rooms.length > 1 && (
        <label>
          Room
          <select value={room} onChange={(e) => setRoomId(e.target.value)}>
            {props.rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="muted">
        In <b>{props.rooms.find((r) => r.id === room)?.name ?? "your room"}</b>. Everyone you pick
        gets a call.
      </p>
      <label className="check">
        <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
        Ring all my contacts ({people.length})
      </label>
      {!everyone && (
        <div className="pickers">
          {groups.length > 0 && (
            <div className="chips">
              {groups.map((g) => (
                <label key={g.id} className={`chip ${groupIds.has(g.id) ? "on" : ""}`}>
                  <input
                    type="checkbox"
                    checked={groupIds.has(g.id)}
                    onChange={(e) => setGroupIds(toggle(groupIds, g.id, e.target.checked))}
                  />
                  {g.name}
                </label>
              ))}
            </div>
          )}
          <ul className="checklist">
            {people.map((c) => (
              <li key={c.userId}>
                <label>
                  <input
                    type="checkbox"
                    checked={userIds.has(c.userId)}
                    onChange={(e) => setUserIds(toggle(userIds, c.userId, e.target.checked))}
                  />
                  <span className={`dot ${c.online ? "on" : ""}`} aria-hidden />
                  {c.label ?? c.displayName}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <button onClick={start} disabled={!room || busy}>
        {busy ? "Starting…" : "Start and ring"}
      </button>
    </div>
  );
}

function Contacts(props: {
  contacts: ContactsResponse | null;
  onChange(c: ContactsResponse): void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const c = props.contacts;

  const run = async (call: Promise<ContactsResponse>) => {
    setError(null);
    try {
      props.onChange(await call);
    } catch (err) {
      setError(errorText(err));
    }
  };

  async function add(e: FormEvent) {
    e.preventDefault();
    await run(api.addContact(code));
    setCode("");
  }

  return (
    <div>
      <h2>Contacts</h2>
      <form className="row" onSubmit={add}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Friend code"
          maxLength={8}
          aria-label="Friend code"
        />
        <button type="submit" disabled={code.trim().length !== 8}>
          Add
        </button>
      </form>
      {error && <p className="error">{error}</p>}

      {c && c.incoming.length > 0 && (
        <>
          <h3>Requests</h3>
          <ul className="list">
            {c.incoming.map((r) => (
              <li key={r.userId}>
                <span>{r.displayName}</span>
                <span className="row">
                  <button className="link" onClick={() => void run(api.removeContact(r.userId))}>
                    Decline
                  </button>
                  <button onClick={() => void run(api.acceptContact(r.userId))}>Accept</button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {c && c.outgoing.length > 0 && (
        <>
          <h3>Waiting for them</h3>
          <ul className="list">
            {c.outgoing.map((r) => (
              <li key={r.userId}>
                <span className="muted">{r.displayName}</span>
                <button className="link" onClick={() => void run(api.removeContact(r.userId))}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Everyone</h3>
      {!c ? (
        <p className="muted">Loading…</p>
      ) : c.contacts.length === 0 ? (
        <p className="muted">Share your friend code, or add someone else's.</p>
      ) : (
        <ul className="list">
          {c.contacts.map((p) => (
            <li key={p.userId}>
              <span>
                <span className={`dot ${p.online ? "on" : ""}`} aria-hidden />
                {p.label ?? p.displayName}
                {p.label && <span className="muted"> ({p.displayName})</span>}
              </span>
              <span className="row">
                <button
                  className="link"
                  onClick={() => {
                    const label = prompt(`Your name for ${p.displayName}`, p.label ?? "");
                    if (label !== null) void run(api.labelContact(p.userId, label.trim() || null));
                  }}
                >
                  Rename
                </button>
                <button
                  className="link"
                  onClick={() => {
                    if (confirm(`Remove ${p.displayName} from your contacts?`)) {
                      void run(api.removeContact(p.userId));
                    }
                  }}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Groups(props: { contacts: ContactsResponse | null; onChange(c: ContactsResponse): void }) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const people = props.contacts?.contacts ?? [];
  const nameOf = new Map(people.map((p) => [p.userId, p.label ?? p.displayName]));

  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      props.onChange(await api.createGroup({ name, memberIds: [...members] }));
      setName("");
      setMembers(new Set());
      setCreating(false);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div>
      <h2>Groups</h2>
      <ul className="list">
        {props.contacts?.groups.map((g) => (
          <li key={g.id}>
            <span>
              <b>{g.name}</b>
              <span className="muted">
                {" "}
                · {g.memberIds.map((id) => nameOf.get(id) ?? "?").join(", ") || "nobody yet"}
              </span>
            </span>
            <button
              className="link"
              onClick={() => void api.deleteGroup(g.id).then(props.onChange)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      {creating ? (
        <form className="group-form" onSubmit={create}>
          {people.length === 0 && (
            <p className="hint">
              Groups are made of your contacts. Add someone by friend code first, then pick them
              here.
            </p>
          )}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name, e.g. Family"
            maxLength={40}
            required
          />
          <ul className="checklist">
            {people.map((p) => (
              <li key={p.userId}>
                <label>
                  <input
                    type="checkbox"
                    checked={members.has(p.userId)}
                    onChange={(e) => {
                      const next = new Set(members);
                      if (e.target.checked) next.add(p.userId);
                      else next.delete(p.userId);
                      setMembers(next);
                    }}
                  />
                  {p.label ?? p.displayName}
                </label>
              </li>
            ))}
          </ul>
          {error && <p className="error">{error}</p>}
          <div className="row end">
            <button type="button" className="link" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="submit">Save group</button>
          </div>
        </form>
      ) : (
        <button className="secondary" onClick={() => setCreating(true)}>
          New group
        </button>
      )}
    </div>
  );
}

/** Calls as system notifications: while this tab is in the background, or the app is closed. */
function CallAlerts() {
  const supported = pushSupported();
  const [permission, setPermission] = useState(supported ? Notification.permission : "denied");
  if (!supported || permission === "granted") return null;
  return (
    <div className="callout">
      {permission === "denied" ? (
        <p>
          Call alerts are blocked for this site. Allow notifications in your browser's site settings
          to get calls when the app is closed.
        </p>
      ) : (
        <>
          <p>Get calls even when this app is closed.</p>
          <button className="secondary" onClick={() => void enablePush().then(setPermission)}>
            Turn on call alerts
          </button>
        </>
      )}
    </div>
  );
}
