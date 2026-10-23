import {
  ChevronDown,
  EllipsisVertical,
  Link2,
  LogOut,
  Phone,
  Plus,
  QrCode as QrIcon,
  RefreshCw,
  Search,
  Smartphone,
  UserPlus,
  Users,
  Video,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  CaptureOptions,
  ContactsResponse,
  DevLoginResponse,
  LinkResponse,
  MeResponse,
  RoomInfo,
  SessionInfo,
  StartSessionRequest,
} from "@vcr/protocol";
import { api, ApiRequestError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useMyAvatar } from "../lib/avatar";
import { useLive } from "../lib/live";
import { enablePush, pushSupported } from "../lib/push";
import { navigate } from "../lib/router";
import { publicOrigin, useShareUrl } from "../lib/share";
import { Avatar, CopyButton, Dialog, ShareLink } from "./ui";
import { YourRooms } from "./YourRooms";

const errorText = (err: unknown) =>
  err instanceof ApiRequestError ? err.message : "Something went wrong. Try again.";

const ROOM_KEY = "vcr.callRoom";

/** Closes a popup menu when you click or tap anywhere outside `anchor`. */
function useOutsideClose(open: boolean, close: () => void) {
  const anchor = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!anchor.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open, close]);
  return anchor;
}

/** Signed-in home: call people, see who's live, contacts, groups, links and rooms. */
export function Home({ auth }: { auth: DevLoginResponse }) {
  const contactsVersion = useLive((s) => s.contactsVersion);
  const sessionsVersion = useLive((s) => s.sessionsVersion);
  const roomsVersion = useLive((s) => s.roomsVersion);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [contacts, setContacts] = useState<ContactsResponse | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [capture, setCapture] = useState<CaptureOptions | null>(null);
  const [roomsFetch, setRoomsFetch] = useState(0);
  const [dialog, setDialog] = useState<"phone" | "invite" | "choose" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shareUrl = useShareUrl();
  const origin = publicOrigin(shareUrl);
  const myAvatar = useMyAvatar();

  useEffect(() => {
    void api.me().then(setMe, () => {});
  }, []);
  // Live events bump these versions; refetch when they do.
  useEffect(() => {
    void api.contacts().then(setContacts, () => {});
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- contactsVersion triggers the refetch
  }, [contactsVersion]);
  useEffect(() => {
    void api.sessions().then(
      (r) => setSessions(r.sessions),
      () => {},
    );
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- sessionsVersion triggers the refetch
  }, [sessionsVersion]);
  useEffect(() => {
    void api.rooms().then(
      (r) => {
        setRooms(r.rooms);
        setCapture(r.capture);
      },
      () => {},
    );
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the versions trigger the refetch
  }, [roomsVersion, roomsFetch]);
  // Live events report processing progress; poll as a fallback while a scan is being processed.
  const processing = rooms.some((r) => r.status === "processing");
  useEffect(() => {
    if (!processing) return;
    const timer = setInterval(() => setRoomsFetch((n) => n + 1), 3000);
    return () => clearInterval(timer);
  }, [processing]);

  const readyRooms = rooms.filter((r) => r.status === "ready");
  const [roomChoice, setRoomChoice] = useState(() => {
    try {
      return localStorage.getItem(ROOM_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const roomId = readyRooms.some((r) => r.id === roomChoice) ? roomChoice : readyRooms[0]?.id;

  /** Starts a gathering and rings whoever `who` says; you go straight into the call. */
  const call = async (who: Omit<StartSessionRequest, "roomId">) => {
    if (!roomId) return;
    setError(null);
    try {
      const session = await api.startSession({ roomId, ...who });
      navigate(`/s/${session.id}`);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const people = contacts?.contacts ?? [];
  const firstName = auth.user.displayName.split(" ")[0];

  return (
    <div className="portal">
      <TopBar
        auth={auth}
        me={me}
        hasAvatar={Boolean(myAvatar.recipe)}
        onPhone={() => setDialog("phone")}
      />

      {shareUrl && shareUrl !== window.location.origin && (
        <p className="share-banner">
          Sharing live at <a href={shareUrl}>{shareUrl}</a>. Links you copy point there, so phones
          and friends can open them.
        </p>
      )}

      <main className="portal-main">
        <section className="portal-calls">
          <div className="hero">
            <h1>Hi {firstName}</h1>
            <p className="muted">Video calls with your family and friends, in a room you share.</p>
            <div className="hero-actions">
              <NewCallMenu
                disabled={!roomId}
                everyoneCount={people.length}
                onRingEveryone={() => void call({ inviteAll: true })}
                onChoose={() => setDialog("choose")}
                onNoRing={() => void call({})}
              />
              <JoinBox />
            </div>
            {readyRooms.length > 1 && (
              <label className="room-pick">
                Calls happen in
                <select
                  value={roomId}
                  onChange={(e) => {
                    setRoomChoice(e.target.value);
                    try {
                      localStorage.setItem(ROOM_KEY, e.target.value);
                    } catch {
                      // fine: just not remembered
                    }
                  }}
                >
                  {readyRooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {error && <p className="error">{error}</p>}
          </div>

          <LiveNow sessions={sessions} myId={auth.user.id} />

          {myAvatar.status === "ready" && !myAvatar.recipe && (
            <div className="card callout-card">
              <div>
                <b>Make your avatar</b>
                <p className="muted">It's how you appear in the room view. Takes a minute.</p>
              </div>
              <button className="secondary" onClick={() => navigate("/avatar")}>
                Make my avatar
              </button>
            </div>
          )}

          <CallLinkCard origin={origin} />
          <CallAlerts />
        </section>

        <section className="portal-side">
          <Contacts
            contacts={contacts}
            onChange={setContacts}
            onCall={(userId) => void call({ inviteUserIds: [userId] })}
            onInvite={() => setDialog("invite")}
            canCall={Boolean(roomId)}
          />
          <Groups
            contacts={contacts}
            onChange={setContacts}
            onCall={(groupId) => void call({ inviteGroupIds: [groupId] })}
          />
          <div className="card">
            <YourRooms
              rooms={rooms}
              capture={capture}
              onChanged={() => setRoomsFetch((n) => n + 1)}
            />
          </div>
        </section>
      </main>

      {dialog === "phone" && <PhoneDialog origin={origin} onClose={() => setDialog(null)} />}
      {dialog === "invite" && (
        <InviteDialog
          origin={origin}
          friendCode={me?.friendCode ?? null}
          onAdded={setContacts}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "choose" && contacts && (
        <ChooseDialog
          contacts={contacts}
          onClose={() => setDialog(null)}
          onCall={(userIds, groupIds) => {
            setDialog(null);
            void call({ inviteUserIds: userIds, inviteGroupIds: groupIds });
          }}
        />
      )}
    </div>
  );
}

function TopBar(props: {
  auth: DevLoginResponse;
  me: MeResponse | null;
  hasAvatar: boolean;
  onPhone(): void;
}) {
  const signOut = useAuth((s) => s.signOut);
  const [open, setOpen] = useState(false);
  const menu = useOutsideClose(open, () => setOpen(false));

  return (
    <header className="portal-top">
      <a
        className="brand"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          navigate("/");
        }}
      >
        <span className="brand-mark" aria-hidden>
          <Video size={18} />
        </span>
        VirtualChatRooms
      </a>
      <span className="spacer" />
      <button className="ghost" onClick={props.onPhone}>
        <Smartphone size={18} /> <span className="hide-narrow">Use on your phone</span>
      </button>
      <div className="menu-anchor" ref={menu}>
        <button
          className="avatar-button"
          onClick={() => setOpen(!open)}
          aria-label="Account"
          aria-expanded={open}
        >
          <Avatar name={props.auth.user.displayName} id={props.auth.user.id} size={36} />
        </button>
        {open && (
          <div className="menu right" role="menu">
            <div className="menu-head">
              <b>{props.auth.user.displayName}</b>
              {props.me && <span className="muted">Friend code {props.me.friendCode}</span>}
            </div>
            <button role="menuitem" onClick={() => navigate("/avatar")}>
              {props.hasAvatar ? "Edit avatar" : "Make your avatar"}
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                props.onPhone();
              }}
            >
              <Smartphone size={16} /> Use on your phone
            </button>
            <button role="menuitem" onClick={signOut}>
              <LogOut size={16} /> Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}

function NewCallMenu(props: {
  disabled: boolean;
  everyoneCount: number;
  onRingEveryone(): void;
  onChoose(): void;
  onNoRing(): void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useOutsideClose(open, () => setOpen(false));
  const pick = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };
  return (
    <div className="menu-anchor" ref={anchor}>
      <button className="primary big" disabled={props.disabled} onClick={() => setOpen(!open)}>
        <Video size={20} /> New call <ChevronDown size={16} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button
            role="menuitem"
            onClick={pick(props.onRingEveryone)}
            disabled={!props.everyoneCount}
          >
            <Users size={16} /> Ring all my contacts ({props.everyoneCount})
          </button>
          <button role="menuitem" onClick={pick(props.onChoose)} disabled={!props.everyoneCount}>
            <Phone size={16} /> Choose who to ring…
          </button>
          <button role="menuitem" onClick={pick(props.onNoRing)}>
            <Link2 size={16} /> Start now, invite with a link
          </button>
        </div>
      )}
    </div>
  );
}

/** Paste any link (guest link, call link, invite) or a gathering address to open it. */
function JoinBox() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    const match = /\/(join|call|invite|link|s)\/([a-zA-Z0-9_-]{8,64})/.exec(value.trim());
    if (!match) {
      setError("Paste a link someone sent you.");
      return;
    }
    navigate(`/${match[1]}/${match[2]}`);
  }
  return (
    <form className="join-box" onSubmit={submit}>
      <input
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
        placeholder="Paste a link to join"
        aria-label="Link to join"
      />
      <button className="ghost" disabled={!value.trim()}>
        Join
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function LiveNow({ sessions, myId }: { sessions: SessionInfo[]; myId: string }) {
  if (!sessions.length) return null;
  return (
    <div className="card live-now">
      <h2>Happening now</h2>
      <ul className="rows">
        {sessions.map((s) => {
          const mine = s.host.id === myId;
          const joined = s.invites.filter((i) => i.status === "accepted").length;
          return (
            <li key={s.id}>
              <span className="pulse" aria-hidden />
              <span className="grow">
                <b>{mine ? "Your call" : `${s.host.displayName}'s call`}</b>
                <span className="muted">
                  {s.room.name} · {joined ? `${joined} joined` : "waiting for people"}
                </span>
              </span>
              {mine && (
                <button className="ghost" onClick={() => void api.endSession(s.id)}>
                  End
                </button>
              )}
              <button className="join" onClick={() => navigate(`/s/${s.id}`)}>
                Join
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Your personal "call me" link: anyone with it can ring you, no account needed. */
function CallLinkCard({ origin }: { origin: string }) {
  const [link, setLink] = useState<LinkResponse | null>(null);
  const [showQr, setShowQr] = useState(false);
  useEffect(() => {
    void api.callLink().then(setLink, () => {});
  }, []);
  if (!link) return null;
  const url = `${origin}${link.path}`;
  return (
    <div className="card">
      <h2>Your call link</h2>
      <p className="muted">
        Anyone with this link can call you from a phone or computer, without an account. You choose
        whether to answer.
      </p>
      <input className="link-field" readOnly value={url} onFocus={(e) => e.target.select()} />
      <div className="row wrap">
        <CopyButton text={url} label="Copy link" />
        <button className="secondary" onClick={() => setShowQr(true)}>
          <QrIcon size={18} /> QR code
        </button>
        <button
          className="ghost"
          onClick={() => {
            if (confirm("Make a new call link? The old one stops working.")) {
              void api.resetCallLink().then(setLink, () => {});
            }
          }}
        >
          <RefreshCw size={16} /> New link
        </button>
      </div>
      {showQr && (
        <Dialog title="Your call link" onClose={() => setShowQr(false)}>
          <ShareLink url={url} shareTitle="Call me" hint="Scan with a phone camera to call you." />
        </Dialog>
      )}
    </div>
  );
}

const onlyThisComputer = (origin: string) => /\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(origin);

/** Signs this account in on a phone or tablet: a one-time link and its QR code. */
function PhoneDialog({ origin, onClose }: { origin: string; onClose(): void }) {
  const [link, setLink] = useState<LinkResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.deviceLink().then(setLink, (err: unknown) => setError(errorText(err)));
  }, []);
  return (
    <Dialog title="Use on your phone" onClose={onClose}>
      {onlyThisComputer(origin) && (
        <p className="callout warn">
          This address only works on this computer. Run <code>pnpm share</code> for a link your
          phone can open, then open this again.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {link && (
        <ShareLink
          url={`${origin}${link.path}`}
          shareTitle="Sign in to VirtualChatRooms"
          hint="Scan with your phone's camera to sign in there as you. Works once, for 10 minutes. Don't send it to anyone else."
        />
      )}
    </Dialog>
  );
}

function InviteDialog(props: {
  origin: string;
  friendCode: string | null;
  onAdded(c: ContactsResponse): void;
  onClose(): void;
}) {
  const [link, setLink] = useState<LinkResponse | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);
  useEffect(() => {
    api.inviteLink().then(setLink, (err: unknown) => setError(errorText(err)));
  }, []);
  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      props.onAdded(await api.addContact(code));
      setCode("");
      setAdded(true);
    } catch (err) {
      setError(errorText(err));
    }
  }
  return (
    <Dialog title="Add people" onClose={props.onClose} wide>
      <h3>Send an invite link</h3>
      {onlyThisComputer(props.origin) && (
        <p className="callout warn">
          This address only works on this computer. Run <code>pnpm share</code> first for a link
          others can open.
        </p>
      )}
      {link && (
        <ShareLink
          url={`${props.origin}${link.path}`}
          shareTitle="Join me on VirtualChatRooms"
          hint="Whoever opens it makes an account (or signs in) and you're contacts right away. Works for a week."
        />
      )}
      <h3>Or add a friend code</h3>
      <form className="row" onSubmit={add}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="Friend code"
          maxLength={8}
          aria-label="Friend code"
        />
        <button className="primary" disabled={code.length < 8}>
          Add
        </button>
      </form>
      {added && <p className="ok-text">Request sent. They'll see it right away.</p>}
      {props.friendCode && (
        <p className="muted">
          Your friend code is <b className="selectable">{props.friendCode}</b>.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </Dialog>
  );
}

function ChooseDialog(props: {
  contacts: ContactsResponse;
  onClose(): void;
  onCall(userIds: string[], groupIds: string[]): void;
}) {
  const [users, setUsers] = useState<Set<string>>(new Set());
  const [groups, setGroups] = useState<Set<string>>(new Set());
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  return (
    <Dialog title="Who should we ring?" onClose={props.onClose}>
      {props.contacts.groups.length > 0 && (
        <div className="chips">
          {props.contacts.groups.map((g) => (
            <button
              key={g.id}
              className={`chip${groups.has(g.id) ? " on" : ""}`}
              onClick={() => setGroups(toggle(groups, g.id))}
              aria-pressed={groups.has(g.id)}
            >
              <Users size={14} /> {g.name}
            </button>
          ))}
        </div>
      )}
      <ul className="rows pick-list">
        {props.contacts.contacts.map((c) => (
          <li key={c.userId}>
            <label>
              <input
                type="checkbox"
                checked={users.has(c.userId)}
                onChange={() => setUsers(toggle(users, c.userId))}
              />
              <Avatar name={c.displayName} id={c.userId} size={32} online={c.online} />
              <span className="grow">{c.label ?? c.displayName}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="row end">
        <button className="ghost" onClick={props.onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={!users.size && !groups.size}
          onClick={() => props.onCall([...users], [...groups])}
        >
          <Video size={18} /> Ring them
        </button>
      </div>
    </Dialog>
  );
}

function ContactMenu(props: { name: string; onRename(): void; onRemove(): void }) {
  const [open, setOpen] = useState(false);
  const anchor = useOutsideClose(open, () => setOpen(false));
  return (
    <div className="menu-anchor" ref={anchor}>
      <button
        className="icon-button"
        aria-label={`More for ${props.name}`}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <EllipsisVertical size={18} />
      </button>
      {open && (
        <div className="menu right" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              props.onRename();
            }}
          >
            Rename
          </button>
          <button
            role="menuitem"
            className="danger-text"
            onClick={() => {
              setOpen(false);
              props.onRemove();
            }}
          >
            Remove
          </button>
        </div>
      )}
    </div>
  );
}

function Contacts(props: {
  contacts: ContactsResponse | null;
  onChange(c: ContactsResponse): void;
  onCall(userId: string): void;
  onInvite(): void;
  canCall: boolean;
}) {
  const [query, setQuery] = useState("");
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

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = c?.contacts ?? [];
    const filtered = q
      ? list.filter((p) => `${p.label ?? ""} ${p.displayName}`.toLowerCase().includes(q))
      : list;
    // Online people first, then by name.
    return [...filtered].sort(
      (a, b) =>
        Number(b.online) - Number(a.online) ||
        (a.label ?? a.displayName).localeCompare(b.label ?? b.displayName),
    );
  }, [c, query]);

  return (
    <div className="card contacts">
      <header className="card-head">
        <h2>Contacts</h2>
        <button className="secondary small" onClick={props.onInvite}>
          <UserPlus size={16} /> Add people
        </button>
      </header>

      {c && c.incoming.length > 0 && (
        <ul className="rows requests">
          {c.incoming.map((r) => (
            <li key={r.userId}>
              <Avatar name={r.displayName} id={r.userId} size={36} />
              <span className="grow">
                <b>{r.displayName}</b>
                <span className="muted">wants to add you</span>
              </span>
              <button className="ghost" onClick={() => void run(api.removeContact(r.userId))}>
                Decline
              </button>
              <button className="primary" onClick={() => void run(api.acceptContact(r.userId))}>
                Accept
              </button>
            </li>
          ))}
        </ul>
      )}

      {(c?.contacts.length ?? 0) > 5 && (
        <label className="search">
          <Search size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search contacts"
            aria-label="Search contacts"
          />
        </label>
      )}

      {!c ? (
        <p className="muted">Loading contacts…</p>
      ) : c.contacts.length === 0 && c.outgoing.length === 0 ? (
        <div className="empty">
          <p>No contacts yet.</p>
          <p className="muted">Send someone an invite link, or add their friend code.</p>
          <button className="primary" onClick={props.onInvite}>
            <UserPlus size={18} /> Add people
          </button>
        </div>
      ) : (
        <ul className="rows">
          {shown.map((p) => (
            <li key={p.userId}>
              <Avatar name={p.displayName} id={p.userId} size={40} online={p.online} />
              <span className="grow">
                <b>{p.label ?? p.displayName}</b>
                <span className="muted">
                  {p.label ? `${p.displayName} · ` : ""}
                  {p.online ? "Online" : "Offline"}
                </span>
              </span>
              <button
                className="call-button"
                onClick={() => props.onCall(p.userId)}
                disabled={!props.canCall}
                aria-label={`Video call ${p.label ?? p.displayName}`}
                title="Video call"
              >
                <Video size={18} />
              </button>
              <ContactMenu
                name={p.displayName}
                onRename={() => {
                  const label = prompt(`Your name for ${p.displayName}`, p.label ?? "");
                  if (label !== null) void run(api.labelContact(p.userId, label.trim() || null));
                }}
                onRemove={() => {
                  if (confirm(`Remove ${p.displayName} from your contacts?`)) {
                    void run(api.removeContact(p.userId));
                  }
                }}
              />
            </li>
          ))}
          {c.outgoing.map((r) => (
            <li key={r.userId} className="pending">
              <Avatar name={r.displayName} id={r.userId} size={40} />
              <span className="grow">
                <b>{r.displayName}</b>
                <span className="muted">Waiting for them to accept</span>
              </span>
              <button className="ghost" onClick={() => void run(api.removeContact(r.userId))}>
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Groups(props: {
  contacts: ContactsResponse | null;
  onChange(c: ContactsResponse): void;
  onCall(groupId: string): void;
}) {
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
    <div className="card">
      <header className="card-head">
        <h2>Groups</h2>
        {!creating && (
          <button
            className="secondary small"
            onClick={() => setCreating(true)}
            disabled={!people.length}
          >
            <Plus size={16} /> New group
          </button>
        )}
      </header>
      {!props.contacts?.groups.length && !creating && (
        <p className="muted">Make a group like "Family" to call everyone in it at once.</p>
      )}
      <ul className="rows">
        {props.contacts?.groups.map((g) => (
          <li key={g.id}>
            <span className="group-icon" aria-hidden>
              <Users size={18} />
            </span>
            <span className="grow">
              <b>{g.name}</b>
              <span className="muted">
                {g.memberIds.map((id) => nameOf.get(id) ?? "?").join(", ") || "nobody yet"}
              </span>
            </span>
            <button
              className="call-button"
              onClick={() => props.onCall(g.id)}
              disabled={!g.memberIds.length}
              aria-label={`Call ${g.name}`}
              title="Call everyone in this group"
            >
              <Video size={18} />
            </button>
            <button
              className="ghost small"
              onClick={() => void api.deleteGroup(g.id).then(props.onChange)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      {creating && (
        <form className="group-form" onSubmit={create}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Group name, e.g. Family"
            maxLength={40}
            required
          />
          <ul className="rows pick-list">
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
                  <Avatar name={p.displayName} id={p.userId} size={28} />
                  {p.label ?? p.displayName}
                </label>
              </li>
            ))}
          </ul>
          {error && <p className="error">{error}</p>}
          <div className="row end">
            <button type="button" className="ghost" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="submit" className="primary">
              Save group
            </button>
          </div>
        </form>
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
    <div className="card callout-card">
      {permission === "denied" ? (
        <p className="muted">
          Call alerts are blocked for this site. Allow notifications in your browser's site settings
          to get calls when the app is closed.
        </p>
      ) : (
        <>
          <div>
            <b>Get calls when the app is closed</b>
            <p className="muted">Your phone or computer rings even when this tab isn't open.</p>
          </div>
          <button className="secondary" onClick={() => void enablePush().then(setPermission)}>
            Turn on call alerts
          </button>
        </>
      )}
    </div>
  );
}
