import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CLERK_PUBLISHABLE_KEY, ClerkBridge } from "./components/AccountSignIn";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UpdateBanner } from "./components/UpdateBanner";
import "./styles.css";
import "./ui.css";

// Development: `vcrExportRoomModels()` in the console re-exports the built-in rooms' models.
if (import.meta.env.DEV) void import("./world/exportRoomModels");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {CLERK_PUBLISHABLE_KEY ? (
        // Real accounts. Without a key the app falls back to the development sign-in.
        <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} afterSignOutUrl="/">
          <ClerkBridge />
          <App />
        </ClerkProvider>
      ) : (
        <App />
      )}
      <UpdateBanner />
    </ErrorBoundary>
  </StrictMode>,
);
