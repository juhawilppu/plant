// Exists only so Chrome/Android treat this as an installable PWA - a fetch
// handler is one of the install criteria on some browsers. It intentionally
// caches nothing: every request goes straight to the network, unchanged. A
// live dashboard showing stale sensor data because a service worker served
// it from a cache would be a worse bug than not having offline support.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => event.respondWith(fetch(event.request)));
