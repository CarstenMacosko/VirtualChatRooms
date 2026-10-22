import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { EmoteId, type JoinSessionResponse } from "@vcr/protocol";
import { readDeviceProfile } from "../lib/device";
import { useNow } from "../lib/hooks";
import { type RealmStatus, useRealmSession } from "../lib/realm";
import { SpatialAudio } from "../media/SpatialAudio";
import { useMedia } from "../media/useMedia";
import { EMOTE_GLYPHS } from "./emotes";
import { InvitePanel } from "./InvitePanel";
import { type JoinChoice, PreJoin } from "./PreJoin";
import { colorFor } from "./emotes";
import { useFaceTracking } from "../media/useFaceTracking";
import { Headshot, VideoSidebar, VideoView } from "./VideoSidebar";
import type { Autopilot } from "../world/World";

// Three.js, Spark, Rapier and three-vrm are large; load them only when entering a room.
const World = lazy(() => import("../world/World"));
const debug = new URLSearchParams(window.location.search).has("debug");

export interface SessionScreenProps {
  sessionId: string;
  /** Fetches a fresh realm ticket; called before every (re)join. */
  join(): Promise<JoinSessionResponse>;
  title: string;
  subtitle?: string;
  displayName: string;
  isGuest: boolean;
  onExit(): void;
}

/** Pre-join check, then the gathering itself. */
export function SessionScreen(props: SessionScreenProps) {
  const [entered, setEntered] = useState<{ choice: JoinChoice; audio: SpatialAudio } | null>(null);
  useEffect(() => () => entered?.audio.dispose(), [entered]);

  if (!entered) {
    return (
      <PreJoin
        title={props.title}
        subtitle={props.subtitle}
        name={props.displayName}
        onCancel={props.onExit}
        onJoin={(choice) => {
          // Created inside the click so the browser lets it play sound.
          const audio = new SpatialAudio();
          void audio.resume();
          setEntered({ choice, audio });
        }}
      />
    );
  }
  return <InSession {...props} choice={entered.choice} audio={entered.audio} />;
}

const ENDED_COPY: Partial<Record<RealmStatus, { title: string; body: string }>> = {
  ended: { title: "This gathering has ended", body: "Thanks for coming!" },
  removed: { title: "You were removed", body: "A host removed you from this gathering." },
  locked: { title: "This gathering is locked", body: "The host isn't letting new people in." },
  error: { title: "Couldn't join", body: "This link or invite doesn't work anymore." },
};

const NOTICE_COPY = {
  mutedByHost: "A host muted you.",
  cameraOffByHost: "A host turned off your camera.",
  promoted: "You're now a co-host.",
  demoted: "You're no longer a co-host.",
  nowHost: "You're the host now.",
} as const;

function InSession(props: SessionScreenProps & { choice: JoinChoice; audio: SpatialAudio }) {
  const { audio } = props;
  const realm = useRealmSession(props.join, props.sessionId);
  const media = useMedia(realm, audio, props.choice);
  const [profile] = useState(readDeviceProfile);
  const [inviting, setInviting] = useState(false);
  const [pinned, setPinned] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const autopilotRef = useRef<Autopilot>({ targetId: null });
  // Mirroring your face follows your camera until you choose otherwise with the button.
  const [faceChoice, setFaceChoice] = useState<boolean | null>(null);
  const faceOn = faceChoice ?? media.cameraOn;
  const selfVideo = realm.selfId ? media.videos.get(realm.selfId) : undefined;
  const face = useFaceTracking(faceOn, selfVideo?.mediaStreamTrack ?? null);
  const now = useNow(250);

  const me = realm.participants.find((p) => p.id === realm.selfId);
  const isOwner = me?.role === "owner";
  const isHost = isOwner || me?.role === "cohost";
  // Inviting goes through the API, where the room owner stays the session's host even after
  // handing the in-room host role to someone else.
  const canInvite = realm.joinInfo?.role === "owner";
  const pinnedPerson = realm.participants.find((p) => p.id === pinned);
  const pinnedVideo = pinned ? media.videos.get(pinned) : undefined;
  const connected = realm.status === "connected";
  const latestNotice = realm.notices.at(-1);
  const showNotice = latestNotice && now - latestNotice.at < 5000;

  const terminal = ENDED_COPY[realm.status];
  if (terminal) {
    return (
      <main className="signin">
        <div className="card">
          <h1>{terminal.title}</h1>
          <p className="muted">{terminal.body}</p>
          {realm.status === "error" && realm.error && <p className="hint">{realm.error}</p>}
          <div className="row end">
            {realm.status === "locked" && (
              <button className="secondary" onClick={realm.retry}>
                Try again
              </button>
            )}
            <button onClick={props.onExit}>{props.isGuest ? "Close" : "Back home"}</button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <div className="lobby">
      <header className="topbar">
        <strong>{props.title}</strong>
        {props.subtitle && <span className="session">{props.subtitle}</span>}
        <span className={`pill ${connected ? "ok" : "bad"}`} title={realm.error ?? "Room server"}>
          Room · {realm.status}
        </span>
        <span
          className={`pill ${media.status === "connected" ? "ok" : "bad"}`}
          title={media.error ?? "Voice and video"}
        >
          Voice · {media.status}
        </span>
        {realm.locked && <span className="pill">🔒 Locked</span>}
        <span className="spacer" />
        <span className="muted">{props.displayName}</span>
      </header>

      <main className={`stage${sidebarOpen ? "" : " no-sidebar"}`}>
        <div className="scene">
          <Suspense fallback={<div className="world-loading">Loading room…</div>}>
            <World
              participants={realm.participants}
              selfId={realm.selfId}
              emotes={realm.emotes}
              now={now}
              poseHub={realm.poseHub}
              audio={audio}
              autopilotRef={autopilotRef}
              trackedFaceRef={face.faceRef}
              profile={profile}
              debug={debug}
            />
          </Suspense>
          {pinnedPerson && (
            <div className="pinned-view" onDoubleClick={() => setPinned(null)}>
              {pinnedVideo && (pinnedPerson.cameraOn || pinnedPerson.id === realm.selfId) ? (
                <VideoView track={pinnedVideo} mirror={pinnedPerson.id === realm.selfId} />
              ) : (
                <Headshot
                  id={pinnedPerson.id}
                  color={colorFor(pinnedPerson.userId)}
                  name={pinnedPerson.name}
                />
              )}
              <span className="pinned-name">{pinnedPerson.name}</span>
              <button className="tile-more" aria-label="Unpin" onClick={() => setPinned(null)}>
                ✕
              </button>
            </div>
          )}
          {!sidebarOpen && (
            <button className="sidebar-open secondary" onClick={() => setSidebarOpen(true)}>
              ⟨ People {realm.participants.length}
            </button>
          )}
          {showNotice && (
            <p className="toast" role="status">
              {NOTICE_COPY[latestNotice.kind]}
            </p>
          )}
          {media.status === "failed" && media.error && (
            <p className="banner muted" role="status">
              {media.error} You can still move around and use emotes.
            </p>
          )}
        </div>
        {sidebarOpen && (
          <VideoSidebar
            realm={realm}
            media={media}
            audio={audio}
            pinned={pinned}
            onPin={setPinned}
            onWalkTo={(id) => {
              autopilotRef.current.targetId = id;
            }}
            onCollapse={() => setSidebarOpen(false)}
          />
        )}
      </main>

      <footer className="bottombar" role="toolbar" aria-label="Call controls">
        <button
          className={media.micOn ? "toggle on" : "toggle"}
          onClick={() => media.setMic(!media.micOn)}
          disabled={media.status !== "connected"}
          aria-pressed={media.micOn}
        >
          {media.micOn ? "🎙️ Mute" : "🔇 Unmute"}
        </button>
        <button
          className={media.cameraOn ? "toggle on" : "toggle"}
          onClick={() => media.setCamera(!media.cameraOn)}
          disabled={media.status !== "connected"}
          aria-pressed={media.cameraOn}
        >
          {media.cameraOn ? "📷 Stop video" : "🚫 Start video"}
        </button>
        <button
          className={faceOn ? "toggle on" : "toggle"}
          onClick={() => setFaceChoice(!faceOn)}
          aria-pressed={faceOn}
          title={
            face.error ??
            "Your avatar copies your expressions using your camera. Video stays on this device."
          }
        >
          {face.status === "starting" ? "🙂 Starting…" : faceOn ? "😀 Face on" : "🙂 Face off"}
        </button>
        <div className="emotes" aria-label="Emotes">
          {EmoteId.options.map((id) => (
            <button
              key={id}
              onClick={() => realm.sendEmote(id)}
              disabled={!connected}
              aria-label={id}
            >
              {EMOTE_GLYPHS[id]}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {canInvite && (
          <button className="secondary" onClick={() => setInviting(true)}>
            Invite
          </button>
        )}
        {isHost && (
          <button className="secondary" onClick={() => realm.setLocked(!realm.locked)}>
            {realm.locked ? "🔓 Unlock" : "🔒 Lock"}
          </button>
        )}
        <button className="secondary" onClick={props.onExit}>
          Leave
        </button>
        {isOwner && (
          <button
            className="danger"
            onClick={() => {
              if (confirm("End this gathering for everyone?")) realm.endSession();
            }}
          >
            End for all
          </button>
        )}
      </footer>
      {inviting && <InvitePanel sessionId={props.sessionId} onClose={() => setInviting(false)} />}
    </div>
  );
}
