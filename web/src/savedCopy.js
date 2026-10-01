// The last data each view received from the API, kept on this device so the
// next visit can draw something at once, before the network answers, and so a
// visit with no network at all still shows what was last known.
//
// It lives in the Cache API rather than localStorage: a week of readings is
// over a megabyte of JSON, which is too much to write synchronously on the
// main thread every minute. Every call swallows its own failures - a private
// window, a full disk, a browser without caches - because a missing saved copy
// only costs the instant first paint, never correctness.
//
// Only data that came from the network is ever written. A saved copy read back
// and then saved again would pass itself off as fresh, with a new saved time.

const CACHE = 'plant-saved-data-v1';

// Bumped when the shape of what is saved changes, so an old copy is ignored
// rather than misread.
const VERSION = 1;

const keyUrl = (key) => new URL(`/__saved/${key}`, window.location.origin).href;

export async function readSaved(key) {
    try {
        if (!('caches' in window)) return null;
        const cache = await caches.open(CACHE);
        const res = await cache.match(keyUrl(key));
        if (!res) return null;
        const saved = await res.json();
        return saved?.v === VERSION ? saved : null;
    } catch {
        return null;
    }
}

export async function writeSaved(key, value) {
    try {
        if (!('caches' in window)) return;
        const cache = await caches.open(CACHE);
        const body = JSON.stringify({ v: VERSION, savedAt: new Date().toISOString(), ...value });
        await cache.put(
            keyUrl(key),
            new Response(body, { headers: { 'Content-Type': 'application/json' } }),
        );
    } catch {
        // See above: losing a saved copy is harmless.
    }
}

// When a saved copy was saved, for the error card: "at 14:02" today, with the
// date on any other day.
export function savedAtText(iso) {
    if (!iso) return 'earlier';
    const d = new Date(iso);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === new Date().toDateString()) return `at ${time}`;
    return `on ${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} at ${time}`;
}
