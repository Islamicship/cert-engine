/**
 * sw.js - Service Worker for "Certification Engine".
 *
 * @description
 * Goal: the certificate must open, be edited and be printed with ZERO connectivity.
 * (Typed data lives in localStorage and photos in IndexedDB - both already offline;
 * this worker only has to make the app SHELL available offline.)
 *
 * STRATEGY (and why)
 *   1. Static assets (fonts, images, icons)  -> CACHE-FIRST.
 *      They are large, change rarely and are the slowest part of a cold start.
 *   2. Code + shell (HTML, CSS, JS, manifest) -> NETWORK-FIRST with a short timeout,
 *      falling back to the cache. Online users therefore always get the newest
 *      markup + scripts TOGETHER (important: index.html field order and
 *      STORE_VERSION in script.js must always match), and the maintainer does not
 *      need to remember a cache-version bump after every code change.
 *   3. Navigations that are neither network- nor cache-available fall back to the
 *      cached index.html (app-shell pattern).
 *   4. Anything else same-origin and GET -> network-first (dynamic resources).
 *   5. Never handled: non-GET, non-http(s) (data:, blob:, chrome-extension:), cross-origin.
 *
 * INSTALL
 *   CORE files must all cache or the install fails (a half-cached shell would
 *   be worse than none). OPTIONAL files (fonts, images, icons) are cached one by
 *   one with errors swallowed: e.g. the licensed DIN font may legitimately be absent.
 *
 * UPDATE LIFECYCLE
 *   A new worker installs in the background and WAITS. js/pwa.js shows a
 *   "new version" toast; on click it posts {type:'SKIP_WAITING'}, the worker
 *   activates, claims clients and the page reloads once. No silent mid-edit reload.
 *
 * WHEN TO BUMP CACHE_VERSION
 *   Only when a STATIC asset changes under the same file name (a replaced font or
 *   logo), or when you add/remove files from the lists below.
 */

const CACHE_VERSION = 'v3';
const CACHE_PREFIX = 'cert-engine-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

/** Max time to wait for the network before using the cached copy (ms). */
const NETWORK_TIMEOUT_MS = 3500;

/** All paths are resolved against the worker scope, so GitHub Pages sub-paths work. */
const SCOPE = self.registration.scope;
const toUrl = (p) => new URL(p, SCOPE).href;

/** Must-have files: install fails if any is missing. */
const CORE = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './css/theme.css',
  './css/viewport.css',
  './css/menu-tools.css',
  './js/theme.js',
  './js/viewport.js',
  './js/menu-tools.js',
  './js/export-tools.js',
  './js/pwa.js',
  './manifest.webmanifest'
].map(toUrl);

/** Nice-to-have files: cached individually, failures ignored. */
const OPTIONAL = [
  // images + icons
  './assets/logo.png',
  './assets/url.png',
  './assets/twitter.png',
  './assets/facebook.png',
  './assets/background.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  // fonts referenced by @font-face in style.css
  './fonts/cairo-arabic-600-normal.woff2',
  './fonts/cairo-latin-600-normal.woff2',
  './fonts/cairo-arabic-700-normal.woff2',
  './fonts/cairo-latin-700-normal.woff2',
  './fonts/inter-latin-500-normal.woff2',
  './fonts/inter-latin-600-normal.woff2',
  './fonts/inter-latin-700-normal.woff2',
  './fonts/barlow-semi-condensed-latin-700-normal.woff2',
  // licensed / optional fonts (usually only some of these exist)
  './fonts/DINNextLTArabic-Bold.woff2',
  './fonts/DINNextLTArabic-Bold.ttf',
  './fonts/DINNextLTArabic-Bold.otf',
  './fonts/Helvetica-Regular.woff2',
  './fonts/Helvetica-Regular.ttf',
  './fonts/Helvetica-Regular.otf',
  './fonts/Arial-Regular.woff2',
  './fonts/Arial-Regular.ttf',
  './fonts/Arial-Regular.otf'
].map(toUrl);

/** Offline fallback for navigations. */
const SHELL_URL = toUrl('./index.html');

/** File types served cache-first. */
const STATIC_RE = /\.(?:woff2?|ttf|otf|png|jpe?g|webp|gif|svg|ico)$/i;


/* ---------------------------------------------------------------- install */

/**
 * @description Fetches a URL bypassing the HTTP cache and stores it. Used so a fresh
 * install never captures a stale copy that the browser cache was still holding.
 * @param {Cache} cache target cache
 * @param {string} url absolute URL
 * @returns {Promise<void>} rejects if the response is not a 200
 */
async function precache(cache, url) {
  const res = await fetch(new Request(url, { cache: 'reload' }));
  if (!res.ok) throw new Error(url + ' -> ' + res.status);
  await cache.put(url, res);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(CORE.map((u) => precache(cache, u)));            // all-or-nothing
    await Promise.allSettled(OPTIONAL.map((u) => precache(cache, u))); // best effort
    // No skipWaiting() here on purpose: see UPDATE LIFECYCLE above.
  })());
});


/* --------------------------------------------------------------- activate */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.indexOf(CACHE_PREFIX) === 0 && n !== CACHE_NAME)
        .map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});


/* ------------------------------------------------------------------ fetch */

/**
 * @description fetch() that gives up after `ms`.
 * @param {Request} request
 * @param {number} ms
 * @returns {Promise<Response>}
 */
function fetchWithTimeout(request, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    fetch(request).then(
      (res) => { clearTimeout(timer); resolve(res); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * @description True when a response is safe to store: a complete, same-origin, non-redirected 200.
 * (Redirected responses cannot be replayed for navigations; 206 partials would corrupt the cache.)
 * @param {Response} res
 * @returns {boolean}
 */
function cacheable(res) {
  return !!res && res.status === 200 && res.type === 'basic' && !res.redirected;
}

/**
 * @description CACHE-FIRST: cached copy wins; otherwise network, then store.
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
async function cacheFirst(event) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(event.request, { ignoreSearch: true });
  if (hit) return hit;
  try {
    const res = await fetch(event.request);
    if (cacheable(res)) event.waitUntil(cache.put(event.request, res.clone()));
    return res;
  } catch (_) {
    return Response.error();
  }
}

/**
 * @description NETWORK-FIRST: fresh copy when online (stored for offline), cached copy
 * when the network fails or is slower than NETWORK_TIMEOUT_MS. The timeout only applies
 * when a cached copy exists; with an empty cache we wait for the network.
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
async function networkFirst(event) {
  const request = event.request;
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });

  try {
    const res = cached
      ? await fetchWithTimeout(request, NETWORK_TIMEOUT_MS)
      : await fetch(request);
    if (cacheable(res)) event.waitUntil(cache.put(request, res.clone()));
    return res;
  } catch (_) {
    if (cached) return cached;
    if (request.mode === 'navigate') {
      const shell = await cache.match(SHELL_URL);
      if (shell) return shell;
    }
    return new Response('Offline and not cached.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;   // data:, blob:, extensions
  if (url.origin !== self.location.origin) return;                      // never touch third parties
  if (request.headers.has('range')) return;                             // partial content: let the browser do it

  event.respondWith(STATIC_RE.test(url.pathname) ? cacheFirst(event) : networkFirst(event));
});
