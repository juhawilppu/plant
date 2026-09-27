// Keeps the app shell - the page, its scripts, styles, photos and icons - on
// the device, so the dashboard opens instantly and opens at all with no
// network. Sensor data is never cached here: /api/ requests go straight to the
// network, untouched. The page keeps its own saved copy of the last data it
// received (src/savedCopy.js) and says so on screen while it shows it, which a
// service worker quietly answering /api/ from a cache could never do.
//
//   the page (/)        cached copy at once, refreshed in the background
//   /assets/*           cache first: the file name changes with the content
//   other static files  cached copy at once, refreshed in the background
//   /api/*              network only
//
// A refreshed page is only stored once every /assets/ file it names is stored
// too, so a new build never lands in the cache without the scripts it needs.
// That also means a new deploy shows up one visit late: the visit after it
// still gets the page the device already had, while the new one downloads.

const SHELL = 'plant-shell-v1';

// Stores the current page and every hashed file it links to, then the page.
async function refreshShell() {
    const res = await fetch('/', { cache: 'no-cache' });
    if (!res.ok) return;
    const html = await res.clone().text();
    const assets = [...new Set(html.match(/\/assets\/[^"'\s)]+/g) ?? [])];
    const cache = await caches.open(SHELL);
    await cache.addAll(assets);
    await cache.put('/', res);
}

self.addEventListener('install', (event) => {
    // A failed precache is not a failed install: the shell then fills in as
    // the page is used, and the worker still updates.
    event.waitUntil(refreshShell().catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            // Only this worker's own old shells; the page's saved data lives in
            // a cache of its own and is left alone.
            const names = await caches.keys();
            await Promise.all(
                names
                    .filter((n) => n.startsWith('plant-shell-') && n !== SHELL)
                    .map((n) => caches.delete(n)),
            );
            await self.clients.claim();
        })(),
    );
});

// The cached copy if there is one, with a fresh one fetched behind it; the
// network if there is not.
async function staleWhileRevalidate(event, key) {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(key);
    const refresh = fetch(event.request).then((res) => {
        if (res.ok) cache.put(key, res.clone());
        return res;
    });
    if (cached) {
        event.waitUntil(refresh.catch(() => {}));
        return cached;
    }
    return refresh;
}

async function cacheFirst(request) {
    const cache = await caches.open(SHELL);
    const cached = await cache.match(request);
    if (cached) return cached;
    const res = await fetch(request);
    if (res.ok) cache.put(request, res.clone());
    return res;
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    // Anything not handled here falls through to the browser, as if there were
    // no service worker: other origins, writes, and all of /api/.
    if (request.method !== 'GET' || url.origin !== self.location.origin) return;
    if (url.pathname.startsWith('/api/')) return;

    if (request.mode === 'navigate') {
        if (url.pathname !== '/' && url.pathname !== '/index.html') return;
        event.respondWith(
            (async () => {
                const cache = await caches.open(SHELL);
                const cached = await cache.match('/');
                if (cached) {
                    event.waitUntil(refreshShell().catch(() => {}));
                    return cached;
                }
                const res = await fetch(request);
                if (res.ok) event.waitUntil(refreshShell().catch(() => {}));
                return res;
            })(),
        );
        return;
    }

    if (url.pathname.startsWith('/assets/')) {
        event.respondWith(cacheFirst(request));
        return;
    }

    event.respondWith(staleWhileRevalidate(event, request));
});
