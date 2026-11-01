import { motion } from "motion/react";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { api } from "../lib/api";
import { Logo } from "../components/Logo";
import { useTitle } from "../components/useTitle";

export function Login({ onSuccess }: { onSuccess: () => void }) {
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
