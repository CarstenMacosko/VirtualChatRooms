import { useEffect, useState } from "react";
import type { DevLoginResponse, SessionInfo } from "@vcr/protocol";
import { recipeForSeed } from "@vcr/avatar";
import { AccountSignIn, CLERK_PUBLISHABLE_KEY } from "./components/AccountSignIn";
import { AvatarCreator } from "./components/AvatarCreator";
import { GuestJoin } from "./components/GuestJoin";
import { Home } from "./components/Home";
import {
  CallMePage,
  DeviceLinkPage,
  finishPendingInvite,
  InvitePage,
} from "./components/LinkPages";
import { RingOverlay } from "./components/RingOverlay";
import { SessionScreen } from "./components/SessionScreen";
import { SignIn } from "./components/SignIn";
import { api } from "./lib/api";
import { useAuth } from "./lib/auth";
import { useMyAvatar } from "./lib/avatar";
import { useLiveEvents } from "./lib/live";
import { syncPush } from "./lib/push";
import { navigate, type Route, useRoute } from "./lib/router";

const signInPage = () => (CLERK_PUBLISHABLE_KEY ? <AccountSignIn /> : <SignIn />);

export function App() {
  const route = useRoute();
  const auth = useAuth((s) => s.auth);
  // Links from other people and devices work with or without an account.
  if (route.name === "guest") return <GuestJoin token={route.token} />;
  if (route.name === "call-me") return <CallMePage token={route.token} />;
  if (route.name === "device-link") return <DeviceLinkPage token={route.token} />;
  if (route.name === "invite" && !auth) {
    return <InvitePage token={route.token} signInPage={signInPage()} />;
  }
  if (!auth) return signInPage();
  // Keyed by person, not token: a renewed session mustn't restart an ongoing call.
  return <SignedIn key={auth.user.id} auth={auth} route={route} />;
}

function SignedIn({ auth, route }: { auth: DevLoginResponse; route: Route }) {
  useLiveEvents(auth.token);
  // Keep this browser's push subscription tied to whoever is signed in.
  useEffect(() => {
    syncPush().catch(() => {});
    // An invite opened before signing in (with a sign-in provider) is accepted now.
    void finishPendingInvite();
  }, []);

  const avatar = useMyAvatar();
  const { load } = avatar;
  useEffect(() => {
    if (avatar.status === "idle") void load();
  }, [avatar.status, load]);

  return (
    <>
      {route.name === "session" ? (
        <MemberSession key={route.id} sessionId={route.id} auth={auth} />
      ) : route.name === "invite" ? (
        <InvitePage token={route.token} signInPage={null} />
      ) : route.name === "avatar" ? (
        avatar.status === "ready" || avatar.status === "error" ? (
          <AvatarCreator
            initial={avatar.recipe ?? recipeForSeed(auth.user.id)}
            title={avatar.recipe ? "Edit your avatar" : "Make your avatar"}
            intro={
              avatar.recipe
                ? undefined
                : "This is how family and friends see you in the 3D room. Start from a selfie, or pick everything yourself."
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
      title={!info ? "Call" : mine ? "Your call" : `${info.host.displayName}'s call`}
      subtitle={info?.room.name}
      displayName={auth.user.displayName}
      isGuest={false}
      onExit={() => navigate("/")}
    />
  );
}
