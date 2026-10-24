import {
  type CharacterController,
  type InputSystem,
  type Intents,
  type InterpolatedPose,
  pickSeat,
  type RoomLayout,
  seatFloorPoint,
  type Vec3,
} from "@vcr/engine";
import { LocoState, type Seat } from "@vcr/protocol";

/**
 * Sitting in the web client (ADR 0020): offers the seat in front of you, claims it through the
 * realm before sitting down, gets you up again when you move or press E, and places other people
 * on the seats they claimed.
 */

/** What World needs from the realm connection to sit (see useRealmSession). */
export interface SeatingLink {
  /** Seat claims: seat id (as a string) → realm session id. */
  claims: Record<string, string>;
  selfId: string | null;
  /** Claims a seat: true if it's yours, false if someone's there, null if the realm didn't answer. */
  sit(seatId: number): Promise<boolean | null>;
  stand(): void;
}

/** The on-screen prompt: sit on the seat in front of you, get up, or why you couldn't sit. */
export type SeatPrompt =
  { kind: "sit"; seatId: number } | { kind: "stand" } | { kind: "refused"; message: string } | null;

export const promptKey = (p: SeatPrompt) =>
  !p ? "" : p.kind === "sit" ? `sit:${p.seatId}` : p.kind === "refused" ? `x:${p.message}` : "up";

const REFUSED_MS = 2000;
const RECHECK_MS = 1000;

/** Per-frame sitting logic for your own avatar. */
export class LocalSeating {
  private pending: number | null = null;
  private refused: { message: string; until: number } | null = null;
  /** The seat the realm gave you, until you get up. */
  private claimed: number | null = null;
  private checkedAt = 0;

  constructor(
    private readonly character: CharacterController,
    private readonly layout: RoomLayout,
  ) {}

  /**
   * Call once per frame before stepping the character. Returns the prompt to show; `input` learns
   * whether E should interact.
   */
  update(now: number, intents: Intents, input: InputSystem, link: SeatingLink | undefined) {
    const c = this.character;
    const seat = c.seat;
    const taken = new Set<number>();
    for (const [id, holder] of Object.entries(link?.claims ?? {})) {
      if (holder !== link?.selfId) taken.add(Number(id));
    }

    if (seat && seat.phase !== "rise") {
      const moving = Math.hypot(intents.move.x, intents.move.y) > 0.3 || intents.jump;
      // Someone else has the seat (the realm restarted and they got there first): get up.
      const lost = link?.selfId && taken.has(seat.seat.id);
      if (intents.interact || moving || lost) {
        c.standUp();
        this.release(link);
      } else if (link?.selfId && now - this.checkedAt > RECHECK_MS) {
        // After a realm reconnect your claim is gone; take the seat back while it's free.
        this.checkedAt = now;
        if (link.claims[String(seat.seat.id)] !== link.selfId) void link.sit(seat.seat.id);
      }
    } else if (!seat && this.claimed !== null) {
      this.release(link); // left the seat some other way (fell out of the world, teleported)
    }

    let prompt: SeatPrompt = null;
    if (c.seat) {
      prompt = c.seat.phase === "rise" ? null : { kind: "stand" };
    } else {
      const candidate = pickSeat(this.layout.seats, c.current.position, c.current.yaw, taken);
      if (candidate && intents.interact && this.pending === null) this.claim(candidate, link);
      if (candidate) prompt = { kind: "sit", seatId: candidate.id };
    }
    if (this.refused && now < this.refused.until) {
      prompt = { kind: "refused", message: this.refused.message };
    }
    input.interactAvailable = prompt?.kind === "sit" || prompt?.kind === "stand";
    return prompt;
  }

  private claim(seat: Seat, link: SeatingLink | undefined) {
    // Without a realm (offline sample room) there's nobody to share seats with.
    if (!link) {
      this.character.sitDown(seat);
      return;
    }
    this.pending = seat.id;
    void link.sit(seat.id).then((ok) => {
      this.pending = null;
      if (ok) {
        this.claimed = seat.id;
        this.character.sitDown(seat);
      } else {
        this.refused = {
          message: ok === false ? "Someone's sitting there" : "Couldn't sit down just now",
          until: performance.now() + REFUSED_MS,
        };
      }
    });
  }

  private release(link: SeatingLink | undefined) {
    this.claimed = null;
    link?.stand();
  }
}

/**
 * Where to draw someone else: on the seat they claimed (from your own copy of the layout, so pose
 * jitter can't shift them off it), else where their pose says.
 */
export function remoteSeat(pose: InterpolatedPose, layout: RoomLayout): Seat | null {
  if (pose.seatId === undefined) return null;
  return layout.seats.find((s) => s.id === pose.seatId) ?? null;
}

export function remotePlacement(
  pose: InterpolatedPose,
  seat: Seat | null,
): { position: Vec3; yaw: number } {
  if (seat && pose.loco === LocoState.seated) {
    return { position: seatFloorPoint(seat), yaw: seat.yaw };
  }
  return { position: pose.position, yaw: pose.yaw };
}

/** "E Sit" on desktop, a big "Sit" button on touch; tapping or clicking it works on both. */
export function SeatPromptView(props: { prompt: SeatPrompt; touch: boolean; input: InputSystem }) {
  const { prompt, touch, input } = props;
  if (!prompt) return null;
  if (prompt.kind === "refused") {
    return (
      <div className="seat-prompt refused" role="status">
        {prompt.message}
      </div>
    );
  }
  const label = prompt.kind === "sit" ? "Sit" : "Stand up";
  return (
    <button
      className={`seat-prompt${touch ? " touch" : ""}`}
      onPointerDown={(e) => {
        e.stopPropagation();
        input.queueInteract();
      }}
    >
      {!touch && <kbd>E</kbd>} {label}
    </button>
  );
}
