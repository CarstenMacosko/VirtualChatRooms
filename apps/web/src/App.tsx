import { useEffect, useState } from "react";
import type { DevLoginResponse, SessionInfo } from "@vcr/protocol";
import { recipeForSeed } from "@vcr/avatar";
import { AccountSignIn, CLERK_PUBLISHABLE_KEY } from "./components/AccountSignIn";
import { AvatarCreator } from "./components/AvatarCreator";
import { GuestJoin } from "./components/GuestJoin";
import { Home } from "./components/Home";
import { RingOverlay } from "./components/RingOverlay";
import { SessionScreen } from "./components/SessionScreen";
import { SignIn } from "./components/SignIn";
import { api } from "./lib/api";
import { useAuth } from "./lib/auth";
import { useMyAvatar } from "./lib/avatar";
import { useLiveEvents } from "./lib/live";
import { syncPush } from "./lib/push";
import { navigate, type Route, useRoute } from "./lib/router";

export function App() {
  const route = useRoute();
  const auth = useAuth((s) => s.auth);
  // Guest links work without an account.
  if (route.name === "guest") return <GuestJoin token={route.token} />;
  if (!auth) return CLERK_PUBLISHABLE_KEY ? <AccountSignIn /> : <SignIn />;
  // Keyed by person, not token: a renewed session mustn't restart an ongoing gathering.
  return <SignedIn key={auth.user.id} auth={auth} route={route} />;
}

function SignedIn({ auth, route }: { auth: DevLoginResponse; route: Route }) {
  useLiveEvents(auth.token);
  // Keep this browser's push subscription tied to whoever is signed in (this component remounts
  // per sign-in, keyed by token).
  useEffect(() => {
    syncPush().catch(() => {});
  }, []);

  // New accounts go to the avatar creator once, right after signing up.
  const avatar = useMyAvatar();
  const { load } = avatar;
  useEffect(() => {
    if (avatar.status === "idle") void load();
  }, [avatar.status, load]);
  useEffect(() => {
    if (avatar.status !== "ready" || avatar.recipe || route.name !== "home") return;
    const key = `vcr.avatarPrompted.${auth.user.id}`;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, "1");
    } catch {
      return;
    }
    navigate("/avatar");
  }, [avatar.status, avatar.recipe, route.name, auth.user.id]);
  return (
    <>
      {route.name === "session" ? (
        <MemberSession key={route.id} sessionId={route.id} auth={auth} />
      ) : route.name === "avatar" ? (
        avatar.status === "ready" || avatar.status === "error" ? (
          <AvatarCreator
            initial={avatar.recipe ?? recipeForSeed(auth.user.id)}
            title={avatar.recipe ? "Edit your avatar" : "Make your avatar"}
            intro={
              avatar.recipe
                ? undefined
                : "This is how friends and family will see you. Start from a selfie, or pick everything yourself."
            }
            saveLabel="Save avatar"
            secondaryLabel={avatar.recipe ? "Cancel" : "Skip for now"}
            onSecondary={() => navigate("/")}
            onSave={async (recipe) => {
              await avatar.save(recipe);
              navigate("/");
            }}
          />
        ) : (
          <div className="world-loading">Loading your avatar…</div>
        )
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
