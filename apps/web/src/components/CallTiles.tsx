import type { LocalVideoTrack, RemoteVideoTrack } from "livekit-client";
import { Hand, MicOff, Pin, PinOff } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { orderTiles } from "@vcr/engine";
import type { ParticipantView } from "@vcr/protocol";
import { useNow } from "../lib/hooks";
import type { ActiveEmote } from "../lib/realm";
import type { SpatialAudio } from "../media/SpatialAudio";
import type { MediaState } from "../media/useMedia";
import { registerHeadshot } from "../world/headshots";
import { colorFor, EMOTE_DURATION_MS, EMOTE_GLYPHS } from "./emotes";
import { Avatar } from "./ui";

type Track = RemoteVideoTrack | LocalVideoTrack;

/** Plays a LiveKit video track; LiveKit's adaptive stream picks the quality for its size. */
export function VideoView({
  track,
  mirror,
  fit = "cover",
}: {
  track: Track;
  mirror: boolean;
  fit?: "cover" | "contain";
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
  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      className={`${mirror ? "mirror " : ""}fit-${fit}`}
    />
  );
}

/** A live render of someone's avatar face (room view only, where the 3D scene exists). */
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

export interface TileProps {
  p: ParticipantView;
  isSelf: boolean;
  video: Track | undefined;
  speaking: boolean;
  pinned: boolean;
  emote: ActiveEmote | undefined;
  now: number;
  /** Room view renders avatar headshots; the grid shows initials. */
  headshots: boolean;
  onPin?(): void;
  /** Smaller text and controls (filmstrip, picture-in-picture). */
  small?: boolean;
}

export function Tile(props: TileProps) {
  const { p, isSelf } = props;
  const showVideo = props.video && (isSelf || p.cameraOn);
  const emote =
    props.emote && props.now - props.emote.at < EMOTE_DURATION_MS ? props.emote : undefined;
  return (
    <div
      className={`tile${props.speaking ? " speaking" : ""}${props.small ? " small" : ""}`}
      data-name={p.name}
    >
      {showVideo ? (
        <VideoView track={props.video!} mirror={isSelf} />
      ) : props.headshots ? (
        <Headshot id={p.id} color={colorFor(p.userId)} name={p.name} />
      ) : (
        <div className="tile-avatar">
          <Avatar name={p.name} id={p.userId} size={props.small ? 48 : 96} />
        </div>
      )}
      {emote && (
        <span className="tile-emote" key={emote.at} aria-hidden>
          {EMOTE_GLYPHS[emote.emote]}
        </span>
      )}
      {p.handRaised && (
        <span className="tile-hand" title="Hand raised">
          <Hand size={16} />
        </span>
      )}
      <div className="tile-name">
        {p.muted && <MicOff size={14} aria-label="Muted" />}
        <span>
          {p.name}
          {isSelf && " (you)"}
        </span>
      </div>
      {props.onPin && (
        <button
          className="tile-pin"
          onClick={props.onPin}
          aria-label={props.pinned ? `Unpin ${p.name}` : `Pin ${p.name}`}
          title={props.pinned ? "Unpin" : "Pin"}
        >
          {props.pinned ? <PinOff size={16} /> : <Pin size={16} />}
        </button>
      )}
    </div>
  );
}

/** Someone being rung who hasn't joined yet. */
function RingingTile({ name, id }: { name: string; id: string }) {
  return (
    <div className="tile ringing">
      <div className="tile-avatar">
        <Avatar name={name} id={id} size={96} />
      </div>
      <div className="tile-name">
        <span>Calling {name}…</span>
      </div>
    </div>
  );
}

/**
 * Columns and tile size that make `n` tiles of `aspect` as big as possible in a `w` × `h` box,
 * the way Meet and Zoom lay out their gallery.
 */
export function fitGrid(n: number, w: number, h: number, aspect: number, gap = 8) {
  let best = { cols: 1, width: 0, height: 0 };
  for (let cols = 1; cols <= Math.max(1, n); cols++) {
    const rows = Math.ceil(n / cols);
    const width = Math.min((w - gap * (cols - 1)) / cols, ((h - gap * (rows - 1)) / rows) * aspect);
    if (width > best.width) best = { cols, width, height: width / aspect };
  }
  return best;
}

function useSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry!.contentRect;
      setSize({ width: box.width, height: box.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** Live video in at most this many tiles; past that, people still show (without video). */
export const MAX_VIDEO_TILES = 16;

const perfNow = () => performance.now();

export interface StageProps {
  participants: ParticipantView[];
  selfId: string;
  media: MediaState;
  emotes: Record<string, ActiveEmote>;
  pinned: string | null;
  onPin(id: string | null): void;
  /** People being rung who haven't joined. */
  ringing: Array<{ userId: string; displayName: string }>;
}

/**
 * The video call stage: a 1:1 call fills the screen with the other person and floats you in a
 * corner (FaceTime, Duo); more people get an even gallery (Meet, Zoom); a shared screen or a
 * pinned person takes the stage with everyone else in a strip beside it.
 */
export function VideoStage(props: StageProps) {
  const { participants, selfId, media, emotes } = props;
  const now = useNow(500);
  const [ref, size] = useSize<HTMLDivElement>();
  const spokeNow = useNow(1000, perfNow);
  const self = participants.find((p) => p.id === selfId);
  const others = participants.filter((p) => p.id !== selfId);
  const screen = [...media.screens.entries()][0];
  const featuredId =
    props.pinned && participants.some((p) => p.id === props.pinned) ? props.pinned : null;

  const tile = (p: ParticipantView, extra: Partial<TileProps> = {}) => (
    <Tile
      key={p.id}
      p={p}
      isSelf={p.id === selfId}
      video={media.videos.get(p.id)}
      speaking={media.speaking.has(p.id)}
      pinned={props.pinned === p.id}
      emote={emotes[p.id]}
      now={now}
      headshots={false}
      onPin={() => props.onPin(props.pinned === p.id ? null : p.id)}
      {...extra}
    />
  );

  // A shared screen or a pinned person: big on the stage, everyone else in a strip.
  if (screen || featuredId) {
    const order = orderTiles({
      selfId,
      ids: participants.map((p) => p.id),
      pinnedId: null,
      lastSpokeAt: media.lastSpokeAt,
      distance: new Map(),
      now: spokeNow,
    }).filter((id) => id !== featuredId);
    const byId = new Map(participants.map((p) => [p.id, p]));
    const sharer = screen ? byId.get(screen[0]) : undefined;
    return (
      <div className="stage presenting" ref={ref}>
        <div className="stage-main">
          {screen ? (
            <div className="tile screen">
              <VideoView track={screen[1]} mirror={false} fit="contain" />
              <div className="tile-name">
                <span>
                  {screen[0] === selfId
                    ? "You are presenting"
                    : `${sharer?.name ?? "Someone"} is presenting`}
                </span>
              </div>
            </div>
          ) : (
            tile(byId.get(featuredId!)!)
          )}
        </div>
        <div className="stage-strip">
          {order.slice(0, 8).map((id) => {
            const p = byId.get(id);
            return p ? tile(p, { small: true }) : null;
          })}
        </div>
      </div>
    );
  }

  // One other person: they fill the stage, you float in the corner.
  if (others.length === 1 && self && !props.ringing.length) {
    return (
      <div className="stage one-to-one" ref={ref}>
        {tile(others[0]!)}
        <div className="pip">{tile(self, { small: true, onPin: undefined })}</div>
      </div>
    );
  }

  // Gallery: everyone (and anyone still being rung), as big as fits.
  const ordered = [...others, ...(self ? [self] : [])];
  const count = ordered.length + props.ringing.length;
  const portrait = size.width > 0 && size.width / Math.max(1, size.height) < 0.8;
  const fit = fitGrid(count, size.width, size.height, portrait ? 3 / 4 : 16 / 9);
  return (
    <div className="stage gallery" ref={ref}>
      <div
        className="gallery-grid"
        style={{ gridTemplateColumns: `repeat(${fit.cols}, ${Math.floor(fit.width)}px)` }}
      >
        {ordered.map((p, i) =>
          tile(p, {
            video: i < MAX_VIDEO_TILES ? media.videos.get(p.id) : undefined,
            small: fit.width < 260,
          }),
        )}
        {props.ringing.map((r) => (
          <RingingTile key={r.userId} name={r.displayName} id={r.userId} />
        ))}
      </div>
      {count === 1 && (
        <p className="stage-hint">Waiting for others to join. Invite people from the bar below.</p>
      )}
    </div>
  );
}

/**
 * Room view: the 3D room fills the screen and video tiles run down the side, speakers first.
 * Tiles past the first few drop their video to keep bandwidth bounded (PLAN.md § 4.6).
 */
export function Filmstrip(props: {
  participants: ParticipantView[];
  selfId: string;
  media: MediaState;
  audio: SpatialAudio;
  emotes: Record<string, ActiveEmote>;
  pinned: string | null;
  onPin(id: string | null): void;
  onWalkTo(id: string): void;
}) {
  const { media, audio } = props;
  const now = useNow(500);
  const spokeNow = useNow(1000, perfNow);
  const [lx, , lz] = audio.listener.position;
  const distance = new Map<string, number>();
  for (const [id, at] of audio.positions) distance.set(id, Math.hypot(at[0] - lx, at[2] - lz));
  const order = orderTiles({
    selfId: props.selfId,
    ids: props.participants.map((p) => p.id),
    pinnedId: props.pinned,
    lastSpokeAt: media.lastSpokeAt,
    distance,
    now: spokeNow,
  });
  const byId = new Map(props.participants.map((p) => [p.id, p]));
  return (
    <aside className="filmstrip" aria-label="People">
      {order.slice(0, 6).map((id) => {
        const p = byId.get(id);
        if (!p) return null;
        return (
          <div
            key={id}
            onDoubleClick={id === props.selfId ? undefined : () => props.onWalkTo(id)}
            title={id === props.selfId ? undefined : `Double-click to walk over to ${p.name}`}
          >
            <Tile
              p={p}
              isSelf={id === props.selfId}
              video={media.videos.get(id)}
              speaking={media.speaking.has(id)}
              pinned={props.pinned === id}
              emote={props.emotes[id]}
              now={now}
              headshots
              small
              onPin={() => props.onPin(props.pinned === id ? null : id)}
            />
          </div>
        );
      })}
      {order.length > 6 && <p className="filmstrip-more">+{order.length - 6} more</p>}
    </aside>
  );
}
