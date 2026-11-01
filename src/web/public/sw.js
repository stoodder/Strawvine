// Strawvine service worker: offline app shell, one cache per build.
//
// - Registered as /sw.js?v=<build id>; a new build means a new worker with its own cache, and
//   older caches are deleted when it activates.
// - Install precaches the shell and every built asset listed in /build.json (emitted by the
//   Vite build), so the app opens offline right after the first visit.
// - Navigations race the network against a short timeout and fall back to this build's
//   shell; the cached shell is only ever this build's (never overwritten at runtime), so it
//   always matches the assets cached next to it.
// - Only successful same-origin responses are cached. /api/* is never touched: the app keeps
//   its own copy of your data.
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = `strawvine-${VERSION}`;
const STATIC = ["/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];
const NAV_TIMEOUT_MS = 2000;

const cacheable = (res) => res && res.ok && res.type === "basic";

async function precache() {
  const cache = await caches.open(CACHE);
  const manifestRes = await fetch("/build.json", { cache: "no-store" });
  if (!cacheable(manifestRes)) throw new Error("build.json unavailable");
  const manifest = await manifestRes.json();
  // A newer deploy landed between the page load and this install: let that build's worker do it.
  if (VERSION !== "dev" && manifest.id !== VERSION) throw new Error("build mismatch");
  const urls = ["/", ...STATIC, ...manifest.assets.map((a) => `/${a}`)];
  await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(new Request(url, { cache: "reload" }));
      if (!cacheable(res)) throw new Error(`precache failed: ${url} (${res.status})`);
      await cache.put(url, res);
    }),
  );
}

self.addEventListener("install", (e) => {
  e.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("strawvine-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function fromCache(req) {
  const cache = await caches.open(CACHE);
  return cache.match(req, { ignoreSearch: true });
}

/** Network first, but don't keep a poor connection waiting: after a moment, use the shell. */
async function navigate(req) {
  const raw = fetch(req);
  const network = raw.then((res) => (res.ok ? res : Promise.reject(new Error(`status ${res.status}`))));
  network.catch(() => {}); // a late failure after the shell was served is fine
  const shell = (await fromCache("/")) || null;
  if (!shell) return raw;
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NAV_TIMEOUT_MS));
  try {
    const res = await Promise.race([network, timeout]);
    return res || shell;
  } catch {
    return shell;
  }
}

/** Cache first; misses go to the network and are kept only if they're a real success. */
async function cacheFirst(req) {
  const hit = await fromCache(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (url.pathname === "/sw.js" || url.pathname === "/build.json") return;

  if (req.mode === "navigate") {
    e.respondWith(navigate(req));
    return;
  }
  if (url.pathname.startsWith("/assets/") || STATIC.includes(url.pathname)) {
    e.respondWith(cacheFirst(req));
  }
});
