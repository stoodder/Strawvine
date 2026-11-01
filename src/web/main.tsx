import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { App } from "./App";
import { ToastProvider } from "./components/Toast";
import { BUILD_ID, watchForNewBuild } from "./lib/build";
import { initSync, queryClient } from "./lib/sync";
import "./styles.css";

// Load this device's copy and any unsynced edits first (bounded, never throws), so the first
// render already shows them.
void initSync().finally(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <MotionConfig reducedMotion="user">
          <ToastProvider>
            <App />
          </ToastProvider>
        </MotionConfig>
      </QueryClientProvider>
    </StrictMode>,
  );
  watchForNewBuild();
});

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  // One worker per build: a new build installs a fresh worker with its own precached shell.
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(BUILD_ID)}`, { updateViaCache: "none" }).catch(() => {});
  });
}
