/**
 * Build identity. Vite injects `__BUILD_ID__` at build time; the server echoes the id of the
 * build it serves in `x-strawvine-build`, so a long-lived tab can tell it's out of date.
 *
 * The service worker serves its own build's shell instantly (no wait on a weak signal), so
 * updates go through the worker: when the server reports a newer build, that build's worker
 * is registered in the background (it precaches the new shell, reusing unchanged assets) and
 * the next launch — or "Reload" on the toast — opens the new version.
 */
import { showToast } from "../components/Toast";

declare global {
  const __BUILD_ID__: string;
}

export const BUILD_ID: string = typeof __BUILD_ID__ === "string" ? __BUILD_ID__ : "dev";

let serverBuild: string | null = null;
let announced = false;
let loaded = false;
let registeredFor: string | null = null;

const workerSupported = () => typeof navigator !== "undefined" && "serviceWorker" in navigator && BUILD_ID !== "dev";

/** Registers the worker of build `id` (the browser swaps workers when the id changes). */
function registerWorker(id: string): Promise<ServiceWorkerRegistration | undefined> {
  if (!workerSupported() || registeredFor === id) return Promise.resolve(undefined);
  registeredFor = id;
  return navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(id)}`, { updateViaCache: "none" }).catch(() => undefined);
}

/** Called once the page has loaded: registers the worker for the newest build we know of. */
export function startServiceWorker() {
  loaded = true;
  void registerWorker(serverBuild ?? BUILD_ID);
}

/** Resolves once build `id`'s worker is active (or after `ms`), so a reload gets its shell. */
async function workerReady(id: string, ms: number): Promise<void> {
  if (!workerSupported()) return;
  const deadline = Date.now() + ms;
  await registerWorker(id);
  while (Date.now() < deadline) {
    const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined);
    if (!reg || reg.active?.scriptURL.includes(`v=${encodeURIComponent(id)}`)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

function announce() {
  if (announced || !serverBuild || serverBuild === BUILD_ID || BUILD_ID === "dev") return;
  if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
  announced = true;
  const target = serverBuild;
  showToast({
    message: "New version ready",
    action: { label: "Reload", onAction: () => void workerReady(target, 8000).finally(() => window.location.reload()) },
    duration: 15_000,
  });
}

/** Called with the `x-strawvine-build` header of every API response. */
export function noteServerBuild(id: string | null) {
  if (!id) return;
  serverBuild = id;
  // Fetch the new build in the background so the next launch opens it.
  if (loaded && id !== BUILD_ID) void registerWorker(id);
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
