import {
  Box,
  EllipsisVertical,
  Hand,
  House as Home,
  LayoutGrid,
  Lock,
  LockOpen,
  MessageSquare,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Settings,
  Smile,
  Sparkles,
  SwitchCamera,
  UserPlus,
  Users,
  Video,
  VideoOff,
  Volume2,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { PoseSender, SAMPLE_ROOM_LAYOUT, scannedRoomLayout, spawnPointFor } from "@vcr/engine";
import {
  EmoteId,
  type JoinSessionResponse,
  LocoState,
  type RoomInfo,
  type SceneAssets,
} from "@vcr/protocol";
import { api, ApiRequestError } from "../lib/api";
import { readDeviceProfile } from "../lib/device";
import { useNow } from "../lib/hooks";
import { useLive } from "../lib/live";
import { type RealmStatus, useRealmSession } from "../lib/realm";
import { SpatialAudio } from "../media/SpatialAudio";
import { useFaceTracking } from "../media/useFaceTracking";
import { type MediaState, useMedia } from "../media/useMedia";
import type { Autopilot } from "../world/World";
import { Filmstrip, VideoStage } from "./CallTiles";
import { EMOTE_GLYPHS } from "./emotes";
import { InvitePanel } from "./InvitePanel";
import { DeviceSelect, type JoinChoice, PreJoin, rememberedDevices, useDevices } from "./PreJoin";
import { type PanelTab, SidePanel } from "./SidePanel";
import { Dialog, elapsed } from "./ui";

// Three.js, Spark, Rapier and three-vrm are large; load them only when entering the room view.
const World = lazy(() => import("../world/World"));
const debug = new URLSearchParams(window.location.search).has("debug");
const VIEW_KEY = "vcr.callView";

export interface SessionScreenProps {
  sessionId: string;
  /** Fetches a fresh realm ticket; called before every (re)join. */
  join(): Promise<JoinSessionResponse>;
  title: string;
  subtitle?: string;
  displayName: string;
  isGuest: boolean;
  onExit(): void;
  /** Skip the pre-join check (the caller already chose, e.g. while their call rang). */
  entered?: { choice: JoinChoice; audio: SpatialAudio };
}

/** Pre-join check, then the call itself. */
export function SessionScreen(props: SessionScreenProps) {
  const [entered, setEntered] = useState<{ choice: JoinChoice; audio: SpatialAudio } | null>(
    props.entered ?? null,
  );
  // Audio we made at the Join click is ours to close; audio handed in belongs to the caller.
  const handedIn = props.entered?.audio;
  useEffect(
    () => () => {
      if (entered && entered.audio !== handedIn) entered.audio.dispose();
    },
    [entered, handedIn],
  );

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
  ended: { title: "The call has ended", body: "Thanks for coming!" },
  removed: { title: "You were removed", body: "A host removed you from this call." },
  locked: { title: "This call is locked", body: "The host isn't letting new people in." },
  error: { title: "Couldn't join", body: "This link or invite doesn't work anymore." },
};

const NOTICE_COPY = {
  mutedByHost: "A host muted you.",
  cameraOffByHost: "A host turned off your camera.",
  promoted: "You're now a co-host.",
  demoted: "You're no longer a co-host.",
  nowHost: "You're the host now.",
} as const;

const debugHooks = () => {
  try {
    return localStorage.getItem("vcr.debugHooks") === "1";
  } catch {
    return false;
  }
};

const isTouch = () => window.matchMedia("(pointer: coarse)").matches;
const canShareScreen = () =>
  typeof navigator.mediaDevices?.getDisplayMedia === "function" && !isTouch();

function InSession(props: SessionScreenProps & { choice: JoinChoice; audio: SpatialAudio }) {
  const { audio } = props;
  const realm = useRealmSession(props.join, props.sessionId);
  const seating = useMemo(
    () => ({ claims: realm.seats, selfId: realm.selfId, sit: realm.sit, stand: realm.stand }),
    [realm.seats, realm.selfId, realm.sit, realm.stand],
  );
  const media = useMedia(realm, audio, props.choice);
  const [profile] = useState(readDeviceProfile);
  const [view, setView] = useState<"grid" | "room">(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "room" ? "room" : "grid";
    } catch {
      return "grid";
    }
  });
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [dialog, setDialog] = useState<"invite" | "leave" | "settings" | "room" | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const autopilotRef = useRef<Autopilot>({ targetId: null });
  // Mirroring your face follows your camera until you choose otherwise.
  const [faceChoice, setFaceChoice] = useState<boolean | null>(null);
  // Face tracking is heavy for phones; there it starts off.
  const faceOn = view === "room" && (faceChoice ?? (media.cameraOn && !isTouch()));
  const selfVideo = realm.selfId ? media.videos.get(realm.selfId) : undefined;
  const face = useFaceTracking(faceOn, selfVideo?.mediaStreamTrack ?? null);
  const now = useNow(250);
  const [joinedAt] = useState(Date.now);
  const [roomNotice, setRoomNotice] = useState<{ name: string; at: number } | null>(null);
  const needsSound = useNeedsUnlock(audio);
  const me = realm.participants.find((p) => p.id === realm.selfId);
  const ringing = useRinging(props.sessionId, props.isGuest, realm.participants);

  // The room loads from the first join and again only when the host moves the call to another
  // room; rejoins (reconnects) re-sign the same assets, which are already loaded.
  const [scene, setScene] = useState<SceneAssets | null | undefined>(undefined);
  const [sceneRoom, setSceneRoom] = useState<{ id: string; name: string } | null>(null);
  const joined = realm.joinInfo;
  if (joined && joined.room.id !== sceneRoom?.id) {
    if (sceneRoom) setRoomNotice({ name: joined.room.name, at: now });
    setSceneRoom({ id: joined.room.id, name: joined.room.name });
    setScene(joined.scene);
  }

  // In the grid your avatar still stands in the room, so people in the room view see you.
  const selfUserId = me?.userId;
  useEffect(() => {
    if (view === "room" || !selfUserId || scene === undefined) return;
    const layout = scene ? scannedRoomLayout(scene.manifest) : SAMPLE_ROOM_LAYOUT;
    const spot = spawnPointFor(selfUserId, layout);
    const sender = new PoseSender((bytes) => realm.poseHub.send(bytes));
    const timer = setInterval(() => {
      sender.update(performance.now(), {
        position: [spot.position[0], spot.position[1] - 0.05, spot.position[2]],
        yaw: spot.yaw,
        loco: LocoState.idle,
      });
    }, 250);
    return () => clearInterval(timer);
  }, [view, selfUserId, scene, realm.poseHub]);

  // Voices are placed in the room view, and straight ahead in the grid.
  useEffect(() => audio.setSpatial(view === "room"), [audio, view]);
  useEffect(() => {
    if (props.choice.speaker) void audio.setOutputDevice(props.choice.speaker).catch(() => {});
  }, [audio, props.choice.speaker]);
  const changeView = (next: "grid" | "room") => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // fine
    }
  };

  // Lets end-to-end checks (scripts/call-check.ts) look at media state, also in production
  // builds when that check asks for it.
  useEffect(() => {
    if (!import.meta.env.DEV && !debugHooks()) return;
    (window as { vcrDebug?: unknown }).vcrDebug = { media, audio, realm };
  });

  // Unread chat while the chat panel is closed.
  const [seenChat, setSeenChat] = useState(0);
  if (panel === "chat" && seenChat !== realm.chat.length) setSeenChat(realm.chat.length);
  const unread = realm.chat.length - seenChat;

  // Meet's shortcuts: Ctrl/⌘+D mic, Ctrl/⌘+E camera.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || media.status !== "connected") return;
      if (e.key === "d") {
        e.preventDefault();
        media.setMic(!media.micOn);
      } else if (e.key === "e") {
        e.preventDefault();
        media.setCamera(!media.cameraOn);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [media]);

  const isOwner = me?.role === "owner";
  const isHost = isOwner || me?.role === "cohost";
  // Inviting goes through the API, where the room owner stays the session's host even after
  // handing the in-room host role to someone else.
  const canInvite = realm.joinInfo?.role === "owner";
  const connected = realm.status === "connected";
  const latestNotice = realm.notices.at(-1);
  const showNotice = latestNotice && now - latestNotice.at < 5000;

  const terminal = ENDED_COPY[realm.status];
  if (terminal) {
    return (
      <main className="call-ended">
        <div className="card link-card">
          <h1>{terminal.title}</h1>
          <p className="muted">{terminal.body}</p>
          {realm.status === "error" && realm.error && <p className="hint">{realm.error}</p>}
          <div className="row center">
            {realm.status === "locked" && (
              <button className="secondary" onClick={realm.retry}>
                Try again
              </button>
            )}
            <button className="primary" onClick={props.onExit}>
              {props.isGuest ? "Close" : "Back home"}
            </button>
          </div>
        </div>
      </main>
    );
  }

  const selfId = realm.selfId ?? "";
  const pin = (id: string | null) => {
    setPinned(id);
    if (id) changeView("grid");
  };

  return (
    <div className={`call${panel ? " with-panel" : ""}`}>
      <div className="call-stage">
        {view === "room" ? (
          <div className="room-view">
            {scene === undefined ? (
              <div className="world-loading">Loading room…</div>
            ) : (
              <Suspense fallback={<div className="world-loading">Loading room…</div>}>
                <World
                  key={sceneRoom?.id}
                  scene={scene}
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
                  seating={seating}
                  games={realm.games}
                />
              </Suspense>
            )}
            <Filmstrip
              participants={realm.participants}
              selfId={selfId}
              media={media}
              audio={audio}
              emotes={realm.emotes}
              pinned={pinned}
              onPin={pin}
              onWalkTo={(id) => {
                autopilotRef.current.targetId = id;
              }}
            />
          </div>
        ) : connected && realm.selfId ? (
          <VideoStage
            participants={realm.participants}
            selfId={selfId}
            media={media}
            emotes={realm.emotes}
            pinned={pinned}
            onPin={setPinned}
            ringing={ringing}
            onInvite={canInvite ? () => setDialog("invite") : undefined}
          />
        ) : (
          <div className="world-loading">
            {realm.status === "reconnecting" ? "Reconnecting…" : "Joining…"}
          </div>
        )}

        <div className="call-top">
          <span className="call-title">
            {props.title}
            {(sceneRoom?.name ?? props.subtitle) && (
              <span className="muted"> · {sceneRoom?.name ?? props.subtitle}</span>
            )}
          </span>
          {realm.locked && (
            <span className="badge">
              <Lock size={14} /> Locked
            </span>
          )}
          {media.status !== "connected" && media.status !== "off" && (
            <span className="badge warn">
              {media.status === "failed" ? "No audio/video" : "Connecting audio…"}
            </span>
          )}
        </div>

        {needsSound && (
          <button className="sound-unlock" onClick={() => void audio.resume()}>
            <Volume2 size={18} /> Tap to turn on sound
          </button>
        )}
        {showNotice && (
          <p className="toast" role="status">
            {NOTICE_COPY[latestNotice.kind]}
          </p>
        )}
        {roomNotice && now - roomNotice.at < 5000 && (
          <p className="toast" role="status">
            The call moved to {roomNotice.name}.
          </p>
        )}
        {media.status === "failed" && media.error && (
          <p className="banner" role="status">
            {media.error} You can still see people and chat.
          </p>
        )}
        {media.error && media.status === "connected" && (
          <p className="banner" role="status">
            {media.error}
          </p>
        )}
      </div>

      {panel && (
        <SidePanel
          tab={panel}
          onTab={setPanel}
          onClose={() => setPanel(null)}
          realm={realm}
          audio={audio}
          pinned={pinned}
          onPin={pin}
          canInvite={canInvite}
          onInvite={() => setDialog("invite")}
        />
      )}

      <ControlBar
        media={media}
        connected={connected}
        elapsedText={elapsed((now - joinedAt) / 1000)}
        title={props.title}
        view={view}
        onView={changeView}
        handRaised={me?.handRaised ?? false}
        onHand={() => realm.raiseHand(!me?.handRaised)}
        onEmote={(id) => realm.sendEmote(id)}
        faceOn={faceOn}
        faceStatus={face.status}
        onFace={() => setFaceChoice(!faceOn)}
        isHost={isHost}
        locked={realm.locked}
        onLock={() => realm.setLocked(!realm.locked)}
        canInvite={canInvite}
        onInvite={() => setDialog("invite")}
        onChangeRoom={canInvite ? () => setDialog("room") : undefined}
        onSettings={() => setDialog("settings")}
        peopleCount={realm.participants.length}
        panel={panel}
        onPanel={(tab) => setPanel(panel === tab ? null : tab)}
        unread={unread}
        onLeave={() => (isOwner ? setDialog("leave") : props.onExit())}
      />

      {dialog === "invite" && (
        <InvitePanel sessionId={props.sessionId} onClose={() => setDialog(null)} />
      )}
      {dialog === "room" && (
        <ChangeRoomDialog
          sessionId={props.sessionId}
          currentRoomId={sceneRoom?.id ?? null}
          onMoved={() => {
            realm.announceRoomChange();
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "settings" && (
        <SettingsDialog media={media} audio={audio} onClose={() => setDialog(null)} />
      )}
      {dialog === "leave" && (
        <Dialog title="Leave the call?" onClose={() => setDialog(null)}>
          <p className="muted">
            You're the host. If you leave, the call keeps going for a couple of minutes so you can
            come back; ending it hangs up for everyone.
          </p>
          <div className="stack">
            <button className="secondary" onClick={props.onExit}>
              Leave the call
            </button>
            <button
              className="danger"
              onClick={() => {
                realm.endSession();
                props.onExit();
              }}
            >
              End the call for everyone
            </button>
            <button className="ghost" onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

/** Whether the browser is holding back sound until the next tap (autoplay, iOS interruptions). */
function useNeedsUnlock(audio: SpatialAudio) {
  const [needs, setNeeds] = useState(audio.needsUnlock);
  useEffect(() => {
    const update = () => setNeeds(audio.needsUnlock);
    const off = audio.onStateChange(update);
    // Any tap is a chance to resume, like most call apps do.
    const resume = () => {
      if (audio.needsUnlock) void audio.resume();
    };
    window.addEventListener("pointerdown", resume);
    update();
    return () => {
      off();
      window.removeEventListener("pointerdown", resume);
    };
  }, [audio]);
  return needs;
}

/** People you rang who haven't joined yet, for "Calling…" tiles. Hosts and members only. */
function useRinging(
  sessionId: string,
  isGuest: boolean,
  participants: Array<{ userId: string }>,
): Array<{ userId: string; displayName: string }> {
  const sessionsVersion = useLive((s) => s.sessionsVersion);
  const [invites, setInvites] = useState<
    Array<{ userId: string; displayName: string; status: string }>
  >([]);
  useEffect(() => {
    if (isGuest) return;
    let active = true;
    void api.session(sessionId).then(
      (info) => active && setInvites(info.invites),
      () => {},
    );
    return () => {
      active = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- sessionsVersion triggers the refetch
  }, [sessionId, isGuest, sessionsVersion]);
  const here = new Set(participants.map((p) => p.userId));
  return invites.filter((i) => i.status === "ringing" && !here.has(i.userId));
}

function ControlBar(props: {
  media: MediaState;
  connected: boolean;
  elapsedText: string;
  title: string;
  view: "grid" | "room";
  onView(view: "grid" | "room"): void;
  handRaised: boolean;
  onHand(): void;
  onEmote(id: EmoteId): void;
  faceOn: boolean;
  faceStatus: string;
  onFace(): void;
  isHost: boolean;
  locked: boolean;
  onLock(): void;
  canInvite: boolean;
  onInvite(): void;
  onChangeRoom?: (() => void) | undefined;
  onSettings(): void;
  peopleCount: number;
  panel: PanelTab | null;
  onPanel(tab: PanelTab): void;
  unread: number;
  onLeave(): void;
}) {
  const { media } = props;
  const [popup, setPopup] = useState<"emotes" | "more" | null>(null);
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!popup) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as Element).closest?.(".popup-anchor")) setPopup(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [popup]);
  const mediaReady = media.status === "connected";
  const touch = isTouch();

  return (
    <footer className="control-bar" ref={bar} role="toolbar" aria-label="Call controls">
      <div className="bar-left">
        <span className="bar-time">{props.elapsedText}</span>
        <span className="bar-title">{props.title}</span>
      </div>

      <div className="bar-center">
        <button
          className={`round${media.micOn ? "" : " off"}`}
          onClick={() => media.setMic(!media.micOn)}
          disabled={!mediaReady}
          aria-pressed={!media.micOn}
          aria-label={media.micOn ? "Turn off microphone" : "Turn on microphone"}
          title={media.micOn ? "Mute (Ctrl+D)" : "Unmute (Ctrl+D)"}
        >
          {media.micOn ? <Mic size={22} /> : <MicOff size={22} />}
        </button>
        <button
          className={`round${media.cameraOn ? "" : " off"}`}
          onClick={() => media.setCamera(!media.cameraOn)}
          disabled={!mediaReady}
          aria-pressed={!media.cameraOn}
          aria-label={media.cameraOn ? "Turn off camera" : "Turn on camera"}
          title={media.cameraOn ? "Stop video (Ctrl+E)" : "Start video (Ctrl+E)"}
        >
          {media.cameraOn ? <Video size={22} /> : <VideoOff size={22} />}
        </button>
        {touch && media.cameraOn && (
          <button className="round" onClick={media.flipCamera} aria-label="Switch camera">
            <SwitchCamera size={22} />
          </button>
        )}
        {canShareScreen() && (
          <button
            className={`round${media.screenSharing ? " active" : ""}`}
            onClick={() => media.setScreenShare(!media.screenSharing)}
            disabled={!mediaReady}
            aria-pressed={media.screenSharing}
            aria-label={media.screenSharing ? "Stop presenting" : "Present your screen"}
            title={media.screenSharing ? "Stop presenting" : "Present your screen"}
          >
            <MonitorUp size={22} />
          </button>
        )}
        <div className="popup-anchor wide-only">
          <button
            className={`round${popup === "emotes" ? " active" : ""}`}
            onClick={() => setPopup(popup === "emotes" ? null : "emotes")}
            disabled={!props.connected}
            aria-label="Reactions"
            aria-expanded={popup === "emotes"}
          >
            <Smile size={22} />
          </button>
          {popup === "emotes" && (
            <div className="popup emotes-popup" role="menu">
              {EmoteId.options.map((id) => (
                <button key={id} onClick={() => props.onEmote(id)} aria-label={id} role="menuitem">
                  {EMOTE_GLYPHS[id]}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          className={`round wide-only${props.handRaised ? " active" : ""}`}
          onClick={props.onHand}
          disabled={!props.connected}
          aria-pressed={props.handRaised}
          aria-label={props.handRaised ? "Lower hand" : "Raise hand"}
          title={props.handRaised ? "Lower hand" : "Raise hand"}
        >
          <Hand size={22} />
        </button>
        <button
          className={`round${props.view === "room" ? " active" : ""}`}
          onClick={() => props.onView(props.view === "room" ? "grid" : "room")}
          aria-label={props.view === "room" ? "Show video grid" : "Show the 3D room"}
          title={props.view === "room" ? "Video grid" : "3D room"}
        >
          {props.view === "room" ? <LayoutGrid size={22} /> : <Box size={22} />}
        </button>
        <div className="popup-anchor">
          <button
            className={`round${popup === "more" ? " active" : ""}`}
            onClick={() => setPopup(popup === "more" ? null : "more")}
            aria-label="More options"
            aria-expanded={popup === "more"}
          >
            <EllipsisVertical size={22} />
            {props.unread > 0 && <span className="dot-badge narrow-only">{props.unread}</span>}
          </button>
          {popup === "more" && (
            <div className="popup menu" role="menu" onClick={() => setPopup(null)}>
              <div className="narrow-only menu-emotes" aria-label="Reactions">
                {EmoteId.options.map((id) => (
                  <button
                    key={id}
                    onClick={() => props.onEmote(id)}
                    aria-label={id}
                    disabled={!props.connected}
                  >
                    {EMOTE_GLYPHS[id]}
                  </button>
                ))}
              </div>
              <button role="menuitem" className="narrow-only" onClick={props.onHand}>
                <Hand size={18} /> {props.handRaised ? "Lower hand" : "Raise hand"}
              </button>
              <button
                role="menuitem"
                className="narrow-only"
                onClick={() => props.onPanel("people")}
              >
                <Users size={18} /> People ({props.peopleCount})
              </button>
              <button role="menuitem" className="narrow-only" onClick={() => props.onPanel("chat")}>
                <MessageSquare size={18} /> Chat{props.unread > 0 ? ` (${props.unread} new)` : ""}
              </button>
              {props.canInvite && (
                <button role="menuitem" onClick={props.onInvite}>
                  <UserPlus size={18} /> Add people
                </button>
              )}
              <button
                role="menuitem"
                onClick={() => media.setBlur(!media.blur)}
                disabled={!media.cameraOn}
              >
                <Sparkles size={18} />{" "}
                {media.blur ? "Stop blurring my background" : "Blur my background"}
              </button>
              {props.onChangeRoom && (
                <button role="menuitem" onClick={props.onChangeRoom}>
                  <Home size={18} /> Change room…
                </button>
              )}
              <button role="menuitem" onClick={props.onSettings}>
                <Settings size={18} /> Audio and video settings
              </button>
              {props.view === "room" && (
                <button role="menuitem" onClick={props.onFace}>
                  <Smile size={18} />{" "}
                  {props.faceStatus === "starting"
                    ? "Starting face tracking…"
                    : props.faceOn
                      ? "Stop copying my expressions"
                      : "Avatar copies my expressions"}
                </button>
              )}
              {props.isHost && (
                <button role="menuitem" onClick={props.onLock}>
                  {props.locked ? <LockOpen size={18} /> : <Lock size={18} />}{" "}
                  {props.locked ? "Unlock the call" : "Lock the call"}
                </button>
              )}
              {document.fullscreenEnabled && (
                <button
                  role="menuitem"
                  onClick={() =>
                    void (
                      document.fullscreenElement
                        ? document.exitFullscreen()
                        : document.documentElement.requestFullscreen()
                    ).catch(() => {})
                  }
                >
                  {document.fullscreenElement ? "Exit full screen" : "Full screen"}
                </button>
              )}
            </div>
          )}
        </div>
        <button
          className="round hangup"
          onClick={props.onLeave}
          aria-label="Leave call"
          title="Leave call"
        >
          <PhoneOff size={22} />
        </button>
      </div>

      <div className="bar-right wide-only">
        <button
          className={`round small${props.panel === "people" ? " active" : ""}`}
          onClick={() => props.onPanel("people")}
          aria-label="People"
          title="People"
        >
          <Users size={20} />
          <span className="count">{props.peopleCount}</span>
        </button>
        <button
          className={`round small${props.panel === "chat" ? " active" : ""}`}
          onClick={() => props.onPanel("chat")}
          aria-label={props.unread ? `Chat, ${props.unread} unread` : "Chat"}
          title="Chat"
        >
          <MessageSquare size={20} />
          {props.unread > 0 && <span className="dot-badge">{props.unread}</span>}
        </button>
      </div>
    </footer>
  );
}

function SettingsDialog(props: { media: MediaState; audio: SpatialAudio; onClose(): void }) {
  const { mics, cameras, speakers } = useDevices(true);
  const [chosen, setChosen] = useState(rememberedDevices);
  const pick = (patch: Partial<typeof chosen>) => {
    const next = { ...chosen, ...patch };
    setChosen(next);
    try {
      localStorage.setItem("vcr.devices", JSON.stringify(next));
    } catch {
      // fine
    }
  };
  return (
    <Dialog title="Audio and video" onClose={props.onClose}>
      <div className="stack">
        <DeviceSelect
          label="Microphone"
          devices={mics}
          value={chosen.mic}
          onChange={(id) => {
            pick({ mic: id });
            props.media.switchDevice("audioinput", id);
          }}
        />
        <DeviceSelect
          label="Camera"
          devices={cameras}
          value={chosen.camera}
          onChange={(id) => {
            pick({ camera: id });
            props.media.switchDevice("videoinput", id);
          }}
        />
        {SpatialAudio.canChooseOutput && (
          <DeviceSelect
            label="Speaker"
            devices={speakers}
            value={chosen.speaker}
            onChange={(id) => {
              pick({ speaker: id });
              void props.audio.setOutputDevice(id).catch(() => {});
            }}
          />
        )}
        {mics.length < 2 && cameras.length < 2 && (
          <p className="muted">This device has one microphone and one camera.</p>
        )}
      </div>
    </Dialog>
  );
}

/** Host: move everyone to another of your rooms (the sample room, or a scan). */
function ChangeRoomDialog(props: {
  sessionId: string;
  currentRoomId: string | null;
  onMoved(): void;
  onClose(): void;
}) {
  const [rooms, setRooms] = useState<RoomInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.rooms().then(
      (r) => setRooms(r.rooms.filter((room) => room.status === "ready")),
      () => setError("Couldn't load your rooms."),
    );
  }, []);
  async function move(roomId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.changeRoom(props.sessionId, roomId);
      props.onMoved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : "Couldn't change the room.");
      setBusy(false);
    }
  }
  return (
    <Dialog title="Change room" onClose={props.onClose}>
      <p className="muted">Everyone in the call moves with you.</p>
      {!rooms ? (
        <p className="muted">Loading rooms…</p>
      ) : (
        <ul className="rows">
          {rooms.map((r) => (
            <li key={r.id}>
              <span className="grow">
                <b>{r.name}</b>
                <span className="muted">
                  {r.kind === "sample"
                    ? "Built-in sample room"
                    : r.scan
                      ? `Your scan · ${r.scan.size.width.toFixed(1)} × ${r.scan.size.depth.toFixed(1)} m`
                      : "Your scan"}
                </span>
              </span>
              {r.id === props.currentRoomId ? (
                <span className="muted">Here now</span>
              ) : (
                <button className="primary small" disabled={busy} onClick={() => void move(r.id)}>
                  Move here
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </Dialog>
  );
}
