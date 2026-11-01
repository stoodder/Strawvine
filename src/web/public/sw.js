// Strawvine service worker: offline app shell, one cache per build.
//
// - Registered as /sw.js?v=<build id>; a new build means a new worker with its own cache. The
//   page registers the new build's worker in the background as soon as an API response says a
//   newer build is live (see lib/build.ts), so the next launch opens the new version.
// - Install precaches the shell and every built asset listed in /build.json (emitted by the
//   Vite build). Hashed /assets/* files are immutable, so ones an older build already cached
//   (fonts, icons, unchanged chunks) are copied over instead of downloaded again.
// - Navigations get this build's cached shell straight away (no waiting on a weak signal); the
//   shell is never overwritten at runtime, so it always matches the assets cached with it.
//   Without a cached shell (first visit), the network.
// - Activation keeps the previous build's cache (a window still running it can lazy-load its
//   chunks) and deletes older ones. Hashed assets are looked up across both.
// - Only successful same-origin responses are cached. /api/* is never touched: the app keeps
//   its own copy of your data.
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const PREFIX = "strawvine-";
const CACHE = `${PREFIX}${VERSION}`;
const STATIC = ["/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/apple-touch-icon.png"];

const cacheable = (res) => res && res.ok && res.type === "basic";
const isHashedAsset = (path) => path.startsWith("/assets/");

/** A hashed asset from any of this app's caches (same name = same bytes). */
async function fromAnyCache(url) {
  const names = (await caches.keys()).filter((k) => k.startsWith(PREFIX));
  // Our own cache first, then newest to oldest (keys() lists caches in creation order).
  const order = [CACHE, ...names.filter((k) => k !== CACHE).reverse()];
  for (const name of order) {
    const hit = await (await caches.open(name)).match(url, { ignoreSearch: true });
    if (hit) return hit;
  }
  return undefined;
}

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
      if (isHashedAsset(url)) {
        const old = await fromAnyCache(url);
        if (old) return cache.put(url, old);
      }
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
      .then((keys) => {
        const others = keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE);
        const keep = others.at(-1); // the build this one replaces
        return Promise.all(others.filter((k) => k !== keep).map((k) => caches.delete(k)));
      })
      .then(() => self.clients.claim()),
  );
});

async function fromCache(req) {
  const cache = await caches.open(CACHE);
  return cache.match(req, { ignoreSearch: true });
}

/** This build's shell at once; the network only when it isn't cached yet. */
async function navigate(req) {
  const shell = await fromCache("/");
  return shell || fetch(req);
}

/** Cache first; misses go to the network and are kept only if they're a real success. */
async function cacheFirst(req, path) {
  const hit = isHashedAsset(path) ? await fromAnyCache(req) : await fromCache(req);
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
  if (isHashedAsset(url.pathname) || STATIC.includes(url.pathname)) {
    e.respondWith(cacheFirst(req, url.pathname));
  }
});
