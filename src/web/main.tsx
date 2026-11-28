// First: configures zod before anything can parse with it (no eval probe → no CSP violation reports).
import "./lib/zod-setup";
import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { App, applyContrast, CONTRAST_KEY } from "./App";
import { DockProvider } from "./components/Dock";
import { ToastProvider, useToast } from "./components/Toast";
import { startServiceWorker, watchForNewBuild } from "./lib/build";
import { applyFlagParam, flagNotice } from "./lib/features";
import { initSync, queryClient } from "./lib/sync";
import "./styles.css";

// `?flags=rehab` opts this device in to UI not launched yet (`-rehab` opts out; merged into what this device has: see
// lib/features.ts), and leaves the address bar without it. What changed is said in a toast once the app is up
// (`FlagNotice`). Goes at launch, with the flags.
let flagMessage: string | null = null;
try {
  const r = applyFlagParam(window.location.search);
  if (r) {
    flagMessage = flagNotice(r.changed, r.saved);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${r.rest}${window.location.hash}`);
  }
} catch {
  /* storage or history unavailable: the flags stay as they were */
}

/** Says once, in a dock toast, what `?flags=` changed ("Rehab preview on for this device"). */
function FlagNotice() {
  const toast = useToast();
  useEffect(() => {
    if (!flagMessage) return;
    const message = flagMessage;
    flagMessage = null; // once (StrictMode runs effects twice)
    toast.show({ message, tone: message.startsWith("Couldn't") ? "warn" : "default" });
  }, [toast]);
  return null;
}

// High contrast is a per-account setting; until the data loads (and on the sign-in screen) use
// what this device last saw, so an outdoor-mode user never gets a low-contrast flash.
try {
  applyContrast(window.localStorage.getItem(CONTRAST_KEY) === "high");
} catch {
  /* storage unavailable */
}

// Load this device's copy and any unsynced edits first (bounded, never throws), so the first
// render already shows them.
void initSync().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <MotionConfig reducedMotion="user">
          {/* The dock (toasts, sync pill, rest timer) stacks above the nav; toasts render into it. */}
          <DockProvider>
            <ToastProvider>
              <App />
              <FlagNotice />
            </ToastProvider>
          </DockProvider>
        </MotionConfig>
      </QueryClientProvider>
    </StrictMode>,
  );
  watchForNewBuild();
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  // One worker per build: a new build installs a fresh worker with its own precached shell
  // (registered for the newest build the server has reported; see lib/build.ts).
  if (document.readyState === "complete") startServiceWorker();
  else window.addEventListener("load", startServiceWorker);
}
