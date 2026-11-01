import { motion } from "motion/react";
import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { api } from "../lib/api";
import { Logo } from "../components/Logo";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    <div className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-8">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}>
        <Logo size={40} />
        <h1 className="mt-8 text-4xl font-light tracking-tight">Strawvine</h1>
        <p className="mt-2 text-sm text-mute">A journal for pushing the boundaries.</p>
        <form onSubmit={submit} className="mt-14">
          <label className="label" htmlFor="pw">
            Password
          </label>
          <div className="mt-3 flex items-center gap-3 border-b border-white/10 pb-2 focus-within:border-accent/60">
            <input
              id="pw"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="field flex-1 text-lg"
            />
            <button
              type="submit"
              disabled={!password || busy}
              aria-label="Sign in"
              className="tap grid h-10 w-10 place-items-center rounded-full bg-accent text-accent-ink disabled:opacity-30"
            >
              <ArrowRight size={18} />
            </button>
          </div>
          {error && <p className="mt-3 text-sm text-warn">{error}</p>}
        </form>
      </motion.div>
    </div>
  );
}
