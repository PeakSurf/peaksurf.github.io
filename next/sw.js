/* PeakSurf /next/ service worker.

   Caches
     ps-shell-<APP_VERSION>  app shell, vendored Leaflet, fonts, icons (precached)
     ps-data-v1              forecast data, one copy per file (latest run)
     ps-ocean-v1             Ocean-map frames of the current run (≤ 120 files)

   Strategies
     navigations                   network first → cached page → offline page
     shell assets (same scope)     cache first → network (and cached)
     …/status.json                 network first → cached copy flagged offline
     *.json?v=<generated_at>       cache first for that exact run (immutable) →
                                   network → any cached run, flagged offline
     other *.json / *.geojson      stale-while-revalidate (climatology, land)
     ocean/latest.json             network first → cached copy flagged offline;
                                   a new run id prunes the other runs' frames
     ocean/<run>/*.png             cache first (a run's files never change) →
                                   network; capped at MAX_OCEAN_FILES
     ibi_wave_grid.json            never cached (≈38 MB, classic site only)
     cross-origin (tiles, camera)  not intercepted

   "Flagged offline" = response header `x-ps-offline: 1` (+ `x-ps-gen` with
   the run it came from); data.js turns that into the offline banner.

   Bump APP_VERSION together with <meta name="ps-asset-version"> and the
   ?v= query strings in index.html whenever a shell file changes. */
'use strict';

const APP_VERSION = '20260927e';
const SHELL_CACHE = 'ps-shell-' + APP_VERSION;
const DATA_CACHE = 'ps-data-v1';
const OCEAN_CACHE = 'ps-ocean-v1';
const MAX_SPOT_FILES = 40;
const MAX_OCEAN_FILES = 120;       // ~57 frame pairs + summary ≈ 8 MB
const NAV_TIMEOUT_MS = 6000;

const V = '?v=' + APP_VERSION;
const SHELL = [
    './',
    'index.html',
    'about.html',
    'privacy.html',
    'mentions-legales.html',
    'manifest.webmanifest',
    'app.css' + V,
    'page.css' + V,
    'page.js' + V,
    'i18n.js' + V,
    'util.js' + V,
    'data.js' + V,
    'webcam.js' + V,
    'forecast.js' + V,
    'app.js' + V,
    'maps.js' + V,
    'ocean.js' + V,
    'climato.js' + V,
    'vendor/leaflet/leaflet.js' + V,
    'vendor/leaflet/leaflet.css' + V,
    'vendor/leaflet/images/layers.png',
    'vendor/leaflet/images/layers-2x.png',
    'vendor/leaflet/images/marker-icon.png',
    'vendor/leaflet/images/marker-icon-2x.png',
    'vendor/leaflet/images/marker-shadow.png',
    'fonts/inter-latin-wght-normal.woff2',
    'fonts/outfit-latin-wght-normal.woff2',
    'icons/favicon-32.png',
    'icons/apple-touch-icon.png',
    'icons/icon-192.png',
    'icons/icon-512.png',
    'icons/icon-maskable-512.png',
    'icons/logo-160.png',
    'icons/logo-160.webp',
];

const SCOPE = new URL(self.registration ? self.registration.scope : './', self.location.href);

self.addEventListener('install', event => {
    event.waitUntil((async () => {
        const cache = await caches.open(SHELL_CACHE);
        await cache.addAll(SHELL.map(u => new Request(new URL(u, SCOPE).href, { cache: 'reload' })));
        await self.skipWaiting();
    })());
});

self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const names = await caches.keys();
        await Promise.all(names
            .filter(n => (n.startsWith('ps-shell-') && n !== SHELL_CACHE) || (n.startsWith('ps-data-') && n !== DATA_CACHE)
                || (n.startsWith('ps-ocean-') && n !== OCEAN_CACHE))
            .map(n => caches.delete(n)));
        if (self.registration.navigationPreload) {
            try { await self.registration.navigationPreload.enable(); } catch (e) { /* unsupported */ }
        }
        await self.clients.claim();
    })());
});

/* ---------- helpers ---------- */
function isDataPath(url) { return /\.(json|geojson)$/.test(url.pathname); }
function isGrid(url) { return /ibi_wave_grid\.json$/.test(url.pathname); }
function isStatus(url) { return /\/status\.json$/.test(url.pathname); }
const OCEAN_FRAME_RE = /\/ocean\/(\d{8}T\d{6}Z)\/[\w.-]+\.png$/;
function oceanRun(url) { const m = OCEAN_FRAME_RE.exec(url.pathname); return m ? m[1] : null; }
function isOceanManifest(url) { return /\/ocean\/latest\.json$/.test(url.pathname); }
function withinScope(url) { return url.href.startsWith(SCOPE.href); }

function flagged(res, gen) {
    const headers = new Headers(res.headers);
    headers.set('x-ps-offline', '1');
    if (gen) headers.set('x-ps-gen', gen);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function timeout(ms) { return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)); }

/** Newest cached copy of `url`'s path, whatever its ?v=. */
async function anyVersion(cache, url) {
    const keys = await cache.keys();
    let best = null;
    for (const req of keys) {
        const k = new URL(req.url);
        if (k.origin === url.origin && k.pathname === url.pathname) best = req;  // keys() is insertion-ordered
    }
    return best ? { res: await cache.match(best), gen: new URL(best.url).searchParams.get('v') } : null;
}

/** Store `res` for `url`, dropping other runs of the same file and old spot files. */
async function putData(cache, url, res) {
    const keys = await cache.keys();
    await Promise.all(keys
        .filter(req => { const k = new URL(req.url); return k.pathname === url.pathname && k.href !== url.href; })
        .map(req => cache.delete(req)));
    await cache.put(url.href, res);
    const spots = (await cache.keys()).filter(req => /\/spots\/[^/]+\.json$/.test(new URL(req.url).pathname));
    for (let i = 0; i < spots.length - MAX_SPOT_FILES; i++) await cache.delete(spots[i]);
}

/* ---------- strategies ---------- */
async function navigation(event) {
    const cache = await caches.open(SHELL_CACHE);
    try {
        const res = await Promise.race([
            (async () => (event.preloadResponse && await event.preloadResponse) || fetch(event.request))(),
            timeout(NAV_TIMEOUT_MS),
        ]);
        if (res && res.ok) {
            const url = new URL(event.request.url);
            const key = (url.pathname === SCOPE.pathname || url.pathname.endsWith('/index.html')) ? 'index.html' : url.pathname.split('/').pop();
            if (SHELL.includes(key)) cache.put(new URL(key, SCOPE).href, res.clone());
            if (key === 'index.html') cache.put(SCOPE.href, res.clone());   // './' entry used for /next/?spot=…
        }
        return res;
    } catch (e) {
        const cached = await cache.match(event.request, { ignoreSearch: true })
            || await cache.match(new URL('index.html', SCOPE).href);
        if (cached) return cached;
        return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PeakSurf</title><body style="background:#061121;color:#e2e8f0;font:1rem system-ui;padding:2rem"><p>Hors ligne — PeakSurf n’est pas encore disponible sans connexion sur cet appareil.</p><p>Offline — PeakSurf is not yet available offline on this device.</p>',
            { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
}

async function shellAsset(request) {
    const cache = await caches.open(SHELL_CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
    try {
        const res = await fetch(request);
        if (res.ok && res.type === 'basic') cache.put(request, res.clone());
        return res;
    } catch (e) {
        // Offline and this exact version is not cached: serve any version.
        const any = await cache.match(request, { ignoreSearch: true });
        if (any) return any;
        throw e;
    }
}

async function statusFile(request) {
    const cache = await caches.open(DATA_CACHE);
    const url = new URL(request.url);
    try {
        const res = await fetch(request, { cache: 'no-store' });
        if (res.ok) await cache.put(url.origin + url.pathname, res.clone());
        return res;
    } catch (e) {
        const cached = await cache.match(url.origin + url.pathname);
        if (cached) return flagged(cached);
        throw e;
    }
}

/** Only keep a file under ?v=<run> if it really is that run (guards against
    a CDN edge still serving the previous export during a deploy). */
async function matchesRun(res, url) {
    try {
        const g = JSON.parse(await res.clone().text()).generated_at;
        return !g || g === url.searchParams.get('v');
    } catch (e) {
        return false;
    }
}

async function versionedData(request) {
    const cache = await caches.open(DATA_CACHE);
    const url = new URL(request.url);
    const hit = await cache.match(url.href);
    if (hit) return hit;
    try {
        const res = await fetch(request);
        if (res.ok && await matchesRun(res, url)) await putData(cache, url, res.clone());
        return res;
    } catch (e) {
        const any = await anyVersion(cache, url);
        if (any && any.res) return flagged(any.res, any.gen);
        throw e;
    }
}

/** Drop cached Ocean frames of runs other than `keepRun`, then cap the total. */
async function pruneOcean(cache, keepRun) {
    let keys = await cache.keys();
    if (keepRun) {
        await Promise.all(keys.filter(req => { const r = oceanRun(new URL(req.url)); return r && r !== keepRun; }).map(req => cache.delete(req)));
        keys = await cache.keys();
    }
    const frames = keys.filter(req => oceanRun(new URL(req.url)));
    for (let i = 0; i < frames.length - MAX_OCEAN_FILES; i++) await cache.delete(frames[i]);
}

async function oceanManifest(request) {
    const cache = await caches.open(OCEAN_CACHE);
    const url = new URL(request.url);
    const key = url.origin + url.pathname;
    try {
        const res = await fetch(request, { cache: 'no-store' });
        if (res.ok) {
            let run = null;
            try { run = JSON.parse(await res.clone().text()).run; } catch (e) { run = null; }
            if (run && /^\d{8}T\d{6}Z$/.test(run)) {
                await cache.put(key, res.clone());
                await pruneOcean(cache, run);
            }
        }
        return res;
    } catch (e) {
        const cached = await cache.match(key);
        if (cached) return flagged(cached);
        throw e;
    }
}

async function oceanFrame(request) {
    const cache = await caches.open(OCEAN_CACHE);
    const hit = await cache.match(request.url);
    if (hit) return hit;
    const res = await fetch(request);
    if (res.ok && res.type === 'basic') {
        await cache.put(request.url, res.clone());
        await pruneOcean(cache, null);
    }
    return res;
}

async function unversionedData(request) {
    // e.g. index.json requested without ?v= because status.json was unreachable
    const cache = await caches.open(DATA_CACHE);
    const url = new URL(request.url);
    try {
        const res = await fetch(request);
        return res;
    } catch (e) {
        const any = await anyVersion(cache, url);
        if (any && any.res) return flagged(any.res, any.gen);
        throw e;
    }
}

async function staleWhileRevalidate(event) {
    const cache = await caches.open(DATA_CACHE);
    const cached = await cache.match(event.request);
    const network = fetch(event.request).then(res => {
        if (res.ok) return cache.put(event.request, res.clone()).then(() => res);
        return res;
    });
    if (cached) {
        event.waitUntil(network.catch(() => {}));
        return cached;
    }
    return network;
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;           // tiles, camera streams: browser default

    if (request.mode === 'navigate') {
        if (withinScope(url)) event.respondWith(navigation(event));
        return;
    }
    if (oceanRun(url)) { event.respondWith(oceanFrame(request)); return; }
    if (isOceanManifest(url)) { event.respondWith(oceanManifest(request)); return; }
    if (isDataPath(url)) {
        if (isGrid(url)) return;                                  // too large to cache
        if (isStatus(url)) { event.respondWith(statusFile(request)); return; }
        if (url.searchParams.has('v')) { event.respondWith(versionedData(request)); return; }
        if (/\/index\.json$|\/spots\/[^/]+\.json$/.test(url.pathname)) { event.respondWith(unversionedData(request)); return; }
        event.respondWith(staleWhileRevalidate(event));
        return;
    }
    if (withinScope(url)) event.respondWith(shellAsset(request));
});

/* Page → SW: keep favourite spots available offline. */
self.addEventListener('message', event => {
    const msg = event.data || {};
    if (msg.type !== 'warm' || !Array.isArray(msg.urls)) return;
    event.waitUntil((async () => {
        const cache = await caches.open(DATA_CACHE);
        for (const u of msg.urls.slice(0, 12)) {
            let url;
            try { url = new URL(u, self.location.href); } catch (e) { continue; }
            if (url.origin !== self.location.origin || !isDataPath(url) || !url.searchParams.has('v')) continue;
            if (await cache.match(url.href)) continue;
            try {
                const res = await fetch(url.href);
                if (res.ok && await matchesRun(res, url)) await putData(cache, url, res);
            } catch (e) { /* offline: try next time */ }
        }
    })());
});
