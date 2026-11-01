import { useEffect, useState } from "react";
import { createBrowserRouter, Outlet, RouterProvider, ScrollRestoration } from "react-router";
import { DataProvider, useBootstrapQuery, useData } from "./lib/store";
import { onSignedOut, resumeAfterLogin } from "./lib/sync";
import { SyncStatus } from "./components/SyncStatus";
import { BottomNav } from "./components/BottomNav";
import { Celebrations } from "./components/Celebrations";
import { Logo } from "./components/Logo";
import { Login } from "./screens/Login";
import { Onboarding } from "./screens/Onboarding";
import { TodayScreen } from "./screens/Today";
import { TrainScreen } from "./screens/Train";
import { ProgressScreen } from "./screens/Progress";
import { GoalsScreen } from "./screens/Goals";
import { SettingsScreen } from "./screens/Settings";

function Shell() {
  const { data } = useData();
  if (!data.settings.onboarded) return <Onboarding />;
  return (
    <>
      <main className="pt-safe pb-nav mx-auto w-full max-w-lg px-5">
        <Outlet />
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

function Authed() {
  const q = useBootstrapQuery(true);
  if (q.data) {
    return (
      <DataProvider data={q.data}>
        <RouterProvider router={router} />
      </DataProvider>
    );
  }
  if (q.isError)
    return (
      <div className="grid min-h-dvh place-items-center">
        <div className="flex flex-col items-center gap-4">
          <Logo size={44} />
          <p className="max-w-xs text-center text-sm text-mute">Couldn't reach Strawvine. Check your connection.</p>
          <button type="button" className="btn-ghost" onClick={() => void q.refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  return <Splash />;
}

/**
 * No blocking auth check: the app renders straight from this device's copy (if any) while the
 * bootstrap request doubles as the auth check. Only a definite 401 shows the sign-in screen,
 * and unsynced edits survive it (they resume after sign-in).
 */
export function App() {
  const [authed, setAuthed] = useState(true);

  useEffect(() => {
    const onUnauthorized = () => {
      setAuthed(false);
      onSignedOut();
    };
    window.addEventListener("strawvine:unauthorized", onUnauthorized);
    return () => window.removeEventListener("strawvine:unauthorized", onUnauthorized);
  }, []);

  if (!authed)
    return (
      <Login
        onSuccess={() => {
          setAuthed(true);
          resumeAfterLogin();
        }}
      />
    );
  return <Authed />;
}
