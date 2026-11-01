import { lazy, Suspense, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { onlineManager } from "@tanstack/react-query";
import { createBrowserRouter, Outlet, RouterProvider, ScrollRestoration } from "react-router";
import { DataProvider, useBootstrapQuery, useData } from "./lib/store";
import { probeSession } from "./lib/api";
import {
  getSyncInfo,
  getSyncState,
  isSignedIn,
  onSignedOut,
  resumeAfterLogin,
  SIGNED_IN_EVENT,
  SIGNED_OUT_EVENT,
  subscribeSync,
  syncNow,
} from "./lib/sync";
import { SyncStatus } from "./components/SyncStatus";
import { BottomNav } from "./components/BottomNav";
import { Celebrations } from "./components/Celebrations";
import { Logo } from "./components/Logo";
import { displayPrefs } from "../shared/defaults";
import { Login } from "./screens/Login";
import { TodayScreen } from "./screens/Today";
import { TrainScreen } from "./screens/Train";

// Today and Train are the daily screens and ship in the main bundle; the rest load on demand
// (the service worker precaches every chunk, so they open offline too).
const loadOnboarding = () => import("./screens/Onboarding");
const loadProgress = () => import("./screens/Progress");
const loadGoals = () => import("./screens/Goals");
const loadSettings = () => import("./screens/Settings");
const Onboarding = lazy(() => loadOnboarding().then((m) => ({ default: m.Onboarding })));
const ProgressScreen = lazy(() => loadProgress().then((m) => ({ default: m.ProgressScreen })));
const GoalsScreen = lazy(() => loadGoals().then((m) => ({ default: m.GoalsScreen })));
const SettingsScreen = lazy(() => loadSettings().then((m) => ({ default: m.SettingsScreen })));

/** Warm the lazy screens once the app is idle, so the first tap on a tab doesn't wait. */
function usePrefetchScreens() {
  useEffect(() => {
    const run = () => void Promise.all([loadProgress(), loadGoals(), loadSettings()]).catch(() => {});
    if ("requestIdleCallback" in window) {
      const id = window.requestIdleCallback(run, { timeout: 4000 });
      return () => window.cancelIdleCallback(id);
    }
    const t = setTimeout(run, 1500);
    return () => clearTimeout(t);
  }, []);
}

/** A calm placeholder while a screen's chunk loads: nothing at first, then a softly pulsing mark. */
function ScreenFallback({ fullscreen }: { fullscreen?: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 400);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className={fullscreen ? "grid min-h-dvh place-items-center" : "grid min-h-[60dvh] place-items-center"} aria-busy="true">
      {show && <Logo size={28} className="animate-pulse opacity-60" />}
    </div>
  );
}

/** Mirrors Settings → Display onto <html> (data-contrast="high"), and remembers it for the sign-in screen. */
export const CONTRAST_KEY = "strawvine:contrast";
function useContrastMode(high: boolean) {
  useEffect(() => {
    applyContrast(high);
    try {
      window.localStorage.setItem(CONTRAST_KEY, high ? "high" : "normal");
    } catch {
      /* storage unavailable: the sign-in screen just uses normal contrast */
    }
  }, [high]);
}
export function applyContrast(high: boolean) {
  if (high) document.documentElement.dataset.contrast = "high";
  else delete document.documentElement.dataset.contrast;
}

function Lazy({ children, fullscreen }: { children: ReactNode; fullscreen?: boolean }) {
  return <Suspense fallback={<ScreenFallback fullscreen={fullscreen} />}>{children}</Suspense>;
}

function Shell() {
  const { data } = useData();
  useContrastMode(displayPrefs(data.settings).highContrast);
  usePrefetchScreens();
  if (!data.settings.onboarded)
    return (
      <Lazy fullscreen>
        <Onboarding />
      </Lazy>
    );
  return (
    <>
      <main className="pt-safe pb-nav mx-auto w-full max-w-lg px-5">
        <Lazy>
          <Outlet />
        </Lazy>
      </main>
      <SyncStatus />
      <BottomNav />
      <Celebrations />
      <ScrollRestoration />
    </>
  );
}

const router = createBrowserRouter([
  {
    element: <Shell />,
    children: [
      { path: "/", element: <TodayScreen /> },
      { path: "/day/:date", element: <TodayScreen /> },
      { path: "/train", element: <TrainScreen /> },
      { path: "/train/:date", element: <TrainScreen /> },
      { path: "/progress", element: <ProgressScreen /> },
      { path: "/goals", element: <GoalsScreen /> },
      { path: "/settings", element: <SettingsScreen /> },
      { path: "*", element: <TodayScreen /> },
    ],
  },
]);

function Splash({ message }: { message?: string }) {
  return (
    <div className="grid min-h-dvh place-items-center">
      <div className="flex flex-col items-center gap-4">
        <Logo size={44} className="animate-pulse" />
        {message && <p className="max-w-xs text-center text-sm text-mute">{message}</p>}
      </div>
    </div>
  );
}

/**
 * No data and no way to get it right now (offline, or the server unreachable): say so calmly,
 * with what's waiting on this device, instead of an endless splash.
 */
function OfflineState({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
  const info = useSyncExternalStore(subscribeSync, getSyncInfo, getSyncInfo);
  return (
    <div className="grid min-h-dvh place-items-center px-6">
      <div className="flex max-w-xs flex-col items-center gap-4 text-center" role="status">
        <Logo size={44} />
        <p className="text-base text-fg">{info.online ? "Couldn't reach Strawvine" : "You're offline"}</p>
        <p className="text-sm text-mute">
          This device doesn't have a copy of your journal yet. It will load as soon as there's a connection.
          {info.unsynced > 0 && ` ${info.unsynced} unsynced ${info.unsynced === 1 ? "change is" : "changes are"} safe on this device.`}
        </p>
        <button type="button" className="btn-ghost min-h-11" disabled={busy} onClick={onRetry}>
          {busy ? "Trying…" : "Try again"}
        </button>
      </div>
    </div>
  );
}

function Authed() {
  const q = useBootstrapQuery(true);
  const sync = useSyncExternalStore(subscribeSync, getSyncState, getSyncState);
  const [retrying, setRetrying] = useState(false);
  if (q.data) {
    return (
      <DataProvider data={q.data}>
        <RouterProvider router={router} />
      </DataProvider>
    );
  }
  // Waiting on this device's copy (slow storage) or the first attempt: the splash.
  const stuck = q.isError || q.fetchStatus === "paused" || q.failureCount > 0 || (!sync.online && q.fetchStatus !== "fetching");
  if (stuck && !sync.restoring) {
    return (
      <OfflineState
        busy={retrying}
        onRetry={() => {
          setRetrying(true);
          // navigator.onLine is often wrong on a weak signal: just try.
          onlineManager.setOnline(true);
          void Promise.all([q.refetch(), syncNow()]).finally(() => {
            setRetrying(false);
            onlineManager.setOnline(navigator.onLine);
          });
        }}
      />
    );
  }
  return <Splash />;
}

/**
 * No blocking auth check: a signed-in device renders straight from its copy (if any) while the
 * bootstrap request doubles as the auth check; a definite 401 shows the sign-in screen, and
 * unsynced edits survive it (they resume after sign-in). A device that isn't signed in (signed
 * out, or never) never shows cached data: it starts at sign-in, skipping it only if the browser
 * still holds a valid session.
 */
export function App() {
  const [authed, setAuthed] = useState(isSignedIn);

  useEffect(() => {
    const onUnauthorized = () => {
      setAuthed(false);
      onSignedOut();
    };
    const out = () => setAuthed(false);
    const back = () => setAuthed(true);
    window.addEventListener("strawvine:unauthorized", onUnauthorized);
    window.addEventListener(SIGNED_OUT_EVENT, out);
    window.addEventListener(SIGNED_IN_EVENT, back);
    return () => {
      window.removeEventListener("strawvine:unauthorized", onUnauthorized);
      window.removeEventListener(SIGNED_OUT_EVENT, out);
      window.removeEventListener(SIGNED_IN_EVENT, back);
    };
  }, []);

  // Not flagged as signed in at start-up, but the session cookie may still be good.
  useEffect(() => {
    if (authed) return;
    let live = true;
    void probeSession().then((ok) => {
      if (!ok || !live) return;
      resumeAfterLogin();
      setAuthed(true);
    });
    return () => {
      live = false;
    };
    // Once per load: after an explicit sign-out the cookie is gone anyway.
  }, []);

  if (!authed)
    return (
      <Login
        onSuccess={() => {
          resumeAfterLogin();
          setAuthed(true);
        }}
      />
    );
  return <Authed />;
}
