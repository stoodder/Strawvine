import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api } from "../lib/api";
import { Logo } from "../components/Logo";
import { useTitle } from "../components/useTitle";

const OFFLINE_KEY = "sv-signed-out-offline";
const OFFLINE_EVENT = "strawvine:signed-out-offline";

/**
 * Settings calls this when a sign-out couldn't reach the server (the device is signed out; the
 * server side finishes on the next contact). The sign-in screen is usually already showing by
 * then, so it hears the event; a sign-in screen mounted later reads the session flag.
 */
export function noteOfflineSignOut() {
  try {
    sessionStorage.setItem(OFFLINE_KEY, "1");
  } catch {
    /* storage blocked: the event below still reaches a mounted sign-in screen */
  }
  window.dispatchEvent(new Event(OFFLINE_EVENT));
}

function offlineSignOut(): boolean {
  try {
    return sessionStorage.getItem(OFFLINE_KEY) === "1";
  } catch {
    return false;
  }
}

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [offlineNotice, setOfflineNotice] = useState(offlineSignOut);
  useEffect(() => {
    const on = () => setOfflineNotice(true);
    window.addEventListener(OFFLINE_EVENT, on);
    return () => window.removeEventListener(OFFLINE_EVENT, on);
  }, []);
  useEffect(() => {
    // Said once: a later visit to the sign-in screen shouldn't repeat it.
    if (!offlineNotice) return;
    try {
      sessionStorage.removeItem(OFFLINE_KEY);
    } catch {
      /* ignore */
    }
  }, [offlineNotice]);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useTitle("Sign in");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/auth/login", { method: "POST", body: { password } });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-8">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
        <Logo size={40} />
        <h1 className="mt-8 text-4xl font-light tracking-tight">Strawvine</h1>
        <p className="mt-2 text-sm text-mute">A journal for pushing the boundaries.</p>
        {/* Always present, so the notice is announced when it arrives after the screen. */}
        <p role="status" className={offlineNotice ? "mt-6 text-sm leading-relaxed text-fg-2" : "sr-only"}>
          {offlineNotice ? "Signed out on this device. We'll finish signing out on the server when you're back online." : ""}
        </p>
        <form onSubmit={submit} className="mt-14">
          <label className="label" htmlFor="pw">
            Password
          </label>
          <div
            className={`mt-3 flex items-center gap-3 border-b pb-2 transition-colors ${
              error ? "border-warn/60" : "border-white/15 focus-within:border-accent/70"
            }`}
          >
            <input
              id="pw"
              type="password"
              autoFocus
              autoComplete="current-password"
              aria-invalid={!!error || undefined}
              aria-describedby={error ? "pw-error" : undefined}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error) setError(null);
              }}
              className="field field-plain flex-1 text-lg"
            />
            <button
              type="submit"
              disabled={!password || busy}
              aria-label="Sign in"
              className="tap grid h-11 w-11 place-items-center rounded-full bg-accent text-accent-ink disabled:bg-white/[0.06] disabled:text-mute"
            >
              <ArrowRight size={18} />
            </button>
          </div>
          <p id="pw-error" role="alert" className="mt-3 min-h-5 text-sm text-warn">
            {error}
          </p>
        </form>
      </motion.div>
    </main>
  );
}
