import { useEffect, useState } from "react";
import { createBrowserRouter, Outlet, RouterProvider, ScrollRestoration } from "react-router";
import { api, ApiError } from "./lib/api";
import { clearCache, DataProvider, useBootstrapQuery, useData } from "./lib/store";
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
  if (q.isError) return <Splash message="Couldn't reach Strawvine. Check your connection and reopen the app." />;
  return <Splash />;
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    api("/auth/me")
      .then(() => setAuthed(true))
      .catch((e) => {
        // Offline with cached data: let the app open.
        if (!(e instanceof ApiError) && localStorage.getItem("strawvine:bootstrap")) setAuthed(true);
        else setAuthed(false);
      });
    const onUnauthorized = () => {
      clearCache();
      setAuthed(false);
    };
    window.addEventListener("strawvine:unauthorized", onUnauthorized);
    return () => window.removeEventListener("strawvine:unauthorized", onUnauthorized);
  }, []);

  if (authed === null) return <Splash />;
  if (!authed) return <Login onSuccess={() => setAuthed(true)} />;
  return <Authed />;
}
