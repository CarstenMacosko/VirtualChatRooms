import { useEffect, useState } from "react";
import type { DevLoginResponse, SessionInfo } from "@vcr/protocol";
import { GuestJoin } from "./components/GuestJoin";
import { Home } from "./components/Home";
import { RingOverlay } from "./components/RingOverlay";
import { SessionScreen } from "./components/SessionScreen";
import { SignIn } from "./components/SignIn";
import { api } from "./lib/api";
import { useAuth } from "./lib/auth";
import { useLiveEvents } from "./lib/live";
import { syncPush } from "./lib/push";
import { navigate, type Route, useRoute } from "./lib/router";

export function App() {
  const route = useRoute();
  const auth = useAuth((s) => s.auth);
  // Guest links work without an account.
  if (route.name === "guest") return <GuestJoin token={route.token} />;
  if (!auth) return <SignIn />;
  return <SignedIn key={auth.token} auth={auth} route={route} />;
}

function SignedIn({ auth, route }: { auth: DevLoginResponse; route: Route }) {
  useLiveEvents(auth.token);
  // Keep this browser's push subscription tied to whoever is signed in (this component remounts
  // per sign-in, keyed by token).
  useEffect(() => {
    syncPush().catch(() => {});
  }, []);
  return (
    <>
      {route.name === "session" ? (
        <MemberSession key={route.id} sessionId={route.id} auth={auth} />
      ) : (
        <Home auth={auth} />
      )}
      <RingOverlay />
    </>
  );
}

function MemberSession({ sessionId, auth }: { sessionId: string; auth: DevLoginResponse }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  useEffect(() => {
    api.session(sessionId).then(setInfo, () => {});
  }, [sessionId]);
  const mine = info?.host.id === auth.user.id;
  return (
    <SessionScreen
      sessionId={sessionId}
      join={() => api.joinSession(sessionId)}
      title={!info ? "Gathering" : mine ? "Your gathering" : `${info.host.displayName}'s gathering`}
      subtitle={info?.room.name}
      displayName={auth.user.displayName}
      isGuest={false}
      onExit={() => navigate("/")}
    />
  );
}
