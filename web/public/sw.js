// Service worker: caches the app shell only. It never sees mail, tokens or API traffic:
// it answers same-origin GET requests for the listed shell files and ignores everything else.
const CACHE = "cos-shell-v1";
const SHELL = [
  "/", "/index.html", "/styles.css", "/manifest.webmanifest",
  "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png",
  "/js/app.js", "/js/api.js", "/js/auth.js", "/js/config.js", "/js/day.js", "/js/dom.js", "/js/flow.js", "/js/gmail.js",
  "/js/quote.js", "/js/screens.js", "/js/store.js", "/js/swipe.js", "/js/trim.js", "/js/undo.js", "/js/words.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google, Gmail and fonts go straight to the network
  if (url.pathname.startsWith("/api/")) return; // the Worker is never cached
  if (!SHELL.includes(url.pathname)) return;
  // Network first, so a new release shows up on the next open; the cache is the offline fallback.
  event.respondWith(
    fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || (req.mode === "navigate" ? caches.match("/index.html") : Response.error()))),
  );
});
