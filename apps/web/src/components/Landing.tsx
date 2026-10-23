import { Box, Link2, Users, Video } from "lucide-react";
import type { ReactNode } from "react";

/** The signed-out front page: what this is, beside the sign-in card. */
export function Landing({ children }: { children: ReactNode }) {
  return (
    <main className="portal landing">
      <header className="portal-top">
        <span className="brand">
          <span className="brand-mark" aria-hidden>
            <Video size={18} />
          </span>
          VirtualChatRooms
        </span>
      </header>
      <div className="landing-main">
        <section className="landing-hero">
          <h1>Video calls that feel like being in the same room.</h1>
          <p className="muted">
            Call family and friends from any phone or computer. Talk face to face, or hang out
            together as avatars in a 3D copy of your own living room.
          </p>
          <ul className="features">
            <li>
              <span className="feature-icon" aria-hidden>
                <Users size={20} />
              </span>
              <span>
                <b>Your people, one tap away</b>
                <span className="muted">
                  Contacts and groups like "Family", ringing on every device.
                </span>
              </span>
            </li>
            <li>
              <span className="feature-icon" aria-hidden>
                <Link2 size={20} />
              </span>
              <span>
                <b>No account needed to join</b>
                <span className="muted">
                  Guests and kids join with a link; anyone can call your link.
                </span>
              </span>
            </li>
            <li>
              <span className="feature-icon" aria-hidden>
                <Box size={20} />
              </span>
              <span>
                <b>Hang out in your own room</b>
                <span className="muted">Scan a room with your phone, and gather in it.</span>
              </span>
            </li>
          </ul>
        </section>
        <section className="landing-card">{children}</section>
      </div>
    </main>
  );
}
