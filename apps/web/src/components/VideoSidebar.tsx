import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import { useEffect, useRef, useState } from "react";
import { orderTiles } from "@vcr/engine";
import { canModerate, type ParticipantRole, type ParticipantView } from "@vcr/protocol";
import { useNow } from "../lib/hooks";
import type { RealmSession } from "../lib/realm";
import type { SpatialAudio } from "../media/SpatialAudio";
import type { MediaState } from "../media/useMedia";
import { registerHeadshot } from "../world/headshots";
import { colorFor } from "./emotes";

const ROLE_LABEL: Partial<Record<ParticipantRole, string>> = {
  owner: "Host",
  cohost: "Co-host",
  guest: "Guest",
};

const perfNow = () => performance.now();

/** A live render of someone's avatar face, for when their camera is off. */
export function Headshot({ id, color, name }: { id: string; color: string; name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => registerHeadshot(id, { canvas: ref.current!, color }), [id, color]);
  return (
    <div className="tile-face" style={{ background: color }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
      <canvas ref={ref} width={192} height={192} className="headshot" />
    </div>
  );
}

/**
 * At most this many tiles carry live video; the rest show as compact rows, which keeps download
 * bandwidth bounded at 25 people (PLAN.md § 4.6).
 */
export const MAX_VIDEO_TILES = 8;

export function VideoView({
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

/**
 * FaceTime-style video sidebar (PLAN.md § 4.6): you first, then whoever you pinned, then recent
 * speakers, then the nearest people. Tiles without a camera show the person's initial.
 * Double-clicking someone walks your avatar over to them.
 */
export function VideoSidebar(props: {
  realm: RealmSession;
  media: MediaState;
  audio: SpatialAudio;
  pinned: string | null;
  onPin(id: string | null): void;
  onWalkTo(id: string): void;
  onCollapse(): void;
}) {
  const { realm, media, audio, pinned } = props;
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
        <button className="link collapse" onClick={props.onCollapse} aria-label="Hide people">
          ⟩
        </button>
      </h2>
      <ul>
        {order.map((id, index) => {
          const p = byId.get(id);
          if (!p) return null;
          return (
            <Tile
              key={id}
              p={p}
              isSelf={id === selfId}
              compact={index >= MAX_VIDEO_TILES}
              myRole={me?.role}
              pinned={pinned === id}
              speaking={media.speaking.has(id)}
              video={media.videos.get(id)}
              menuOpen={menuFor === id}
              onMenu={(open) => setMenuFor(open ? id : null)}
              onPin={() => props.onPin(pinned === id ? null : id)}
              onWalkTo={() => props.onWalkTo(id)}
              realm={realm}
              audio={audio}
            />
          );
        })}
      </ul>
      {realm.participants.length > 1 && (
        <p className="hint">Double-click someone to walk over to them.</p>
      )}
    </aside>
  );
}

function Tile(props: {
  p: ParticipantView;
  isSelf: boolean;
  /** Past the video cap: a name row without video. */
  compact: boolean;
  myRole: ParticipantRole | undefined;
  pinned: boolean;
  speaking: boolean;
  video: RemoteVideoTrack | LocalVideoTrack | undefined;
  menuOpen: boolean;
  onMenu(open: boolean): void;
  onPin(): void;
  onWalkTo(): void;
  realm: RealmSession;
  audio: SpatialAudio;
}) {
  const { p, isSelf, myRole, realm, audio } = props;
  const [volume, setVolume] = useState(() => audio.volumeOf(p.id));
  const moderate = !isSelf && myRole !== undefined && canModerate(myRole, p.role);
  const promote = !isSelf && myRole === "owner" && (p.role === "member" || p.role === "cohost");
  const showVideo = !props.compact && props.video && (isSelf || p.cameraOn);
  const act = (fn: () => void) => () => {
    fn();
    props.onMenu(false);
  };

  return (
    <li
      className={`tile${props.speaking ? " speaking" : ""}${props.pinned ? " pinned" : ""}${props.compact ? " compact" : ""}`}
      onDoubleClick={isSelf ? undefined : props.onWalkTo}
      title={isSelf ? undefined : `Double-click to walk over to ${p.name}`}
    >
      <div className="tile-media">
        {/* Others' camera state comes from the realm, so a muted track shows their initial. */}
        {showVideo ? (
          <VideoView track={props.video!} mirror={isSelf} />
        ) : props.compact ? null : (
          <Headshot id={p.id} color={colorFor(p.userId)} name={p.name} />
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
            {props.pinned ? "Unpin" : "Pin (show bigger)"}
          </button>
          {!isSelf && (
            <button role="menuitem" onClick={act(props.onWalkTo)}>
              Walk over
            </button>
          )}
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
    </li>
  );
}
