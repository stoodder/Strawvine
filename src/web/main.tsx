// First: configures zod before anything can parse with it (no eval probe → no CSP violation reports).
import "./lib/zod-setup";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { App, applyContrast, CONTRAST_KEY } from "./App";
import { DockProvider } from "./components/Dock";
import { ToastProvider } from "./components/Toast";
import { startServiceWorker, watchForNewBuild } from "./lib/build";
import { applyFlagParam } from "./lib/features";
import { initSync, queryClient } from "./lib/sync";
import "./styles.css";

// `?flags=trainDay,rehab` opts this device in to UI not launched yet (`?flags=` opts out; see
// lib/features.ts), and leaves the address bar without it.
try {
  const rest = applyFlagParam(window.location.search);
  if (rest !== null) window.history.replaceState(window.history.state, "", `${window.location.pathname}${rest}${window.location.hash}`);
} catch {
  /* storage or history unavailable: the flags stay as they were */
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
