import {
  EllipsisVertical,
  Hand,
  Mic,
  MicOff,
  Send,
  UserPlus,
  Video,
  VideoOff,
  X,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  canModerate,
  type ChatBroadcast,
  type ParticipantRole,
  type ParticipantView,
} from "@vcr/protocol";
import type { RealmSession } from "../lib/realm";
import type { SpatialAudio } from "../media/SpatialAudio";
import { Avatar } from "./ui";

const ROLE_LABEL: Partial<Record<ParticipantRole, string>> = {
  owner: "Host",
  cohost: "Co-host",
  guest: "Guest",
};

export type PanelTab = "people" | "chat";

/** The call's side panel, like Meet's: who's here (with host controls) and chat. */
export function SidePanel(props: {
  tab: PanelTab;
  onTab(tab: PanelTab): void;
  onClose(): void;
  realm: RealmSession;
  audio: SpatialAudio;
  pinned: string | null;
  onPin(id: string | null): void;
  canInvite: boolean;
  onInvite(): void;
}) {
  return (
    <aside className="side-panel" aria-label={props.tab === "people" ? "People" : "Chat"}>
      <header>
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={props.tab === "people"}
            className={props.tab === "people" ? "on" : ""}
            onClick={() => props.onTab("people")}
          >
            People ({props.realm.participants.length})
          </button>
          <button
            role="tab"
            aria-selected={props.tab === "chat"}
            className={props.tab === "chat" ? "on" : ""}
            onClick={() => props.onTab("chat")}
          >
            Chat
          </button>
        </div>
        <button className="icon-button" onClick={props.onClose} aria-label="Close panel">
          <X size={20} />
        </button>
      </header>
      {props.tab === "people" ? <People {...props} /> : <Chat realm={props.realm} />}
    </aside>
  );
}

function People(props: {
  realm: RealmSession;
  audio: SpatialAudio;
  pinned: string | null;
  onPin(id: string | null): void;
  canInvite: boolean;
  onInvite(): void;
}) {
  const { realm } = props;
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const me = realm.participants.find((p) => p.id === realm.selfId);
  // Hands up first, then hosts, then everyone by name.
  const sorted = [...realm.participants].sort(
    (a, b) =>
      Number(b.handRaised) - Number(a.handRaised) ||
      Number(b.role === "owner") - Number(a.role === "owner") ||
      a.name.localeCompare(b.name),
  );
  return (
    <div className="panel-body">
      {props.canInvite && (
        <button className="secondary full" onClick={props.onInvite}>
          <UserPlus size={18} /> Add people
        </button>
      )}
      <ul className="people">
        {sorted.map((p) => (
          <Person
            key={p.id}
            p={p}
            isSelf={p.id === realm.selfId}
            myRole={me?.role}
            pinned={props.pinned === p.id}
            menuOpen={menuFor === p.id}
            onMenu={(open) => setMenuFor(open ? p.id : null)}
            onPin={() => props.onPin(props.pinned === p.id ? null : p.id)}
            realm={realm}
            audio={props.audio}
          />
        ))}
      </ul>
    </div>
  );
}

function Person(props: {
  p: ParticipantView;
  isSelf: boolean;
  myRole: ParticipantRole | undefined;
  pinned: boolean;
  menuOpen: boolean;
  onMenu(open: boolean): void;
  onPin(): void;
  realm: RealmSession;
  audio: SpatialAudio;
}) {
  const { p, isSelf, myRole, realm, audio } = props;
  const [volume, setVolume] = useState(() => audio.volumeOf(p.id));
  const moderate = !isSelf && myRole !== undefined && canModerate(myRole, p.role);
  const promote = !isSelf && myRole === "owner" && (p.role === "member" || p.role === "cohost");
  const act = (fn: () => void) => () => {
    fn();
    props.onMenu(false);
  };
  return (
    <li className="person">
      <Avatar name={p.name} id={p.userId} size={36} />
      <span className="grow">
        <b>
          {p.name}
          {isSelf && " (you)"}
        </b>
        {ROLE_LABEL[p.role] && <span className="muted">{ROLE_LABEL[p.role]}</span>}
      </span>
      {p.handRaised && <Hand size={18} className="hand-icon" aria-label="Hand raised" />}
      {p.cameraOn ? (
        <Video size={18} aria-label="Camera on" />
      ) : (
        <VideoOff size={18} className="off" aria-label="Camera off" />
      )}
      {p.muted ? (
        <MicOff size={18} className="off" aria-label="Muted" />
      ) : (
        <Mic size={18} aria-label="Mic on" />
      )}
      <div className="menu-anchor">
        <button
          className="icon-button"
          aria-label={`Options for ${p.name}`}
          aria-expanded={props.menuOpen}
          onClick={() => props.onMenu(!props.menuOpen)}
        >
          <EllipsisVertical size={18} />
        </button>
        {props.menuOpen && (
          <div className="menu right" role="menu">
            <button role="menuitem" onClick={act(props.onPin)}>
              {props.pinned ? "Unpin" : "Pin to the screen"}
            </button>
            {!isSelf && (
              <label className="volume">
                Volume
                <input
                  type="range"
                  min={0}
                  max={2}
                  step={0.05}
                  value={volume}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setVolume(v);
                    audio.setVolume(p.id, v);
                  }}
                />
              </label>
            )}
            {moderate && (
              <>
                <button
                  role="menuitem"
                  onClick={act(() => realm.hostMute(p.id))}
                  disabled={p.muted}
                >
                  Mute
                </button>
                <button
                  role="menuitem"
                  onClick={act(() => realm.hostCameraOff(p.id))}
                  disabled={!p.cameraOn}
                >
                  Turn off camera
                </button>
                <button
                  role="menuitem"
                  className="danger-text"
                  onClick={act(() => {
                    if (confirm(`Remove ${p.name} from this call? They won't be able to rejoin.`)) {
                      realm.hostRemove(p.id);
                    }
                  })}
                >
                  Remove from call
                </button>
              </>
            )}
            {promote && (
              <button
                role="menuitem"
                onClick={act(() => realm.setCoHost(p.id, p.role !== "cohost"))}
              >
                {p.role === "cohost" ? "Remove co-host" : "Make co-host"}
              </button>
            )}
            {promote && (
              <button
                role="menuitem"
                onClick={act(() => {
                  if (confirm(`Make ${p.name} the host? You'll become a co-host.`)) {
                    realm.transferHost(p.id);
                  }
                })}
              >
                Make host
              </button>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

const time = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function Chat({ realm }: { realm: RealmSession }) {
  const [text, setText] = useState("");
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new message triggers the scroll
  }, [realm.chat.length]);
  function send(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (!message) return;
    realm.sendChat(message);
    setText("");
  }
  return (
    <div className="panel-body chat">
      <p className="hint">
        Messages are only seen by people in the call, and disappear when it ends.
      </p>
      <ol className="messages" ref={list}>
        {realm.chat.map((m: ChatBroadcast, i) => {
          const mine = m.from === realm.selfId;
          const sameAsPrevious = i > 0 && realm.chat[i - 1]!.from === m.from;
          return (
            <li key={`${m.at}-${i}`} className={mine ? "mine" : ""}>
              {!sameAsPrevious && (
                <span className="who">
                  <b>{mine ? "You" : m.name}</b> <span className="muted">{time(m.at)}</span>
                </span>
              )}
              <span className="bubble">{m.text}</span>
            </li>
          );
        })}
      </ol>
      <form className="chat-input" onSubmit={send}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Send a message"
          maxLength={500}
          aria-label="Message"
          // The 3D room listens for WASD; typing here mustn't walk you around (InputSystem skips
          // inputs, but keep focus visible).
        />
        <button className="icon-button" disabled={!text.trim()} aria-label="Send">
          <Send size={18} />
        </button>
      </form>
    </div>
  );
}
