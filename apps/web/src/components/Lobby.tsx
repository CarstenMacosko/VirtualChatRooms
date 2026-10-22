import { lazy, Suspense, useEffect, useState } from "react";
import { type DevLoginResponse, EmoteId, type HealthResponse } from "@vcr/protocol";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { readDeviceProfile } from "../lib/device";
import { useRealmSession } from "../lib/realm";
import { EMOTE_GLYPHS } from "./emotes";
import { PeopleSidebar } from "./PeopleSidebar";

// Three.js, Spark, Rapier and three-vrm are large; load them only once someone is signed in.
const World = lazy(() => import("../world/World"));
const debug = new URLSearchParams(window.location.search).has("debug");

/** `?session=<id>` picks which shared lobby to join; everyone on the same id sees each other. */
function sessionIdFromUrl(): string {
  const id = new URLSearchParams(window.location.search).get("session");
  return id && /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : "lobby";
}

function useApiHealth() {
  const [health, setHealth] = useState<HealthResponse | null | "down">(null);
  useEffect(() => {
    let active = true;
    const check = () =>
      api
        .health()
        .then((h) => active && setHealth(h))
        .catch(() => active && setHealth("down"));
    void check();
    const timer = setInterval(check, 15_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return health;
}

/** Re-renders periodically so emotes fade out on time. */
function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function Lobby({ auth }: { auth: DevLoginResponse }) {
  const signOut = useAuth((s) => s.signOut);
  const [sessionId] = useState(sessionIdFromUrl);
  const [profile] = useState(readDeviceProfile);
  const realm = useRealmSession(auth.token, sessionId);
  const health = useApiHealth();
  const now = useNow(250);

  const apiOk = health !== null && health !== "down";
  const realmOk = realm.status === "connected";

  return (
    <div className="lobby">
      <header className="topbar">
        <strong>VirtualChatRooms</strong>
        <span className="session">Room: {sessionId}</span>
        <span className={`pill ${apiOk ? "ok" : "bad"}`} title="API server">
          API {apiOk ? `· ${health.database}` : health === null ? "…" : "down"}
        </span>
        <span className={`pill ${realmOk ? "ok" : "bad"}`} title={realm.error ?? "Realm server"}>
          Realm · {realm.status}
        </span>
        <span className="spacer" />
        <span className="muted">{auth.user.displayName}</span>
        <button className="link" onClick={signOut}>
          Sign out
        </button>
      </header>

      <main className="stage">
        <div className="scene">
          <Suspense fallback={<div className="world-loading">Loading room…</div>}>
            <World
              participants={realm.participants}
              selfId={realm.selfId}
              emotes={realm.emotes}
              now={now}
              poseHub={realm.poseHub}
              profile={profile}
              debug={debug}
            />
          </Suspense>
          <div className="emote-bar" role="toolbar" aria-label="Emotes">
            {EmoteId.options.map((id) => (
              <button
                key={id}
                onClick={() => realm.sendEmote(id)}
                disabled={!realmOk}
                aria-label={id}
              >
                {EMOTE_GLYPHS[id]}
              </button>
            ))}
          </div>
          {realm.status === "error" && (
            <p className="error banner" role="alert">
              Couldn't join the room: {realm.error}
            </p>
          )}
        </div>
        <PeopleSidebar participants={realm.participants} selfId={realm.selfId} />
      </main>
    </div>
  );
}
