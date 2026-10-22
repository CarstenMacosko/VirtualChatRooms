import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import { useEffect, useRef, useState } from "react";
import { orderTiles } from "@vcr/engine";
import { canModerate, type ParticipantRole, type ParticipantView } from "@vcr/protocol";
import { useNow } from "../lib/hooks";
import type { RealmSession } from "../lib/realm";
import type { SpatialAudio } from "../media/SpatialAudio";
import type { MediaState } from "../media/useMedia";
import { colorFor } from "./emotes";

const ROLE_LABEL: Partial<Record<ParticipantRole, string>> = {
  owner: "Host",
  cohost: "Co-host",
  guest: "Guest",
};

function VideoView({
  track,
  mirror,
}: {
  track: RemoteVideoTrack | LocalVideoTrack;
  mirror: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);
  return <video ref={ref} autoPlay playsInline muted className={mirror ? "mirror" : undefined} />;
}

const perfNow = () => performance.now();

/**
 * FaceTime-style video sidebar (PLAN.md § 4.6): you first, then whoever you pinned, then recent
 * speakers, then the nearest people. Tiles without a camera show the person's initial.
 */
export function VideoSidebar(props: {
  realm: RealmSession;
  media: MediaState;
  audio: SpatialAudio;
}) {
  const { realm, media, audio } = props;
  const [pinned, setPinned] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const now = useNow(1000, perfNow);
  const selfId = realm.selfId ?? "";
  const me = realm.participants.find((p) => p.id === selfId);
  const byId = new Map(realm.participants.map((p) => [p.id, p]));

  const [lx, , lz] = audio.listener.position;
  const distance = new Map<string, number>();
  for (const [id, at] of audio.positions) distance.set(id, Math.hypot(at[0] - lx, at[2] - lz));
  const order = orderTiles({
    selfId,
    ids: realm.participants.map((p) => p.id),
    pinnedId: pinned,
    lastSpokeAt: media.lastSpokeAt,
    distance,
    now,
  });

  return (
    <aside className="sidebar" aria-label="People in this gathering">
      <h2>
        People <span className="count">{realm.participants.length}</span>
      </h2>
      <ul>
        {order.map((id) => {
          const p = byId.get(id);
          if (!p) return null;
          return (
            <Tile
              key={id}
              p={p}
              isSelf={id === selfId}
              myRole={me?.role}
              pinned={pinned === id}
              speaking={media.speaking.has(id)}
              video={media.videos.get(id)}
              menuOpen={menuFor === id}
              onMenu={(open) => setMenuFor(open ? id : null)}
              onPin={() => setPinned(pinned === id ? null : id)}
              realm={realm}
              audio={audio}
            />
          );
        })}
      </ul>
    </aside>
  );
}

function Tile(props: {
  p: ParticipantView;
  isSelf: boolean;
  myRole: ParticipantRole | undefined;
  pinned: boolean;
  speaking: boolean;
  video: RemoteVideoTrack | LocalVideoTrack | undefined;
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
    <li className={`tile${props.speaking ? " speaking" : ""}${props.pinned ? " pinned" : ""}`}>
      <div className="tile-media">
        {/* Others' camera state comes from the realm, so a muted track shows their initial. */}
        {props.video && (isSelf || p.cameraOn) ? (
          <VideoView track={props.video} mirror={isSelf} />
        ) : (
          <div className="tile-face" style={{ background: colorFor(p.userId) }} aria-hidden>
            {p.name.slice(0, 1).toUpperCase()}
          </div>
        )}
        {p.muted && (
          <span className="tile-muted" title="Muted">
            🔇
          </span>
        )}
        <button
          className="tile-more"
          aria-label={`Options for ${p.name}`}
          aria-expanded={props.menuOpen}
          onClick={() => props.onMenu(!props.menuOpen)}
        >
          ⋯
        </button>
      </div>
      <div className="tile-label">
        <span>
          {p.name}
          {isSelf && " (you)"}
        </span>
        {ROLE_LABEL[p.role] && <span className="role">{ROLE_LABEL[p.role]}</span>}
      </div>
      {props.menuOpen && (
        <div className="tile-menu" role="menu">
          <button role="menuitem" onClick={act(props.onPin)}>
            {props.pinned ? "Unpin" : "Pin to top"}
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
              <button role="menuitem" onClick={act(() => realm.hostMute(p.id))} disabled={p.muted}>
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
                className="danger"
                onClick={act(() => {
                  if (
                    confirm(`Remove ${p.name} from this gathering? They won't be able to rejoin.`)
                  ) {
                    realm.hostRemove(p.id);
                  }
                })}
              >
                Remove
              </button>
            </>
          )}
          {promote && (
            <button role="menuitem" onClick={act(() => realm.setCoHost(p.id, p.role !== "cohost"))}>
              {p.role === "cohost" ? "Remove co-host" : "Make co-host"}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
