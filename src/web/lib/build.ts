/**
 * Build identity. Vite injects `__BUILD_ID__` at build time; the server echoes the id of the
 * build it serves in `x-strawvine-build`, so a long-lived tab can tell it's out of date.
 */
import { showToast } from "../components/Toast";

declare global {
  const __BUILD_ID__: string;
}

export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

let serverBuild: string | null = null;
let announced = false;

function announce() {
  if (announced || !serverBuild || serverBuild === BUILD_ID || BUILD_ID === "dev") return;
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  announced = true;
  showToast({
    message: "New version ready",
    action: { label: "Reload", onAction: () => window.location.reload() },
    duration: 15_000,
  });
}

/** Called with the `x-strawvine-build` header of every API response. */
export function noteServerBuild(id: string | null) {
  if (!id) return;
  serverBuild = id;
  announce();
}

let lastProbe = 0;

/** When the app comes back to the foreground, check (at most every 5 min) whether a deploy happened. */
export function watchForNewBuild() {
  const onVisible = () => {
    if (document.visibilityState !== "visible") return;
    announce();
    if (announced || Date.now() - lastProbe < 5 * 60_000 || !navigator.onLine) return;
    lastProbe = Date.now();
    fetch("/api/auth/me", { credentials: "same-origin", signal: AbortSignal.timeout(8000) })
      .then((res) => noteServerBuild(res.headers.get("x-strawvine-build")))
      .catch(() => {});
  };
  document.addEventListener("visibilitychange", onVisible);
}
