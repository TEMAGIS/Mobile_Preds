// Preds Mobile — offline map-tile cache service worker
// ════════════════════════════════════════════════════════════════
// Caches the Hybrid (aerial imagery + boundary/road reference overlays)
// basemap tiles — this is now the app's default basemap, per the field
// team's preference for aerial imagery. Streets (CARTO) tiles are no
// longer cached; if someone toggles back to Streets while offline, those
// tiles won't be available (same as it worked before any caching existed).
// See app-notes.md "Map tile caching" for the full history of this design.
//
// The Hybrid basemap is actually 3 stacked Esri tile layers (imagery +
// place/boundary labels + road labels) — ALL THREE have to be cached for
// a cached area to render correctly offline, not just the base imagery.
// Keep ARCGIS_TILE_PATH_PREFIXES below in sync with BASEMAPS.hybrid.layers
// in index.html if that ever changes.
//
// Two things feed this cache through the exact same code path below:
//   1. Ordinary panning/zooming while online — the fetch handler here just
//      intercepts those tile requests as they happen.
//   2. A background "warm this mission's counties" prefetch that index.html
//      kicks off after a mission loads (see warmCountyFallbackCache there) —
//      those are plain fetch() calls to the same tile URLs, so they land in
//      this same cache exactly like real map traffic would.
//
// Storage accounting note: tile responses from a cross-origin CDN can come
// back "opaque" (status/headers/body unreadable by JS) unless that CDN opts
// in to CORS — that's a browser privacy protection, not a bug here. When we
// can read a real Content-Length we use it for the storage budget; when we
// can't (opaque response), we fall back to AVG_TILE_BYTES as an estimate so
// eviction still has *some* budget to work against. That makes the ~200MB
// target approximate rather than exact in the opaque case. Imagery tiles are
// meaningfully heavier than the old Streets vector tiles, and every map
// square now costs 3 tile fetches instead of 1, so the same ~200MB budget
// now covers noticeably less ground than it did under Streets-only caching.
//
// Eviction: once total (estimated) bytes exceed MAX_CACHE_BYTES, the
// least-recently-cached tiles are deleted first until back under
// EVICT_TO_BYTES, tracked via a small IndexedDB store keyed by tile URL.

const TILE_CACHE = 'pda-tiles-v2'; // bumped from v1 (Streets) since the cached basemap changed
const META_DB = 'pda-tile-meta-v2';
const META_STORE = 'meta';
const MAX_CACHE_BYTES = 200 * 1024 * 1024; // ~200MB (middle of the agreed 150-250MB range)
const EVICT_TO_BYTES = Math.floor(MAX_CACHE_BYTES * 0.85);
const AVG_TILE_BYTES = 20 * 1024; // estimate used only when a response is opaque (imagery-weighted)

const ARCGIS_HOST = 'server.arcgisonline.com';
const ARCGIS_TILE_PATH_PREFIXES = [
  '/ArcGIS/rest/services/World_Imagery/MapServer/tile/',
  '/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/',
  '/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/',
];

function isCacheableTile(url) {
  try {
    const u = new URL(url);
    return u.hostname === ARCGIS_HOST && ARCGIS_TILE_PATH_PREFIXES.some(p => u.pathname.startsWith(p));
  } catch (e) {
    return false;
  }
}

self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop any caches from a previous version (e.g. the old Streets-only
    // "pda-tiles-v1" bucket) so stale, never-served-again tiles don't just
    // sit around consuming storage forever.
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== TILE_CACHE && n.startsWith('pda-tiles-')).map(n => caches.delete(n)));
    try { indexedDB.deleteDatabase('pda-tile-meta'); } catch (e) {}
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !isCacheableTile(req.url)) return; // let the browser handle everything else as usual
  event.respondWith(handleTileFetch(req));
});

async function handleTileFetch(request) {
  const cache = await caches.open(TILE_CACHE);
  try {
    const netResp = await fetch(request);
    if (netResp && (netResp.ok || netResp.type === 'opaque')) {
      cacheTile(cache, request, netResp.clone()); // fire-and-forget, don't hold up the tile
      return netResp;
    }
    const cached = await cache.match(request);
    return cached || netResp;
  } catch (err) {
    // Offline, or the request otherwise failed outright — serve from cache if we have it.
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}

async function cacheTile(cache, request, response) {
  try {
    await cache.put(request, response.clone());
    const size = estimateSize(response);
    await recordTile(request.url, size);
    await maybeEvict(cache);
  } catch (e) {
    // Non-fatal — worst case this one tile isn't tracked/cached this time.
  }
}

function estimateSize(response) {
  const cl = response.headers && response.headers.get ? response.headers.get('content-length') : null;
  if (cl) {
    const n = parseInt(cl, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return AVG_TILE_BYTES; // opaque response — can't read a real size
}

// --- Tiny IndexedDB-backed metadata store: url -> {size, ts} ---
function openMetaDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(META_DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(META_STORE, { keyPath: 'url' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function recordTile(url, size) {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put({ url, size, ts: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function allMeta() {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function deleteMeta(urls) {
  const db = await openMetaDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    const store = tx.objectStore(META_STORE);
    urls.forEach(u => store.delete(u));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function maybeEvict(cache) {
  const entries = await allMeta();
  const total = entries.reduce((sum, e) => sum + (e.size || AVG_TILE_BYTES), 0);
  if (total <= MAX_CACHE_BYTES) return;
  entries.sort((a, b) => a.ts - b.ts); // oldest first
  let running = total;
  const toDelete = [];
  for (const e of entries) {
    if (running <= EVICT_TO_BYTES) break;
    toDelete.push(e.url);
    running -= (e.size || AVG_TILE_BYTES);
  }
  if (!toDelete.length) return;
  await Promise.all(toDelete.map(u => cache.delete(u)));
  await deleteMeta(toDelete);
}