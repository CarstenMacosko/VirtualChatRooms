import { Lobby } from "./components/Lobby";
import { SignIn } from "./components/SignIn";
import { useAuth } from "./lib/auth";

export function App() {
  const auth = useAuth((s) => s.auth);
  return auth ? <Lobby key={auth.token} auth={auth} /> : <SignIn />;
}
