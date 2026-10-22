import type { ParticipantView } from "@vcr/protocol";
import { colorFor } from "./emotes";

/**
 * Right-hand people strip. Phase 2 turns these tiles into the FaceTime-style video sidebar
 * (PLAN.md § 4.6); until then everyone shows as a camera-off tile.
 */
export function PeopleSidebar(props: { participants: ParticipantView[]; selfId: string | null }) {
  const ordered = [...props.participants].sort((a, b) =>
    a.id === props.selfId ? -1 : b.id === props.selfId ? 1 : a.name.localeCompare(b.name),
  );

  return (
    <aside className="sidebar" aria-label="People in this room">
      <h2>
        People <span className="count">{props.participants.length}</span>
      </h2>
      <ul>
        {ordered.map((p) => (
          <li key={p.id} className="tile">
            <div className="tile-face" style={{ background: colorFor(p.userId) }} aria-hidden>
              {p.name.slice(0, 1).toUpperCase()}
            </div>
            <div className="tile-label">
              <span>
                {p.name}
                {p.id === props.selfId && " (you)"}
              </span>
              <span className="role">{p.role}</span>
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
}
