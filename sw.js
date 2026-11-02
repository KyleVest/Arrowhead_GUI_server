/*
 * ArrowHead offline cache.
 *
 * Without this the page is only as available as the cell signal. It lives on
 * GitHub Pages, so a phone that restarts, or a browser that swaps the tab out
 * of memory, cannot get it back without service - which in the field means no
 * app for the rest of the day. Caching the page itself is the whole point.
 *
 * Two different strategies, because the two kinds of content want opposite
 * things:
 *
 *   The page   - network FIRST, cache as fallback. A cache-first page would
 *                mean pushing a fix to GitHub and watching the phone keep
 *                running yesterday's code, which has already cost us an
 *                afternoon once. Online always means current.
 *
 *   Map tiles  - cache FIRST. A tile for a given z/x/y never changes, so
 *                re-fetching one is pure waste. This is also what makes a
 *                hunting area panned over at the lodge still draw out in the
 *                field with no bars.
 *
 * Note the opaque-response handling. Tiles are loaded through new Image(),
 * which makes them no-cors requests, so what comes back has status 0 and
 * ok === false even when it is a perfectly good tile. Testing only `ok`
 * would silently cache nothing at all.
 */

const PAGE_CACHE = 'arrowhead-page-v1';
const TILE_CACHE = 'arrowhead-tiles-v1';
const MAX_TILES  = 800;        // ~ a few hundred km2 at hunting zoom levels
const NET_TIMEOUT_MS = 3000;   // marginal signal must not hang the page open

self.addEventListener('install', function () {
  self.skipWaiting();          // a new worker takes over without a second reload
});

self.addEventListener('activate', function (e) {
  e.waitUntil((async function () {
    const names = await caches.keys();
    await Promise.all(names.map(function (n) {
      return (n === PAGE_CACHE || n === TILE_CACHE) ? null : caches.delete(n);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (e) {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (err) { return; }

  if (url.hostname === 'tile.openstreetmap.org' ||
      url.hostname === 'server.arcgisonline.com') {
    e.respondWith(cacheFirst(req));
    return;
  }
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req));
  }
  // Anything else is left alone - the worker should never be in the way of
  // something it was not asked to handle.
});

/*
 * ignoreSearch matters here: the page gets opened as ?v=2, ?v=3 and so on to
 * push past GitHub's caching. Without it, a cached copy of the page would
 * fail to match the very next version-bumped URL and offline would break at
 * exactly the moment it was needed.
 */
async function networkFirst(req) {
  const cache = await caches.open(PAGE_CACHE);
  const cached = cache.match(req, { ignoreSearch: true });
  try {
    const fresh = await withTimeout(fetch(req), NET_TIMEOUT_MS);
    if (fresh && (fresh.ok || fresh.type === 'opaque')) {
      cache.put(req, fresh.clone());
    }
    return fresh;
  } catch (err) {
    const hit = await cached;
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;

  const fresh = await fetch(req);
  if (fresh && (fresh.ok || fresh.type === 'opaque')) {
    cache.put(req, fresh.clone());
    trim(cache);
  }
  return fresh;
}

// Oldest-first eviction. Unbounded tile caching on a phone is how an app ends
// up quietly holding a gigabyte nobody asked it to hold.
let trimming = false;
async function trim(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    const over = keys.length - MAX_TILES;
    for (let i = 0; i < over; i++) await cache.delete(keys[i]);
  } catch (err) {
    /* eviction is housekeeping - never let it break a fetch */
  } finally {
    trimming = false;
  }
}

function withTimeout(p, ms) {
  return new Promise(function (resolve, reject) {
    const t = setTimeout(function () { reject(new Error('timeout')); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); },
           function (e) { clearTimeout(t); reject(e); });
  });
}
